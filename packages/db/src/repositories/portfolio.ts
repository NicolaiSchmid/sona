import {
  type BrokerAccount,
  type CashMovement,
  decimalsEqual,
  isBrokerAccountKind,
  isCashMovementType,
  isSecurityTransactionType,
  isValuationSource,
  type PortfolioEvent,
  type Security,
  type SecurityRef,
  type SecurityTransaction,
  securityKey,
  type ValuationSnapshot,
} from "@sona/core";
import type { DbClient, DbValue } from "../runner.js";
import {
  emptyToUndefined,
  optionalString,
  parseJson,
  requiredNumber,
  requiredString,
  row,
  rows,
  stringifyJson,
} from "./helpers.js";
import type {
  PortfolioBrokerAccountInput,
  PortfolioSaveResult,
  PortfolioSecurityInput,
  PortfolioStore,
  RawLink,
} from "./types.js";

export interface PersistedBrokerAccount extends BrokerAccount {
  updatedAt: string;
}

export interface PersistedSecurity extends Security {
  updatedAt: string;
}

export type PersistedPortfolioEvent = PortfolioEvent & {
  workspaceId: string;
  sourceId: string;
  rawRecordId: string;
  createdAt: string;
};

export class SqlitePortfolioRepository {
  readonly #db: DbClient;

  constructor(db: DbClient) {
    this.#db = db;
  }

  /**
   * Upsert where the first registration wins for `kind` and `currency`: an
   * account's nature must not flip because a later export led with a different
   * row type. Only the display name follows the latest export.
   */
  async saveBrokerAccount(
    workspaceId: string,
    sourceId: string,
    account: PortfolioBrokerAccountInput,
  ): Promise<void> {
    this.#db
      .prepare(
        "INSERT INTO broker_accounts (id, workspace_id, source_id, external_id, name, kind, currency, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id, source_id, external_id) DO UPDATE SET name = excluded.name, currency = COALESCE(broker_accounts.currency, excluded.currency), updated_at = excluded.updated_at",
      )
      .run(
        `broker_account:${sourceId}:${account.externalId}`,
        workspaceId,
        sourceId,
        account.externalId,
        account.name,
        account.kind,
        account.currency ?? null,
        new Date().toISOString(),
      );
  }

  /**
   * Upsert where the latest *defined* identifier wins: exports differ in which
   * of ISIN/WKN/ticker/name they carry, so each new value fills or refreshes
   * the field without a missing column erasing what an earlier export knew.
   */
  async saveSecurity(workspaceId: string, security: PortfolioSecurityInput): Promise<void> {
    this.#db
      .prepare(
        "INSERT INTO securities (id, workspace_id, security_key, isin, wkn, ticker, name, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id, security_key) DO UPDATE SET isin = COALESCE(excluded.isin, securities.isin), wkn = COALESCE(excluded.wkn, securities.wkn), ticker = COALESCE(excluded.ticker, securities.ticker), name = COALESCE(excluded.name, securities.name), updated_at = excluded.updated_at",
      )
      .run(
        // The primary key is global, so it must carry the workspace or two
        // tenants holding the same ISIN would collide.
        `security:${workspaceId}:${security.key}`,
        workspaceId,
        security.key,
        security.isin ?? null,
        security.wkn ?? null,
        security.ticker ?? null,
        security.name ?? null,
        new Date().toISOString(),
      );
  }

