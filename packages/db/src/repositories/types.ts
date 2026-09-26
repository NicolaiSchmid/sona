import type {
  BrokerAccountKind,
  JsonValue,
  PortfolioEvent,
  SecurityRef,
  ValuationSnapshot,
} from "@sona/core";

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

// Portfolio store contract mirrored from @sona/connectors (portfolio-performance).

/**
 * Whether a normalized record was newly created, already known with the same
 * identity, or rejected because a different record already occupies its key.
 */
export type PortfolioSaveResult = "created" | "unchanged" | "conflict";

export interface PortfolioBrokerAccountInput {
  externalId: string;
  name: string;
  kind: BrokerAccountKind;
  currency: string | undefined;
}

export interface PortfolioSecurityInput extends SecurityRef {
  key: string;
}

export interface PortfolioStore {
  saveBrokerAccount(account: PortfolioBrokerAccountInput): Promise<void>;
  saveSecurity(security: PortfolioSecurityInput): Promise<void>;
  /** MUST be idempotent on the event's external id within (workspace, source); never updates. */
  saveEvent(event: PortfolioEvent, link: RawLink): Promise<PortfolioSaveResult>;
  /**
   * MUST be append-only and idempotent on (account, security, asOf) within
   * (workspace, source); a differing snapshot for an occupied key is `conflict`.
   */
  saveValuation(snapshot: ValuationSnapshot): Promise<PortfolioSaveResult>;
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
