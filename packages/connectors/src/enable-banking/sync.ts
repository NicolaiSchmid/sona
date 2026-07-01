/**
 * Sync orchestration: fetch a session's accounts, write raw provider payloads to
 * the append-only vault *before* normalized records, and tolerate per-account
 * failures (one flaky ASPSP account must not fail the whole sync). All stores
 * are injected so this composes with real repositories or in-memory fakes.
 */
import { createRawSourceRecord, type JsonValue, type RawSourceRecord } from "@sona/core";
import type { EnableBankingClient } from "./client.js";
import {
  accountUidsFromSession,
  normalizeAccount,
  normalizeBalance,
  normalizeTransaction,
} from "./normalize.js";
import type { NormalizedAccount, NormalizedBalance, NormalizedTransaction } from "./types.js";

export interface SyncRunStore {
  start(run: {
    runId: string;
    workspaceId: string;
    sourceId: string;
    startedAt: string;
  }): Promise<void>;
  recordError(error: {
    runId: string;
    accountUid: string;
    message: string;
    at: string;
  }): Promise<void>;
  finish(run: {
    runId: string;
    status: SyncStatus;
    finishedAt: string;
    summary: SyncSummary;
  }): Promise<void>;
}

export interface RawRecordStore {
  /**
   * Appends a raw record. MUST be idempotent on the record's dedup key
   * (workspace + source + payload hash): re-importing an unchanged provider
   * payload must be a no-op, not an error, so repeated syncs don't fail on the
   * `uq_raw_records_dedup` constraint.
   */
  append(record: RawSourceRecord): Promise<void>;
}

export interface BankRecordStore {
  saveAccount(account: NormalizedAccount): Promise<void>;
  saveBalance(balance: NormalizedBalance): Promise<void>;
  saveTransaction(transaction: NormalizedTransaction): Promise<void>;
}

export interface SyncEnv {
  /** Unique id generator for raw records and the run. */
  ids: () => string;
  /** Current time as an ISO-8601 string. */
  nowIso: () => string;
}

export type SyncStatus = "succeeded" | "completed_with_errors" | "failed";

/** Pseudo "account" id used to record a session-level (non per-account) failure. */
const SESSION_SCOPE = "(session)";

export interface SyncSummary {
  runId: string;
  accountsSynced: number;
  balancesSynced: number;
  transactionsSynced: number;
  errors: Array<{ accountUid: string; message: string }>;
}

export interface RunEnableBankingSyncInput {
  workspaceId: string;
  sourceId: string;
  sessionId: string;
  client: EnableBankingClient;
  runStore: SyncRunStore;
  rawStore: RawRecordStore;
  bankStore: BankRecordStore;
  env: SyncEnv;
  /**
   * History window / strategy for the first transactions page. Use e.g.
   * `strategy: "longest"` on an initial sync to pull older tax-year history
   * before ASPSPs restrict it.
   */
  transactionQuery?: { dateFrom?: string; dateTo?: string; strategy?: string };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runEnableBankingSync(input: RunEnableBankingSyncInput): Promise<SyncSummary> {
  const { workspaceId, sourceId, sessionId, client, runStore, rawStore, bankStore, env } = input;
  const transactionQuery = input.transactionQuery ?? {};

  const runId = env.ids();
  const startedAt = env.nowIso();
  await runStore.start({ runId, workspaceId, sourceId, startedAt });

  const summary: SyncSummary = {
    runId,
    accountsSynced: 0,
    balancesSynced: 0,
    transactionsSynced: 0,
    errors: [],
  };

  // Raw payloads are wrapped with their fetch context (account id + kind + page)
  // so two accounts returning identical provider payloads (e.g. equal balances)
  // still hash distinctly and each keeps its own raw source-record trail under
  // the `uq_raw_records_dedup` (workspace, source, payload_hash) index.
  const appendRaw = async (
    recordType: RawSourceRecord["recordType"],
    externalId: string,
    context: { accountExternalId: string; kind: string; page?: number },
    payload: JsonValue,
  ): Promise<void> => {
    const at = env.nowIso();
    await rawStore.append(
      createRawSourceRecord({
        id: env.ids(),
        workspaceId,
        sourceId,
        externalId,
        recordType,
        payloadJson: { ...context, payload },
        observedAt: at,
        createdAt: at,
      }),
    );
  };

  let accountUids: string[];
  try {
    const session = await client.getSession({ sessionId });
    if (session.status !== undefined && session.status !== "AUTHORIZED") {
      // Non-authorized (EXPIRED/REVOKED/PENDING_AUTHORIZATION) consent is a
      // failure, not an empty successful sync.
      throw new Error(`Enable Banking session is not authorized (status: ${session.status})`);
    }
    accountUids = accountUidsFromSession(session);
  } catch (error) {
    // A session-level failure (revoked/expired consent, endpoint down) must
    // still close the run with a terminal status and an audit trail.
    const message = errorMessage(error);
    summary.errors.push({ accountUid: SESSION_SCOPE, message });
    await runStore.recordError({ runId, accountUid: SESSION_SCOPE, message, at: env.nowIso() });
    await runStore.finish({ runId, status: "failed", finishedAt: env.nowIso(), summary });
    throw error;
  }

  for (const accountUid of accountUids) {
    try {
      const details = await client.getAccountDetails({ accountUid });
      const account = normalizeAccount(details);
      const ext = account.externalId;
      await appendRaw(
        "bank_account",
        ext,
        { accountExternalId: ext, kind: "account" },
        account.raw,
      );
      await bankStore.saveAccount(account);
      summary.accountsSynced += 1;

      const balances = await client.getBalances({ accountUid });
      await appendRaw(
        "bank_balance",
        `${ext}:balances`,
        { accountExternalId: ext, kind: "balances" },
        toJson(balances),
      );
      for (const balance of balances.balances) {
        await bankStore.saveBalance(normalizeBalance(ext, balance));
        summary.balancesSynced += 1;
      }

      // Follow continuation keys so accounts with many transactions are fully
      // imported, not just the first page. `continuation_key` is null/absent on
      // the final page, so normalize null to undefined before deciding to stop.
      let continuationKey: string | undefined;
      let page = 0;
      do {
        const transactions = await client.getTransactions({
          accountUid,
          continuationKey,
          // Date/strategy apply to the initial page only.
          ...(page === 0 ? transactionQuery : {}),
        });
        await appendRaw(
          "bank_transaction",
          `${ext}:transactions:${page}`,
          { accountExternalId: ext, kind: "transactions", page },
          toJson(transactions),
        );
        for (const transaction of transactions.transactions) {
          await bankStore.saveTransaction(normalizeTransaction(ext, transaction));
          summary.transactionsSynced += 1;
        }
        continuationKey = transactions.continuation_key ?? undefined;
        page += 1;
      } while (continuationKey !== undefined);
    } catch (error) {
      const message = errorMessage(error);
      summary.errors.push({ accountUid, message });
      await runStore.recordError({ runId, accountUid, message, at: env.nowIso() });
    }
  }

  const status: SyncStatus = summary.errors.length > 0 ? "completed_with_errors" : "succeeded";
  await runStore.finish({ runId, status, finishedAt: env.nowIso(), summary });
  return summary;
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