  /**
   * Inserts a normalized event once per (workspace, source, external id) in a
   * single atomic statement, so two concurrent imports cannot both insert.
   * Existing events are never updated: the same external id means the same
   * economic row. If the stored event carries *different* gross/FX details
   * (a corrected re-export) the result is `conflict`, not silence.
   */
  async saveEvent(
    workspaceId: string,
    sourceId: string,
    event: PortfolioEvent,
    link: RawLink,
  ): Promise<PortfolioSaveResult> {
    this.assertRawRecordSource(workspaceId, sourceId, link.rawRecordId);
    const security = event.security;
    const trade = event.kind === "security_transaction" ? event : undefined;
    const inserted = this.insertIgnoringConflicts(
      "INSERT OR IGNORE INTO portfolio_events (id, workspace_id, source_id, external_id, broker_account_external_id, kind, event_type, event_date, amount, currency, isin, wkn, ticker, security_name, shares, gross_amount, gross_currency, exchange_rate, fees, taxes, note, raw_json, raw_record_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        `portfolio_event:${sourceId}:${event.externalId}`,
        workspaceId,
        sourceId,
        event.externalId,
        event.brokerAccountExternalId,
        event.kind,
        event.type,
        event.date,
        event.amount.amount,
        event.amount.commodity,
        security?.isin ?? null,
        security?.wkn ?? null,
        security?.ticker ?? null,
        security?.name ?? null,
        trade?.shares ?? null,
        trade?.gross?.amount ?? null,
        trade?.gross?.commodity ?? null,
        trade?.exchangeRate ?? null,
        trade?.fees ?? null,
        trade?.taxes ?? null,
        event.note ?? null,
        stringifyJson(event.raw),
        link.rawRecordId,
        new Date().toISOString(),
      ],
    );
    if (inserted) {
      return "created";
    }
    const existing = await this.getEvent(workspaceId, sourceId, event.externalId);
    if (existing === undefined) {
      throw new Error("portfolio event was neither inserted nor found");
    }
    // Account labels and notes legitimately differ between export views and
    // are not identity; only a defined-vs-defined disagreement on gross/FX
    // details counts as a conflict (a view that omits them is compatible).
    // The Portfolio Performance normalizer hashes the core fields into the
    // external id, but the store contract is generic: a caller with weaker ids
    // must not be able to overwrite-by-omission, so core fields are compared too.
    const stored = existing.kind === "security_transaction" ? existing : undefined;
    const conflict =
      stringsDiffer(existing.type, event.type) ||
      stringsDiffer(existing.date, event.date) ||
      decimalsDiffer(existing.amount.amount, event.amount.amount) ||
      stringsDiffer(existing.amount.commodity, event.amount.commodity) ||
      decimalsDiffer(stored?.gross?.amount, trade?.gross?.amount) ||
      stringsDiffer(stored?.gross?.commodity, trade?.gross?.commodity) ||
      decimalsDiffer(stored?.exchangeRate, trade?.exchangeRate);
    return conflict ? "conflict" : "unchanged";
  }

  /**
   * Appends a valuation once per (account, security, asOf); never updates. A
   * snapshot whose values differ from the one already stored for that point is
   * reported as `conflict` so the caller can surface it instead of losing it.
   */
  async saveValuation(
    workspaceId: string,
    sourceId: string,
    snapshot: ValuationSnapshot,
  ): Promise<PortfolioSaveResult> {
    if (snapshot.workspaceId !== workspaceId || snapshot.sourceId !== sourceId) {
      throw new Error("valuation snapshot workspace/source mismatch");
    }
    if (snapshot.rawRecordId !== undefined) {
      this.assertRawRecordSource(workspaceId, sourceId, snapshot.rawRecordId);
    }
    const accountRef = snapshot.brokerAccountExternalId ?? "";
    const key = snapshot.security === undefined ? "" : (securityKey(snapshot.security) ?? "");
    const inserted = this.insertIgnoringConflicts(
      "INSERT OR IGNORE INTO portfolio_valuations (id, workspace_id, source_id, broker_account_ref, security_key, isin, wkn, ticker, security_name, as_of, shares, market_value, currency, valuation_source, raw_record_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        snapshot.id,
        workspaceId,
        sourceId,
        accountRef,
        key,
        snapshot.security?.isin ?? null,
        snapshot.security?.wkn ?? null,
        snapshot.security?.ticker ?? null,
        snapshot.security?.name ?? null,
        snapshot.asOf,
        snapshot.shares ?? null,
        snapshot.marketValue.amount,
        snapshot.marketValue.commodity,
        snapshot.valuationSource,
        snapshot.rawRecordId ?? null,
        snapshot.createdAt,
      ],
    );
    if (inserted) {
      return "created";
    }
    const existing = row(
      this.#db
        .prepare(
          "SELECT shares, market_value, currency FROM portfolio_valuations WHERE workspace_id = ? AND source_id = ? AND broker_account_ref = ? AND security_key = ? AND as_of = ?",
        )
        .get(workspaceId, sourceId, accountRef, key, snapshot.asOf),
    );
    if (existing === undefined) {
      throw new Error("portfolio valuation was neither inserted nor found");
    }
    const storedShares = optionalString(existing, "shares");
    const conflict =
      (storedShares === undefined) !== (snapshot.shares === undefined) ||
      decimalsDiffer(storedShares, snapshot.shares) ||
      decimalsDiffer(requiredString(existing, "market_value"), snapshot.marketValue.amount) ||
      stringsDiffer(requiredString(existing, "currency"), snapshot.marketValue.commodity);
    return conflict ? "conflict" : "unchanged";
  }

  /**
   * Runs an `INSERT OR IGNORE` and reports whether a row was written. Using
   * the statement's change count instead of a preceding SELECT keeps the
   * idempotency check atomic under concurrent imports.
   */
  private insertIgnoringConflicts(sql: string, params: DbValue[]): boolean {
    const result = row(this.#db.prepare(sql).run(...params));
    if (result === undefined) {
      throw new Error("database did not report the change count of an insert");
    }
    return requiredNumber(result, "changes") > 0;
  }

  async getEvent(
    workspaceId: string,
    sourceId: string,
    externalId: string,
  ): Promise<PersistedPortfolioEvent | undefined> {
    const result = row(
      this.#db
        .prepare(
          "SELECT * FROM portfolio_events WHERE workspace_id = ? AND source_id = ? AND external_id = ?",
        )
        .get(workspaceId, sourceId, externalId),
    );
    return result === undefined ? undefined : eventFromRow(result);
  }

  async listEvents(workspaceId: string, sourceId: string): Promise<PersistedPortfolioEvent[]> {
    return rows(
      this.#db
        .prepare(
          "SELECT * FROM portfolio_events WHERE workspace_id = ? AND source_id = ? ORDER BY event_date, external_id",
        )
        .all(workspaceId, sourceId),
    ).map(eventFromRow);
  }

  async listBrokerAccounts(
    workspaceId: string,
    sourceId: string,
  ): Promise<PersistedBrokerAccount[]> {
    return rows(
      this.#db
        .prepare(
          "SELECT * FROM broker_accounts WHERE workspace_id = ? AND source_id = ? ORDER BY external_id",
        )
        .all(workspaceId, sourceId),
    ).map((source) => {
      const kind = requiredString(source, "kind");
      if (!isBrokerAccountKind(kind)) {
        throw new Error(`persisted broker account has unknown kind ${kind}`);
      }
      return {
        id: requiredString(source, "id"),
        workspaceId: requiredString(source, "workspace_id"),
        sourceId: requiredString(source, "source_id"),
        externalId: requiredString(source, "external_id"),
        name: requiredString(source, "name"),
        kind,
        currency: optionalString(source, "currency"),
        updatedAt: requiredString(source, "updated_at"),
      };
    });
  }

  async listSecurities(workspaceId: string): Promise<PersistedSecurity[]> {
    return rows(
      this.#db
        .prepare("SELECT * FROM securities WHERE workspace_id = ? ORDER BY security_key")
        .all(workspaceId),
    ).map((source) => ({
      id: requiredString(source, "id"),
      workspaceId: requiredString(source, "workspace_id"),
      key: requiredString(source, "security_key"),
      isin: optionalString(source, "isin"),
      wkn: optionalString(source, "wkn"),
      ticker: optionalString(source, "ticker"),
      name: optionalString(source, "name"),
      updatedAt: requiredString(source, "updated_at"),
    }));
  }

  async listValuations(workspaceId: string, sourceId: string): Promise<ValuationSnapshot[]> {
    return rows(
      this.#db
        .prepare(
          "SELECT * FROM portfolio_valuations WHERE workspace_id = ? AND source_id = ? ORDER BY as_of, broker_account_ref, security_key",
        )
        .all(workspaceId, sourceId),
    ).map(valuationFromRow);
  }

  /** A normalized record may only link to a raw record of its own workspace and source. */
  private assertRawRecordSource(workspaceId: string, sourceId: string, rawRecordId: string): void {
    const result = row(
      this.#db
        .prepare("SELECT source_id FROM raw_source_records WHERE workspace_id = ? AND id = ?")
        .get(workspaceId, rawRecordId),
    );
    if (result === undefined) {
      throw new Error("raw record not found in workspace");
    }
    if (requiredString(result, "source_id") !== sourceId) {
      throw new Error("raw record belongs to another source");
    }
  }
}

