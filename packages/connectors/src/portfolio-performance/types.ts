/**
 * Shapes for Portfolio Performance CSV exports and the typed rows Sona parses
 * from them. Only the columns Sona consumes are modeled; the verbatim row is
 * always preserved on the raw source record and the normalized event's `raw`.
 */
import type { PortfolioEventType } from "@sona/core";

/** Canonical (locale-independent) names for the transaction export columns. */
export const PP_COLUMNS = [
  "date",
  "type",
  "value",
  "currency",
  "grossAmount",
  "grossCurrency",
  "exchangeRate",
  "fees",
  "taxes",
  "shares",
  "isin",
  "wkn",
  "ticker",
  "securityName",
  "note",
  "cashAccount",
  "securitiesAccount",
] as const;

export type PpColumn = (typeof PP_COLUMNS)[number];

/** Canonical column names for a holdings/statement-of-assets export. */
export const PP_HOLDINGS_COLUMNS = [
  "securityName",
  "isin",
  "wkn",
  "ticker",
  "shares",
  "quote",
  "marketValue",
  "currency",
  "securitiesAccount",
] as const;

export type PpHoldingsColumn = (typeof PP_HOLDINGS_COLUMNS)[number];

/** Locale of numbers and dates in the export. */
export type PpNumberFormat = "de" | "en";

export interface PpParseOptions {
  /** Defaults to the locale inferred from the header language. */
  numberFormat?: PpNumberFormat;
  /** Used when the export has no currency column. */
  defaultCurrency?: string;
}

/** A row that failed validation. The row is skipped, never silently coerced. */
export interface PpRowError {
  /** 1-based line number in the source CSV. */
  line: number;
  message: string;
}

/** A successfully parsed, typed transaction row. Strings are decimal strings. */
export interface PpParsedRow {
  line: number;
  type: PortfolioEventType;
  /** ISO YYYY-MM-DD. */
  date: string;
  /** Absolute booking-currency value as reported (sign is derived from type). */
  value: string;
  currency: string;
  grossAmount: string | undefined;
  grossCurrency: string | undefined;
  exchangeRate: string | undefined;
  /** Non-negative decimal strings; "0" when absent. */
  fees: string;
  taxes: string;
  shares: string | undefined;
  isin: string | undefined;
  wkn: string | undefined;
  ticker: string | undefined;
  securityName: string | undefined;
  note: string | undefined;
  cashAccount: string | undefined;
  securitiesAccount: string | undefined;
  /** Verbatim header → cell mapping for the raw vault. */
  columns: Record<string, string>;
}

export interface PpParseResult {
  numberFormat: PpNumberFormat;
  rows: PpParsedRow[];
  errors: PpRowError[];
}

export interface PpParsedHolding {
  line: number;
  isin: string | undefined;
  wkn: string | undefined;
  ticker: string | undefined;
  securityName: string | undefined;
  shares: string | undefined;
  marketValue: string;
  currency: string;
  securitiesAccount: string | undefined;
  columns: Record<string, string>;
}

export interface PpHoldingsParseResult {
  numberFormat: PpNumberFormat;
  rows: PpParsedHolding[];
  errors: PpRowError[];
}

/**
 * Raw payload stored for each imported transaction row. Declared as a type
 * literal (not an interface) so it is assignable to `JsonValue` without an
 * index signature that would admit arbitrary keys.
 */
export type PpRawEventPayload = {
  format: "portfolio_performance_csv";
  /** 0-based index among rows with identical content in the same file. */
  occurrence: number;
  columns: Record<string, string>;
};

/** Raw payload stored for each imported holdings row. */
export type PpRawHoldingPayload = {
  format: "portfolio_performance_holdings_csv";
  /** ISO YYYY-MM-DD supplied by the caller; the export has no date column. */
  asOf: string;
  columns: Record<string, string>;
};
