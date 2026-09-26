/**
 * `source_sync`: runs the connector sync for one source against the real
 * repositories and hands what arrived to the next stage.
 *
 * - Enable Banking: raw records and normalized bank rows are written by the
 *   connector idempotently; every booked transaction the run touched then gets
 *   a balanced draft posting (one database transaction), and documents still
 *   waiting for a payment are re-queued for reconciliation.
 * - Email: the connector stores attachments as documents through
 *   `DocumentStorage`; every document the run stored is queued for extraction.
 *
 * Credentials are resolved through {@link SourceSyncGateway}; the job never
 * sees more than the connector client needs.
 */

import { email, enableBanking } from "@sona/connectors";
import type { DocumentStorage, JsonValue, SourceKind, WorkspaceContext } from "@sona/core";
import type { DbClient } from "@sona/db";
import {
  bankTransactionId,
  createWorkspaceBankRecordStore,
  createWorkspaceEmailSyncRunStore,
  createWorkspaceSyncRunStore,
  type NormalizedTransaction,
  RECORD_TYPES,
  type SqliteBankRecordRepository,
  type SqliteDocumentRepository,
  type SqliteEmailSyncRunRepository,
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

/** Source kinds the sync job can process; the scheduler enqueues syncs for these. */
export const SYNCABLE_SOURCE_KINDS = [
  "enable_banking",
  "email",
] as const satisfies readonly SourceKind[];

export type SyncableSourceKind = (typeof SYNCABLE_SOURCE_KINDS)[number];

export function isSyncableSourceKind(kind: SourceKind): kind is SyncableSourceKind {
  return (SYNCABLE_SOURCE_KINDS as readonly string[]).includes(kind);
}

export interface EnableBankingSession {
  client: enableBanking.EnableBankingClient;
  sessionId: string;
}

export interface EmailSession {
  client: email.ImapClient;
  policy?: email.EmailSourcePolicy;
}

/**
 * Resolves the provider client and consent for a source. Implementations read
 * the source's credential reference and the secret store; the job never sees
 * raw credentials beyond what the connector client needs.
 */
export interface SourceSyncGateway {
  resolveEnableBanking(context: WorkspaceContext, sourceId: string): Promise<EnableBankingSession>;
  resolveEmail(context: WorkspaceContext, sourceId: string): Promise<EmailSession>;
}

export interface SourceSyncDependencies {
  db: DbClient;
  sources: SqliteSourceRepository;
  syncRuns: SqliteSyncRunRepository;
  emailSyncRuns: SqliteEmailSyncRunRepository;
  rawRecords: SqliteRawRecordRepository;
  bankRecords: SqliteBankRecordRepository;
  documents: SqliteDocumentRepository;
  storage: DocumentStorage;
  ledger: SqliteLedgerRepository;
  evidenceLinks: SqliteEvidenceLinkRepository;
  reviewQueue: SqliteReviewQueueRepository;
  gateway: SourceSyncGateway;
  ids: () => string;
}

export type SyncError = {
  /** Provider-side scope of the failure (account uid, mailbox folder, message uid). */
  scope: string;
  /** Redacted message. */
  message: string;
};

export interface BankSourceSyncResult {
  kind: "enable_banking";
  syncRunId: string;
  syncStatus: enableBanking.SyncStatus;
  accountsSynced: number;
  transactionsSynced: number;
  drafts: Record<DraftPostingState, number>;
  /** Ledger transaction ids the run created or superseded. */
  draftTransactionIds: string[];
  errors: SyncError[];
}

export interface EmailSourceSyncResult {
  kind: "email";
  syncRunId: string;
  syncStatus: email.EmailSyncStatus;
  messagesSeen: number;
  messagesIngested: number;
  attachmentsStored: number;
  attachmentsDeduplicated: number;
  /** Documents this run stored for the first time. */
  documentIds: string[];
  errors: SyncError[];
}

export type SourceSyncResult = BankSourceSyncResult | EmailSourceSyncResult;

export interface RunSourceSyncInput {
  context: WorkspaceContext;
  sourceId: string;
  now: string;
  transactionQuery?: enableBanking.RunEnableBankingSyncInput["transactionQuery"];
}

function rawRecordStore(rawRecords: SqliteRawRecordRepository): email.EmailRawRecordStore {
  return {
    append: async (record) => {
      await rawRecords.append(record);
    },
    findByExternalId: (workspaceId, sourceId, externalId) =>
      rawRecords.findByExternalId(workspaceId, sourceId, externalId),
  };
}

function syncStatusFor(errors: readonly unknown[]): "succeeded" | "completed_with_errors" {
  return errors.length > 0 ? "completed_with_errors" : "succeeded";
}

export async function runSourceSync(
  deps: SourceSyncDependencies,
  input: RunSourceSyncInput,
): Promise<SourceSyncResult> {
  const { context, sourceId } = input;
  const source = await deps.sources.getById(context.workspaceId, sourceId);
  if (source === undefined) {
    throw new NonRetryableJobError(`source ${sourceId} not found in workspace`);
  }
  if (!isSyncableSourceKind(source.kind)) {
    throw new NonRetryableJobError(`source kind ${source.kind} cannot be synced by this worker`);
  }
  if (source.status !== "active") {
    throw new NonRetryableJobError(`source ${sourceId} is ${source.status}, not active`);
  }
  switch (source.kind) {
    case "enable_banking":
      return syncEnableBanking(deps, input);
    case "email":
      return syncEmail(deps, input);
  }
}

// --- Enable Banking -----------------------------------------------------------

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

async function syncEnableBanking(
  deps: SourceSyncDependencies,
  input: RunSourceSyncInput,
): Promise<BankSourceSyncResult> {
  const { context, sourceId } = input;
  const { workspaceId } = context;
  const { client, sessionId } = await deps.gateway.resolveEnableBanking(context, sourceId);

  // Capture what this run wrote so the draft phase covers exactly those rows.
  const captured = new Map<string, CapturedTransaction>();
  const bankStore = createWorkspaceBankRecordStore(deps.bankRecords, workspaceId);
  const capturingStore: enableBanking.BankRecordStore = {
    ...bankStore,
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
    rawStore: rawRecordStore(deps.rawRecords),
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
    kind: "enable_banking",
    syncRunId: summary.runId,
    syncStatus: syncStatusFor(summary.errors),
    accountsSynced: summary.accountsSynced,
    transactionsSynced: summary.transactionsSynced,
    drafts,
    draftTransactionIds,
    errors: summary.errors.map((error) => ({
      scope: error.accountUid,
      message: redactText(error.message),
    })),
  };
}

// --- Email --------------------------------------------------------------------

async function syncEmail(
  deps: SourceSyncDependencies,
  input: RunSourceSyncInput,
): Promise<EmailSourceSyncResult> {
  const { context, sourceId } = input;
  const { workspaceId } = context;
  const { client, policy } = await deps.gateway.resolveEmail(context, sourceId);

  // The connector saves documents itself; capture the ids it stores so the
  // handler can queue extraction for exactly those.
  const documentIds: string[] = [];
  const documentStore: email.EmailDocumentStore = {
    findByContentHash: (ws, hash) => deps.documents.findByContentHash(ws, hash),
    save: async (document) => {
      const saved = await deps.documents.save(document);
      if (saved.id === document.id) {
        documentIds.push(saved.id);
      }
      return saved;
    },
  };

  const summary = await email.runEmailSync({
    workspaceId,
    sourceId,
    client,
    policy,
    runStore: createWorkspaceEmailSyncRunStore(deps.emailSyncRuns, workspaceId),
    rawStore: rawRecordStore(deps.rawRecords),
    documentStore,
    documentStorage: deps.storage,
    env: { ids: deps.ids, nowIso: () => input.now },
  });

  return {
    kind: "email",
    syncRunId: summary.runId,
    syncStatus: syncStatusFor(summary.errors),
    messagesSeen: summary.messagesSeen,
    messagesIngested: summary.messagesIngested,
    attachmentsStored: summary.attachmentsStored,
    attachmentsDeduplicated: summary.attachmentsDeduplicated,
    documentIds,
    errors: summary.errors.map((error) => ({
      scope: error.uid === undefined ? "(mailbox)" : `uid:${error.uid}`,
      message: redactText(error.message),
    })),
  };
}

// --- Handler ------------------------------------------------------------------

/** Upper bound on waiting documents re-queued for reconciliation per sync. */
const MAX_RECONCILIATION_REQUEUE = 500;

export function createSourceSyncHandler(deps: SourceSyncDependencies): JobHandler<"source_sync"> {
  return async ({ job, context, now, enqueue, produced }) => {
    const result = await runSourceSync(deps, {
      context,
      sourceId: job.payload.sourceId,
      now,
      transactionQuery: job.payload.transactionQuery,
    });
    produced({ type: RECORD_TYPES.sourceSyncRun, id: result.syncRunId });

    if (result.kind === "email") {
      for (const documentId of result.documentIds) {
        produced({ type: RECORD_TYPES.document, id: documentId });
        await enqueue("extraction", { documentId });
      }
      const { documentIds, ...summary } = result;
      return { ...summary, documentsStored: documentIds.length } satisfies JsonValue;
    }

    for (const id of result.draftTransactionIds) {
      produced({ type: RECORD_TYPES.ledgerTransaction, id });
    }
    // New or corrected transactions may be the payment a stored receipt has
    // been waiting for: give every unsubstantiated document another pass.
    let reconciliationsQueued = 0;
    if (result.draftTransactionIds.length > 0) {
      const waiting = await deps.documents.listUnsubstantiated(
        context.workspaceId,
        MAX_RECONCILIATION_REQUEUE,
      );
      for (const document of waiting) {
        const queued = await enqueue("reconciliation", {
          documentId: document.id,
          trigger: `sync:${result.syncRunId}`,
        });
        if (queued.created) {
          reconciliationsQueued += 1;
        }
      }
    }
    const { draftTransactionIds, ...summary } = result;
    return { ...summary, reconciliationsQueued } satisfies JsonValue;
  };
}