/**
 * Defined-vs-defined numeric disagreement ("1.08" and "1.080" agree); an
 * undefined side never conflicts, so an export view that omits a field is
 * compatible with one that carries it.
 */
function decimalsDiffer(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && !decimalsEqual(a, b);
}

function stringsDiffer(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a !== b;
}

/** Binds a repository to one workspace + source as a connector `PortfolioStore`. */
export function createWorkspacePortfolioStore(
  repository: SqlitePortfolioRepository,
  workspaceId: string,
  sourceId: string,
): PortfolioStore {
  return {
    saveBrokerAccount: async (account) =>
      repository.saveBrokerAccount(workspaceId, sourceId, account),
    saveSecurity: async (security) => repository.saveSecurity(workspaceId, security),
    saveEvent: async (event, link) => repository.saveEvent(workspaceId, sourceId, event, link),
    saveValuation: async (snapshot) => repository.saveValuation(workspaceId, sourceId, snapshot),
  };
}

function securityFromRow(source: Record<string, unknown>): SecurityRef | undefined {
  const ref: SecurityRef = {
    isin: optionalString(source, "isin"),
    wkn: optionalString(source, "wkn"),
    ticker: optionalString(source, "ticker"),
    name: optionalString(source, "security_name"),
  };
  return securityKey(ref) === undefined ? undefined : ref;
}

