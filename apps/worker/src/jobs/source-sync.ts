/**
 * `source_sync`: runs the connector sync for one source against the real
 * repositories, then generates balanced draft postings for every booked bank
 * transaction the run touched. The connector already writes raw records and
 * normalized bank rows idempotently; the draft phase is idempotent per bank
 * transaction and runs in one database transaction.
 *
 * Only Enable Banking sources are wired today. Other syncable kinds (email,
 * FinTS, portfolio) plug in through {@link SourceSyncGateway} as their
 * connectors land.
 */

import { enableBanking } from "@sona/connectors";
import type { JsonValue, SourceKind, WorkspaceContext } from "@sona/core";
import type { DbClient } from "@sona/db";
import {
  bankTransactionId,
  createWorkspaceBankRecordStore,
  createWorkspaceSyncRunStore,
  type NormalizedTransaction,
  RECORD_TYPES,
  type SqliteBankRecordRepository,
  type SqliteEvidenceLinkRepository,
  type SqliteLedgerRepository,
  type SqliteRawRecordRepository,
  type SqliteReviewQueueRepository,
  type SqliteSourceRepository,
  type SqliteSyncRunRepository,
  type SyncRunStore,
  withTransactionAsync,
} from "@sona/db";
import {
  bankAccountPath,
  DRAFT_POSTING_STATES,
  type DraftPostingState,
  ensureDraftPosting,
} from "./draft-postings.js";
import { redactText } from "./redact.js";
import { type JobHandler, NonRetryableJobError } from "./runner.js";

/** Source kinds the sync job can process. */
export const SYNCABLE_SOURCE_KINDS = ["enable_banking"] as const satisfies readonly SourceKind[];

export type SyncableSourceKind = (typeof SYNCABLE_SOURCE_KINDS)[number];

export function isSyncableSourceKind(kind: SourceKind): kind is SyncableSourceKind {
  return (SYNCABLE_SOURCE_KINDS as readonly string[]).includes(kind);
}

export interface EnableBankingSession {
  client: enableBanking.EnableBankingClient;
  sessionId: string;
}

/**
 * Resolves the provider client and consent for a source. Implementations read
 * the source's credential reference and the secret store; the job never sees
 * raw credentials beyond what the connector client needs.
 */
export interface SourceSyncGateway {
  resolveEnableBanking(context: WorkspaceContext, sourceId: string): Promise<EnableBankingSession>;
}

export interface SourceSyncDependencies {
  db: DbClient;
  sources: SqliteSourceRepository;
  syncRuns: SqliteSyncRunRepository;
  rawRecords: SqliteRawRecordRepository;
  bankRecords: SqliteBankRecordRepository;
  ledger: SqliteLedgerRepository;
  evidenceLinks: SqliteEvidenceLinkRepository;
  reviewQueue: SqliteReviewQueueRepository;
  gateway: SourceSyncGateway;
  ids: () => string;
}

export interface SourceSyncResult {
  syncRunId: string;
  syncStatus: enableBanking.SyncStatus;
  accountsSynced: number;
  transactionsSynced: number;
  drafts: Record<DraftPostingState, number>;
  /** Ledger transaction ids the run created or superseded. */
  draftTransactionIds: string[];
  /** Per-account provider failures, redacted. */
  errors: Array<{ accountUid: string; message: string }>;
}

/** Provider error messages are redacted before they reach the sync run table. */
function redactingSyncRunStore(store: SyncRunStore): SyncRunStore {
  return {
    start: (run) => store.start(run),
    recordError: (error) => store.recordError({ ...error, message: redactText(error.message) }),
    finish: (run) =>
      store.finish({
        ...run,
        summary: {
          ...run.summary,
          errors: run.summary.errors.map((error) => ({
            ...error,
            message: redactText(error.message),
          })),
        },
      }),
  };
}

interface CapturedTransaction {
  transaction: NormalizedTransaction;
  rawRecordId: string;
}

export interface RunSourceSyncInput {
  context: WorkspaceContext;
  sourceId: string;
  now: string;
  transactionQuery?: enableBanking.RunEnableBankingSyncInput["transactionQuery"];
}

