import type { JsonValue } from "@sona/core";

export interface SyncSummary {
  runId: string;
  accountsSynced: number;
  balancesSynced: number;
  transactionsSynced: number;
  errors: Array<{ accountUid: string; message: string }>;
}

export type SyncStatus = "succeeded" | "completed_with_errors" | "failed";

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

export interface RawLink {
  rawRecordId: string;
}

export interface NormalizedAccount {
  externalId: string;
  name: string | undefined;
  iban: string | undefined;
  currency: string | undefined;
  product: string | undefined;
  raw: JsonValue;
}

export interface NormalizedBalance {
  accountExternalId: string;
  type: string | undefined;
  amount: string;
  currency: string;
  referenceDate: string | undefined;
  raw: JsonValue;
}

export interface NormalizedTransaction {
  accountExternalId: string;
  externalId: string;
  bookedOn: string | undefined;
  valueDate: string | undefined;
  amount: string;
  currency: string;
  status: string | undefined;
  counterpartyName: string | undefined;
  remittanceInfo: string | undefined;
  raw: JsonValue;
}

export interface BankRecordStore {
  saveAccount(account: NormalizedAccount, link: RawLink): Promise<void>;
  saveBalance(balance: NormalizedBalance, link: RawLink): Promise<void>;
  saveTransaction(transaction: NormalizedTransaction, link: RawLink): Promise<void>;
}

export interface TaskRunProvenance {
  runId: string;
  taskId: string;
  taskVersion: number;
  portalDomain: string;
  browserProvider: string;
  workspaceId: string;
  fetchedAt: string;
}