function eventFromRow(source: Record<string, unknown>): PersistedPortfolioEvent {
  const kind = requiredString(source, "kind");
  const type = requiredString(source, "event_type");
  const persisted = {
    workspaceId: requiredString(source, "workspace_id"),
    sourceId: requiredString(source, "source_id"),
    rawRecordId: requiredString(source, "raw_record_id"),
    createdAt: requiredString(source, "created_at"),
  };
  const base = {
    externalId: requiredString(source, "external_id"),
    brokerAccountExternalId: requiredString(source, "broker_account_external_id"),
    date: requiredString(source, "event_date"),
    amount: {
      amount: requiredString(source, "amount"),
      commodity: requiredString(source, "currency"),
    },
    note: optionalString(source, "note"),
    raw: parseJson(requiredString(source, "raw_json")),
  };
  const security = securityFromRow(source);

  if (kind === "security_transaction" && isSecurityTransactionType(type)) {
    if (security === undefined) {
      throw new Error("persisted security transaction has no security");
    }
    const grossAmount = optionalString(source, "gross_amount");
    const grossCurrency = optionalString(source, "gross_currency");
    const event: SecurityTransaction = {
      ...base,
      kind,
      type,
      security,
      shares: optionalString(source, "shares"),
      gross:
        grossAmount !== undefined && grossCurrency !== undefined
          ? { amount: grossAmount, commodity: grossCurrency }
          : undefined,
      exchangeRate: optionalString(source, "exchange_rate"),
      fees: optionalString(source, "fees") ?? "0",
      taxes: optionalString(source, "taxes") ?? "0",
    };
    return { ...event, ...persisted };
  }
  if (kind === "cash_movement" && isCashMovementType(type)) {
    const event: CashMovement = { ...base, kind, type, security };
    return { ...event, ...persisted };
  }
  throw new Error(`persisted portfolio event has unknown kind/type ${kind}/${type}`);
}

function valuationFromRow(source: Record<string, unknown>): ValuationSnapshot {
  const valuationSource = requiredString(source, "valuation_source");
  if (!isValuationSource(valuationSource)) {
    throw new Error(`persisted valuation has unknown source ${valuationSource}`);
  }
  return {
    id: requiredString(source, "id"),
    workspaceId: requiredString(source, "workspace_id"),
    sourceId: requiredString(source, "source_id"),
    brokerAccountExternalId: emptyToUndefined(requiredString(source, "broker_account_ref")),
    security: securityFromRow(source),
    asOf: requiredString(source, "as_of"),
    shares: optionalString(source, "shares"),
    marketValue: {
      amount: requiredString(source, "market_value"),
      commodity: requiredString(source, "currency"),
    },
    valuationSource,
    rawRecordId: optionalString(source, "raw_record_id"),
    createdAt: requiredString(source, "created_at"),
  };
}
