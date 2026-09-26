/**
 * Turns parsed Portfolio Performance rows into Sona portfolio events and
 * valuation snapshots.
 *
 * Portfolio Performance rows carry no provider ids, so the external id is a
 * hash of the row's economic identity (date, type, amounts, shares, security).
 * Deliberately excluded: account labels and gross/FX columns, because the same
 * trade appears in both the cash-account and the securities-account export
 * views and must collapse to one event; and the free-text note, because a user
 * editing a note in Portfolio Performance must not turn a re-export into a
 * second trade. The full row is still preserved verbatim in the raw vault.
 * Legitimately identical rows in one file (two equal same-day buys) are kept
 * apart by an occurrence suffix. Known limit: identical rows from two separate
 * per-account exports collapse; import a combined export when that matters.
 */
import {
  type CashMovement,
  cashDirectionFor,
  createValuationSnapshot,
  isSecurityTransactionType,
  type JsonValue,
  negateDecimal,
  type PortfolioEvent,
  type SecurityRef,
  type SecurityTransaction,
  securityKey,
  stableJsonHash,
  type ValuationSnapshot,
} from "@sona/core";
import type { PpParsedHolding, PpParsedRow, PpRawEventPayload } from "./types.js";

export const DEFAULT_BROKER_ACCOUNT_EXTERNAL_ID = "default";

/** Fields that identify a row across re-exports. */
function portfolioRowIdentity(row: PpParsedRow): JsonValue {
  return {
    date: row.date,
    type: row.type,
    value: row.value,
    currency: row.currency,
    shares: row.shares ?? null,
    isin: row.isin ?? null,
    wkn: row.wkn ?? null,
    ticker: row.ticker ?? null,
    securityName: row.securityName ?? null,
    fees: row.fees,
    taxes: row.taxes,
  };
}

function securityRef(row: {
  isin: string | undefined;
  wkn: string | undefined;
  ticker: string | undefined;
  securityName: string | undefined;
}): SecurityRef | undefined {
  const ref: SecurityRef = {
    isin: row.isin,
    wkn: row.wkn,
    ticker: row.ticker,
    name: row.securityName,
  };
  return securityKey(ref) === undefined ? undefined : ref;
}

function signedValue(row: PpParsedRow): string {
  return cashDirectionFor(row.type) === "outflow" ? negateDecimal(row.value) : row.value;
}

export interface NormalizeRowOptions {
  /** 0-based index among identical rows in the same file. */
  occurrence: number;
  defaultAccountExternalId?: string;
}

export function normalizePortfolioPerformanceRow(
  row: PpParsedRow,
  options: NormalizeRowOptions,
): PortfolioEvent {
  return normalizeRow(row, stableJsonHash(portfolioRowIdentity(row)), options);
}

function normalizeRow(
  row: PpParsedRow,
  identityHash: string,
  options: NormalizeRowOptions,
): PortfolioEvent {
  const fallbackAccount = options.defaultAccountExternalId ?? DEFAULT_BROKER_ACCOUNT_EXTERNAL_ID;
  const externalId = `pp_${identityHash}_${options.occurrence}`;
  const amount = { amount: signedValue(row), commodity: row.currency };
  const security = securityRef(row);
  const raw: PpRawEventPayload = {
    format: "portfolio_performance_csv",
    occurrence: options.occurrence,
    columns: row.columns,
  };

  if (isSecurityTransactionType(row.type)) {
    if (security === undefined) {
      throw new Error(`${row.type} row on line ${row.line} has no security identifier`);
    }
    const gross =
      row.grossAmount !== undefined &&
      row.grossCurrency !== undefined &&
      row.grossCurrency !== row.currency
        ? { amount: row.grossAmount, commodity: row.grossCurrency }
        : undefined;
    const event: SecurityTransaction = {
      kind: "security_transaction",
      type: row.type,
      externalId,
      brokerAccountExternalId: row.securitiesAccount ?? row.cashAccount ?? fallbackAccount,
      date: row.date,
      amount,
      security,
      shares: row.shares,
      gross,
      exchangeRate: row.exchangeRate,
      fees: row.fees,
      taxes: row.taxes,
      note: row.note,
      raw,
    };
    return event;
  }

  const event: CashMovement = {
    kind: "cash_movement",
    type: row.type,
    externalId,
    brokerAccountExternalId: row.cashAccount ?? row.securitiesAccount ?? fallbackAccount,
    date: row.date,
    amount,
    security,
    note: row.note,
    raw,
  };
  return event;
}

/** Normalizes a whole file, assigning occurrence indexes to identical rows. */
export function normalizePortfolioPerformanceRows(
  rows: readonly PpParsedRow[],
  options: Omit<NormalizeRowOptions, "occurrence"> = {},
): PortfolioEvent[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const identity = stableJsonHash(portfolioRowIdentity(row));
    const occurrence = seen.get(identity) ?? 0;
    seen.set(identity, occurrence + 1);
    return normalizeRow(row, identity, { ...options, occurrence });
  });
}

export interface NormalizeHoldingInput {
  id: string;
  workspaceId: string;
  sourceId: string;
  /** ISO YYYY-MM-DD the holdings export was taken. */
  asOf: string;
  rawRecordId?: string;
  createdAt: string;
  defaultAccountExternalId?: string;
}

export function holdingIdentity(holding: PpParsedHolding, asOf: string): JsonValue {
  return {
    asOf,
    isin: holding.isin ?? null,
    wkn: holding.wkn ?? null,
    ticker: holding.ticker ?? null,
    securityName: holding.securityName ?? null,
    securitiesAccount: holding.securitiesAccount ?? null,
    shares: holding.shares ?? null,
    marketValue: holding.marketValue,
    currency: holding.currency,
  };
}

export function normalizePortfolioPerformanceHolding(
  holding: PpParsedHolding,
  input: NormalizeHoldingInput,
): ValuationSnapshot {
  return createValuationSnapshot({
    id: input.id,
    workspaceId: input.workspaceId,
    sourceId: input.sourceId,
    brokerAccountExternalId: holding.securitiesAccount ?? input.defaultAccountExternalId,
    security: securityRef(holding),
    asOf: input.asOf,
    shares: holding.shares,
    marketValue: { amount: holding.marketValue, commodity: holding.currency },
    valuationSource: "portfolio_performance",
    rawRecordId: input.rawRecordId,
    createdAt: input.createdAt,
  });
}
