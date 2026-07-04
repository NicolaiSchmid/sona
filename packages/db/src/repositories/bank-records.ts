import type { JsonValue } from "@sona/core";
import type { DbClient } from "../runner.js";
import { optionalString, parseJson, requiredString, row, rows, stringifyJson } from "./helpers.js";
import type {
  BankRecordStore,
  NormalizedAccount,
  NormalizedBalance,
  NormalizedTransaction,
  RawLink,
} from "./types.js";

export interface PersistedBankAccount {
  workspaceId: string;
  sourceId: string;
  externalId: string;
  name: string | undefined;
  iban: string | undefined;
  currency: string | undefined;
  product: string | undefined;
  raw: JsonValue;
  rawRecordId: string;
  updatedAt: string;
}

export interface PersistedBankBalance {
  workspaceId: string;
  sourceId: string;
  accountExternalId: string;
  type: string | undefined;
  amount: string;
  currency: string;
  referenceDate: string | undefined;
  raw: JsonValue;
  rawRecordId: string;
  updatedAt: string;
}

export interface PersistedBankTransaction {
  workspaceId: string;
  sourceId: string;
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
  rawRecordId: string;
  updatedAt: string;
}

interface RawRecordScope {
  workspaceId: string;
  sourceId: string;
}

export class SqliteBankRecordRepository {
  readonly #db: DbClient;

  constructor(db: DbClient) {
    this.#db = db;
  }

  async saveAccount(workspaceId: string, account: NormalizedAccount, link: RawLink): Promise<void> {
    const scope = this.rawScope(workspaceId, link.rawRecordId);
    const id = `bank_account:${scope.sourceId}:${account.externalId}`;
    this.#db
      .prepare(
        "INSERT INTO bank_accounts (id, workspace_id, source_id, external_id, name, iban, currency, product, raw_json, raw_record_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id, source_id, external_id) DO UPDATE SET name = excluded.name, iban = excluded.iban, currency = excluded.currency, product = excluded.product, raw_json = excluded.raw_json, raw_record_id = excluded.raw_record_id, updated_at = excluded.updated_at",
      )
      .run(
        id,
        workspaceId,
        scope.sourceId,
        account.externalId,
        account.name ?? null,
        account.iban ?? null,
        account.currency ?? null,
        account.product ?? null,
        stringifyJson(account.raw),
        link.rawRecordId,
        new Date().toISOString(),
      );
  }

  async saveBalance(workspaceId: string, balance: NormalizedBalance, link: RawLink): Promise<void> {
    const scope = this.rawScope(workspaceId, link.rawRecordId);
    const type = balance.type ?? "";
    const referenceDate = balance.referenceDate ?? "";
    const id = `bank_balance:${scope.sourceId}:${balance.accountExternalId}:${type}:${balance.currency}:${referenceDate}`;
    this.#db
      .prepare(
        "INSERT INTO bank_balances (id, workspace_id, source_id, account_external_id, balance_type, amount, currency, reference_date, raw_json, raw_record_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id, source_id, account_external_id, balance_type, currency, reference_date) DO UPDATE SET amount = excluded.amount, raw_json = excluded.raw_json, raw_record_id = excluded.raw_record_id, updated_at = excluded.updated_at",
      )
      .run(
        id,
        workspaceId,
        scope.sourceId,
        balance.accountExternalId,
        type,
        balance.amount,
        balance.currency,
        referenceDate,
        stringifyJson(balance.raw),
        link.rawRecordId,
        new Date().toISOString(),
      );
  }

  async saveTransaction(
    workspaceId: string,
    transaction: NormalizedTransaction,
    link: RawLink,
  ): Promise<void> {
    const scope = this.rawScope(workspaceId, link.rawRecordId);
    const id = `bank_transaction:${scope.sourceId}:${transaction.accountExternalId}:${transaction.externalId}`;
    this.#db
      .prepare(
        "INSERT INTO bank_transactions (id, workspace_id, source_id, account_external_id, external_id, booked_on, value_date, amount, currency, status, counterparty_name, remittance_info, raw_json, raw_record_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id, source_id, account_external_id, external_id) DO UPDATE SET booked_on = excluded.booked_on, value_date = excluded.value_date, amount = excluded.amount, currency = excluded.currency, status = excluded.status, counterparty_name = excluded.counterparty_name, remittance_info = excluded.remittance_info, raw_json = excluded.raw_json, raw_record_id = excluded.raw_record_id, updated_at = excluded.updated_at",
      )
      .run(
        id,
        workspaceId,
        scope.sourceId,
        transaction.accountExternalId,
        transaction.externalId,
        transaction.bookedOn ?? null,
        transaction.valueDate ?? null,
        transaction.amount,
        transaction.currency,
        transaction.status ?? null,
        transaction.counterpartyName ?? null,
        transaction.remittanceInfo ?? null,
        stringifyJson(transaction.raw),
        link.rawRecordId,
        new Date().toISOString(),
      );
  }

