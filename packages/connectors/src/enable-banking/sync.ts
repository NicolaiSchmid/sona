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

export type SyncStatus = "succeeded" | "completed_with_errors";

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
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runEnableBankingSync(input: RunEnableBankingSyncInput): Promise<SyncSummary> {
  const { workspaceId, sourceId, sessionId, client, runStore, rawStore, bankStore, env } = input;

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

  const appendRaw = async (
    recordType: RawSourceRecord["recordType"],
    externalId: string,
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
        payloadJson: payload,
        observedAt: at,
        createdAt: at,
      }),
    );
  };

  const session = await client.getSession({ sessionId });
  const accountUids = accountUidsFromSession(session);

  for (const accountUid of accountUids) {
    try {
      const details = await client.getAccountDetails({ accountUid });
      const account = normalizeAccount(details);
      await appendRaw("bank_account", account.externalId, account.raw);
      await bankStore.saveAccount(account);
      summary.accountsSynced += 1;

      const balances = await client.getBalances({ accountUid });
      await appendRaw("bank_balance", `${account.externalId}:balances`, toJson(balances));
      for (const balance of balances.balances) {
        await bankStore.saveBalance(normalizeBalance(account.externalId, balance));
        summary.balancesSynced += 1;
      }

      const transactions = await client.getTransactions({ accountUid });
      await appendRaw(
        "bank_transaction",
        `${account.externalId}:transactions`,
        toJson(transactions),
      );
      for (const transaction of transactions.transactions) {
        await bankStore.saveTransaction(normalizeTransaction(account.externalId, transaction));
        summary.transactionsSynced += 1;
      }
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