export async function runSourceSync(
  deps: SourceSyncDependencies,
  input: RunSourceSyncInput,
): Promise<SourceSyncResult> {
  const { context, sourceId } = input;
  const { workspaceId } = context;

  const source = await deps.sources.getById(workspaceId, sourceId);
  if (source === undefined) {
    throw new NonRetryableJobError(`source ${sourceId} not found in workspace`);
  }
  if (!isSyncableSourceKind(source.kind)) {
    throw new NonRetryableJobError(`source kind ${source.kind} cannot be synced by this worker`);
  }
  if (source.status !== "active") {
    throw new NonRetryableJobError(`source ${sourceId} is ${source.status}, not active`);
  }

  const { client, sessionId } = await deps.gateway.resolveEnableBanking(context, sourceId);

  // Capture what this run wrote so the draft phase covers exactly those rows.
  const captured = new Map<string, CapturedTransaction>();
  const bankStore = createWorkspaceBankRecordStore(deps.bankRecords, workspaceId);
  const capturingStore: enableBanking.BankRecordStore = {
    saveAccount: (account, link) => bankStore.saveAccount(account, link),
    saveBalance: (balance, link) => bankStore.saveBalance(balance, link),
    saveTransaction: async (transaction, link) => {
      await bankStore.saveTransaction(transaction, link);
      captured.set(`${transaction.accountExternalId}:${transaction.externalId}`, {
        transaction,
        rawRecordId: link.rawRecordId,
      });
    },
  };

  const summary = await enableBanking.runEnableBankingSync({
    workspaceId,
    sourceId,
    sessionId,
    client,
    runStore: redactingSyncRunStore(createWorkspaceSyncRunStore(deps.syncRuns, workspaceId)),
    rawStore: {
      append: async (record) => {
        await deps.rawRecords.append(record);
      },
    },
    bankStore: capturingStore,
    env: { ids: deps.ids, nowIso: () => input.now },
    transactionQuery: input.transactionQuery,
  });

  const drafts = Object.fromEntries(DRAFT_POSTING_STATES.map((state) => [state, 0])) as Record<
    DraftPostingState,
    number
  >;
  const draftTransactionIds: string[] = [];
  await withTransactionAsync(deps.db, async () => {
    await deps.ledger.ensureDefaultAccounts(workspaceId, {
      createdAt: input.now,
      accountIdFor: () => deps.ids(),
    });
    for (const { transaction, rawRecordId } of captured.values()) {
      const result = await ensureDraftPosting(deps, {
        context,
        bankAccountPath: bankAccountPath(sourceId, transaction.accountExternalId),
        transaction: {
          ...transaction,
          bankTransactionId: bankTransactionId(
            sourceId,
            transaction.accountExternalId,
            transaction.externalId,
          ),
          rawRecordId,
        },
        now: input.now,
      });
      drafts[result.state] += 1;
      if (result.state === "created" || result.state === "superseded") {
        draftTransactionIds.push(result.transaction.id);
      }
    }
  });

  return {
    syncRunId: summary.runId,
    syncStatus: summary.errors.length > 0 ? "completed_with_errors" : "succeeded",
    accountsSynced: summary.accountsSynced,
    transactionsSynced: summary.transactionsSynced,
    drafts,
    draftTransactionIds,
    errors: summary.errors,
  };
}

export function createSourceSyncHandler(deps: SourceSyncDependencies): JobHandler<"source_sync"> {
  return async ({ job, context, now, produced }) => {
    const result = await runSourceSync(deps, {
      context,
      sourceId: job.payload.sourceId,
      now,
      transactionQuery: job.payload.transactionQuery,
    });
    const { draftTransactionIds, errors, ...summary } = result;
    produced({ type: RECORD_TYPES.sourceSyncRun, id: summary.syncRunId });
    for (const id of draftTransactionIds) {
      produced({ type: RECORD_TYPES.ledgerTransaction, id });
    }
    return {
      ...summary,
      errors: errors.map((error) => ({
        accountUid: error.accountUid,
        message: redactText(error.message),
      })),
    } satisfies JsonValue;
  };
}