  async getAccount(
    workspaceId: string,
    sourceId: string,
    externalId: string,
  ): Promise<PersistedBankAccount | undefined> {
    const result = row(
      this.#db
        .prepare(
          "SELECT * FROM bank_accounts WHERE workspace_id = ? AND source_id = ? AND external_id = ?",
        )
        .get(workspaceId, sourceId, externalId),
    );
    return result === undefined ? undefined : accountFromRow(result);
  }

  async getBalance(
    workspaceId: string,
    sourceId: string,
    accountExternalId: string,
    type: string | undefined,
    currency: string,
    referenceDate: string | undefined,
  ): Promise<PersistedBankBalance | undefined> {
    const result = row(
      this.#db
        .prepare(
          "SELECT * FROM bank_balances WHERE workspace_id = ? AND source_id = ? AND account_external_id = ? AND balance_type = ? AND currency = ? AND reference_date = ?",
        )
        .get(workspaceId, sourceId, accountExternalId, type ?? "", currency, referenceDate ?? ""),
    );
    return result === undefined ? undefined : balanceFromRow(result);
  }

  async getTransaction(
    workspaceId: string,
    sourceId: string,
    accountExternalId: string,
    externalId: string,
  ): Promise<PersistedBankTransaction | undefined> {
    const result = row(
      this.#db
        .prepare(
          "SELECT * FROM bank_transactions WHERE workspace_id = ? AND source_id = ? AND account_external_id = ? AND external_id = ?",
        )
        .get(workspaceId, sourceId, accountExternalId, externalId),
    );
    return result === undefined ? undefined : transactionFromRow(result);
  }

  async listTransactionsForAccount(
    workspaceId: string,
    sourceId: string,
    accountExternalId: string,
  ): Promise<PersistedBankTransaction[]> {
    return rows(
      this.#db
        .prepare(
          "SELECT * FROM bank_transactions WHERE workspace_id = ? AND source_id = ? AND account_external_id = ? ORDER BY booked_on, external_id",
        )
        .all(workspaceId, sourceId, accountExternalId),
    ).map(transactionFromRow);
  }

  private rawScope(workspaceId: string, rawRecordId: string): RawRecordScope {
    const result = row(
      this.#db
        .prepare(
          "SELECT workspace_id, source_id FROM raw_source_records WHERE workspace_id = ? AND id = ?",
        )
        .get(workspaceId, rawRecordId),
    );
    if (result === undefined) {
      throw new Error("raw record not found in workspace");
    }
    return {
      workspaceId: requiredString(result, "workspace_id"),
      sourceId: requiredString(result, "source_id"),
    };
  }
}

export function createWorkspaceBankRecordStore(
  repository: SqliteBankRecordRepository,
  workspaceId: string,
): BankRecordStore {
  return {
    saveAccount: async (account, link) => repository.saveAccount(workspaceId, account, link),
    saveBalance: async (balance, link) => repository.saveBalance(workspaceId, balance, link),
    saveTransaction: async (transaction, link) =>
      repository.saveTransaction(workspaceId, transaction, link),
  };
}

function accountFromRow(source: Record<string, unknown>): PersistedBankAccount {
  return {
    workspaceId: requiredString(source, "workspace_id"),
    sourceId: requiredString(source, "source_id"),
    externalId: requiredString(source, "external_id"),
    name: optionalString(source, "name"),
    iban: optionalString(source, "iban"),
    currency: optionalString(source, "currency"),
    product: optionalString(source, "product"),
    raw: parseJson(requiredString(source, "raw_json")),
    rawRecordId: requiredString(source, "raw_record_id"),
    updatedAt: requiredString(source, "updated_at"),
  };
}

function balanceFromRow(source: Record<string, unknown>): PersistedBankBalance {
  return {
    workspaceId: requiredString(source, "workspace_id"),
    sourceId: requiredString(source, "source_id"),
    accountExternalId: requiredString(source, "account_external_id"),
    type: emptyToUndefined(requiredString(source, "balance_type")),
    amount: requiredString(source, "amount"),
    currency: requiredString(source, "currency"),
    referenceDate: emptyToUndefined(requiredString(source, "reference_date")),
    raw: parseJson(requiredString(source, "raw_json")),
    rawRecordId: requiredString(source, "raw_record_id"),
    updatedAt: requiredString(source, "updated_at"),
  };
}

function transactionFromRow(source: Record<string, unknown>): PersistedBankTransaction {
  return {
    workspaceId: requiredString(source, "workspace_id"),
    sourceId: requiredString(source, "source_id"),
    accountExternalId: requiredString(source, "account_external_id"),
    externalId: requiredString(source, "external_id"),
    bookedOn: optionalString(source, "booked_on"),
    valueDate: optionalString(source, "value_date"),
    amount: requiredString(source, "amount"),
    currency: requiredString(source, "currency"),
    status: optionalString(source, "status"),
    counterpartyName: optionalString(source, "counterparty_name"),
    remittanceInfo: optionalString(source, "remittance_info"),
    raw: parseJson(requiredString(source, "raw_json")),
    rawRecordId: requiredString(source, "raw_record_id"),
    updatedAt: requiredString(source, "updated_at"),
  };
}

function emptyToUndefined(value: string): string | undefined {
  return value === "" ? undefined : value;
}
