/**
 * Parses Portfolio Performance CSV exports into typed rows.
 *
 * Portfolio Performance localizes both headers and transaction types, and
 * formats numbers/dates per locale. This module maps German and English
 * exports to canonical columns and Sona's literal event types, parses decimals
 * exactly (no floats), and reports malformed rows as row-level errors instead
 * of skipping them silently.
 */
import {
  absDecimal,
  cashDirectionFor,
  isNegativeDecimal,
  isSecurityTransactionType,
  isValidDecimalString,
  type PortfolioEventType,
} from "@sona/core";
import { type CsvRecord, type CsvTable, parseCsv } from "./csv.js";
import type {
  PpColumn,
  PpHoldingsColumn,
  PpHoldingsParseResult,
  PpNumberFormat,
  PpParsedHolding,
  PpParsedRow,
  PpParseOptions,
  PpParseResult,
  PpRowError,
} from "./types.js";

/** Lowercase, strip diacritics and anything non-alphanumeric. */
export function normalizeToken(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

const HEADER_ALIASES: Readonly<Record<string, PpColumn>> = {
  datum: "date",
  date: "date",
  typ: "type",
  type: "type",
  wert: "value",
  value: "value",
  buchungswahrung: "currency",
  transactioncurrency: "currency",
  wahrung: "currency",
  currency: "currency",
  bruttobetrag: "grossAmount",
  grossamount: "grossAmount",
  wahrungbruttobetrag: "grossCurrency",
  currencygrossamount: "grossCurrency",
  wechselkurs: "exchangeRate",
  exchangerate: "exchangeRate",
  gebuhren: "fees",
  fees: "fees",
  steuern: "taxes",
  taxes: "taxes",
  stuck: "shares",
  shares: "shares",
  isin: "isin",
  wkn: "wkn",
  tickersymbol: "ticker",
  ticker: "ticker",
  wertpapiername: "securityName",
  securityname: "securityName",
  wertpapier: "securityName",
  security: "securityName",
  notiz: "note",
  note: "note",
  konto: "cashAccount",
  cashaccount: "cashAccount",
  depot: "securitiesAccount",
  securitiesaccount: "securitiesAccount",
};

const HOLDINGS_HEADER_ALIASES: Readonly<Record<string, PpHoldingsColumn>> = {
  name: "securityName",
  wertpapiername: "securityName",
  wertpapier: "securityName",
  securityname: "securityName",
  security: "securityName",
  isin: "isin",
  wkn: "wkn",
  tickersymbol: "ticker",
  ticker: "ticker",
  stuck: "shares",
  shares: "shares",
  kurs: "quote",
  quote: "quote",
  marktwert: "marketValue",
  marketvalue: "marketValue",
  wahrung: "currency",
  currency: "currency",
  depot: "securitiesAccount",
  securitiesaccount: "securitiesAccount",
};

/** Header tokens that only occur in German exports. */
const GERMAN_HEADER_TOKENS: ReadonlySet<string> = new Set([
  "datum",
  "typ",
  "wert",
  "buchungswahrung",
  "gebuhren",
  "steuern",
  "stuck",
  "wertpapiername",
  "notiz",
  "konto",
  "depot",
  "kurs",
  "marktwert",
  "wahrung",
]);

const TYPE_ALIASES: Readonly<Record<string, PortfolioEventType>> = {
  kauf: "buy",
  buy: "buy",
  verkauf: "sell",
  sell: "sell",
  einlieferung: "delivery_inbound",
  deliveryinbound: "delivery_inbound",
  auslieferung: "delivery_outbound",
  deliveryoutbound: "delivery_outbound",
  dividende: "dividend",
  dividend: "dividend",
  zinsen: "interest",
  interest: "interest",
  zinsbelastung: "interest_charge",
  interestcharge: "interest_charge",
  gebuhren: "fee",
  fees: "fee",
  fee: "fee",
  gebuhrenerstattung: "fee_refund",
  feesrefund: "fee_refund",
  feerefund: "fee_refund",
  steuern: "tax",
  taxes: "tax",
  tax: "tax",
  steuerruckerstattung: "tax_refund",
  taxrefund: "tax_refund",
  einlage: "deposit",
  deposit: "deposit",
  entnahme: "withdrawal",
  removal: "withdrawal",
  withdrawal: "withdrawal",
  umbuchungeingang: "transfer_in",
  transferinbound: "transfer_in",
  umbuchungausgang: "transfer_out",
  transferoutbound: "transfer_out",
};

/**
 * A malformed cell or row. The row parsers catch it per row and report it as a
 * {@link PpRowError}; callers of the exported cell parsers can catch it to
 * tell bad input from a programming error.
 */
export class PpRowParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PpRowParseError";
  }
}

/** Own-property alias lookup, so a cell like "constructor" never resolves via the prototype. */
function lookupAlias<C extends string>(
  aliases: Readonly<Record<string, C>>,
  token: string,
): C | undefined {
  return Object.hasOwn(aliases, token) ? aliases[token] : undefined;
}

/** Thousands separator and decimal mark per locale. */
const SEPARATORS = {
  de: { grouping: ".", decimal: "," },
  en: { grouping: ",", decimal: "." },
} as const satisfies Record<PpNumberFormat, { grouping: string; decimal: string }>;

function inferNumberFormat(header: readonly string[]): PpNumberFormat {
  return header.some((h) => GERMAN_HEADER_TOKENS.has(normalizeToken(h))) ? "de" : "en";
}

/**
 * Parses a localized decimal ("1.005,00" in `de`, "1,005.00" in `en`) into a
 * canonical decimal string. Returns `undefined` for an empty cell. Grouping
 * separators must delimit exact groups of three digits, so a value written in
 * the other locale ("0.5" under `de`, "1,5" under `en`) is rejected instead of
 * silently changing magnitude.
 */
export function parseLocalizedDecimal(
  raw: string | undefined,
  format: PpNumberFormat,
): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const compact = raw
    .replace(/\s/g, "")
    .replace(/\u2212/g, "-")
    .replace(/^\+/, "");
  if (compact === "") {
    return undefined;
  }
  const { grouping, decimal } = SEPARATORS[format];
  const [integerPart = "", ...decimalParts] = compact.split(decimal);
  const groups = integerPart.split(grouping);
  const wellGrouped = groups.slice(1).every((group) => /^\d{3}$/.test(group));
  const normalized = [groups.join(""), ...decimalParts].join(".");
  if (!wellGrouped || decimalParts.length > 1 || !isValidDecimalString(normalized)) {
    throw new PpRowParseError(`invalid ${format} number ${JSON.stringify(raw)}`);
  }
  return normalized;
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function toIsoDate(year: number, month: number, day: number, raw: string): string {
  if (!isCalendarDate(year, month, day)) {
    throw new PpRowParseError(`invalid calendar date ${JSON.stringify(raw)}`);
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Validates a caller-supplied ISO YYYY-MM-DD calendar date (e.g. a holdings `asOf`). */
export function assertIsoDate(value: string, label: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match || !isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
    throw new Error(
      `${label} must be an ISO calendar date (YYYY-MM-DD), got ${JSON.stringify(value)}`,
    );
  }
}

/** Parses "31.12.2026", "2026-12-31", or (en) "12/31/2026" into ISO. */
export function parseLocalizedDate(raw: string, format: PpNumberFormat): string {
  const [token = ""] = raw.trim().split(/[\sT]/);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(token);
  if (iso) {
    return toIsoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]), raw);
  }
  const dotted = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(token);
  if (dotted) {
    return toIsoDate(Number(dotted[3]), Number(dotted[2]), Number(dotted[1]), raw);
  }
  const slashed = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(token);
  if (slashed && format === "en") {
    return toIsoDate(Number(slashed[3]), Number(slashed[1]), Number(slashed[2]), raw);
  }
  throw new PpRowParseError(`unrecognized date ${JSON.stringify(raw)}`);
}

function parseEventType(raw: string): PortfolioEventType {
  const type = lookupAlias(TYPE_ALIASES, normalizeToken(raw));
  if (type === undefined) {
    throw new PpRowParseError(`unknown transaction type ${JSON.stringify(raw)}`);
  }
  return type;
}

/**
 * Portfolio Performance labels position transfers between securities accounts
 * "Umbuchung" exactly like cash transfers; only the security columns tell them
 * apart. A transfer row that names a security moves shares, not cash.
 */
function resolveTransferType(type: PortfolioEventType, hasSecurity: boolean): PortfolioEventType {
  if (hasSecurity && type === "transfer_in") {
    return "security_transfer_inbound";
  }
  if (hasSecurity && type === "transfer_out") {
    return "security_transfer_outbound";
  }
  return type;
}

/** Maps each header cell to its canonical column; the first alias match wins. */
function columnIndex<C extends string>(
  header: readonly string[],
  aliases: Readonly<Record<string, C>>,
): Map<C, number> {
  const index = new Map<C, number>();
  header.forEach((name, i) => {
    const canonical = lookupAlias(aliases, normalizeToken(name));
    if (canonical !== undefined && !index.has(canonical)) {
      index.set(canonical, i);
    }
  });
  return index;
}

function cellReader<C extends string>(header: readonly string[], index: Map<C, number>) {
  return (cells: readonly string[]) => {
    // Verbatim header → cell map for the raw vault. A repeated header name gets
    // a positional suffix so no cell is lost.
    const columns: Record<string, string> = {};
    header.forEach((name, i) => {
      if (name === "") {
        return;
      }
      const key = Object.hasOwn(columns, name) ? `${name} (${i + 1})` : name;
      columns[key] = cells[i] ?? "";
    });
    const get = (column: C): string | undefined => {
      const i = index.get(column);
      const value = i === undefined ? undefined : cells[i]?.trim();
      return value === undefined || value === "" ? undefined : value;
    };
    return { columns, get };
  };
}

function requireColumns<C extends string>(index: Map<C, number>, required: readonly C[]): void {
  const missing = required.filter((column) => !index.has(column));
  if (missing.length > 0) {
    throw new Error(`CSV is missing required column(s): ${missing.join(", ")}`);
  }
}

type CellGetter<C extends string> = (column: C) => string | undefined;

/** The security identifier cells, plus whether any of them is set. */
function readSecurityColumns(get: CellGetter<"isin" | "wkn" | "ticker" | "securityName">) {
  const isin = get("isin");
  const wkn = get("wkn");
  const ticker = get("ticker");
  const securityName = get("securityName");
  const hasSecurity = [isin, wkn, ticker, securityName].some((v) => v !== undefined);
  return { isin, wkn, ticker, securityName, hasSecurity };
}

function readCurrency(get: CellGetter<"currency">, options: PpParseOptions): string {
  const currency = get("currency") ?? options.defaultCurrency;
  if (currency === undefined) {
    throw new PpRowParseError("missing currency and no default currency configured");
  }
  return currency.toUpperCase();
}

/** Parses each data row, collecting {@link PpRowParseError}s instead of aborting the file. */
function parseRows<T>(
  table: CsvTable,
  parseRow: (record: CsvRecord) => T,
): { rows: T[]; errors: PpRowError[] } {
  const rows: T[] = [];
  const errors: PpRowError[] = [];
  for (const record of table.rows) {
    try {
      rows.push(parseRow(record));
    } catch (error) {
      if (!(error instanceof PpRowParseError)) {
        throw error;
      }
      errors.push({ line: record.line, message: error.message });
    }
  }
  return { rows, errors };
}

/**
 * Parses a Portfolio Performance transactions export. Throws if the header is
 * unusable; individual malformed rows are returned in `errors`.
 */
export function parsePortfolioPerformanceCsv(
  text: string,
  options: PpParseOptions = {},
): PpParseResult {
  const table = parseCsv(text);
  const index = columnIndex(table.header, HEADER_ALIASES);
  requireColumns(index, ["date", "type", "value"]);
  const numberFormat = options.numberFormat ?? inferNumberFormat(table.header);
  const read = cellReader(table.header, index);

  return {
    numberFormat,
    ...parseRows(table, (record): PpParsedRow => {
      const { columns, get } = read(record.cells);
      const rawDate = get("date");
      if (rawDate === undefined) {
        throw new PpRowParseError("missing date");
      }
      const value = parseLocalizedDecimal(get("value"), numberFormat);
      if (value === undefined) {
        throw new PpRowParseError("missing value");
      }
      const currency = readCurrency(get, options);
      const { hasSecurity, ...security } = readSecurityColumns(get);
      const type = resolveTransferType(parseEventType(get("type") ?? ""), hasSecurity);
      if (isSecurityTransactionType(type) && !hasSecurity) {
        throw new PpRowParseError(`${type} row has no security identifier`);
      }
      // Exports may carry the sign or not; the type decides the direction. A
      // negative value on an inflow type (e.g. a negative dividend) contradicts
      // the type and is reported rather than silently flipped.
      if (isNegativeDecimal(value) && cashDirectionFor(type) === "inflow") {
        throw new PpRowParseError(
          `negative value ${JSON.stringify(get("value"))} on inflow type ${type}`,
        );
      }
      const grossAmount = parseLocalizedDecimal(get("grossAmount"), numberFormat);
      return {
        line: record.line,
        type,
        date: parseLocalizedDate(rawDate, numberFormat),
        value: absDecimal(value),
        currency,
        grossAmount: grossAmount === undefined ? undefined : absDecimal(grossAmount),
        grossCurrency: get("grossCurrency")?.toUpperCase(),
        exchangeRate: parseLocalizedDecimal(get("exchangeRate"), numberFormat),
        fees: absDecimal(parseLocalizedDecimal(get("fees"), numberFormat) ?? "0"),
        taxes: absDecimal(parseLocalizedDecimal(get("taxes"), numberFormat) ?? "0"),
        shares: parseLocalizedDecimal(get("shares"), numberFormat),
        ...security,
        note: get("note"),
        cashAccount: get("cashAccount"),
        securitiesAccount: get("securitiesAccount"),
        columns,
      };
    }),
  };
}

/**
 * Parses a Portfolio Performance holdings (statement of assets) export into
 * per-position market values. The export has no date column; the caller
 * supplies the `asOf` date when creating snapshots.
 */
export function parsePortfolioPerformanceHoldingsCsv(
  text: string,
  options: PpParseOptions = {},
): PpHoldingsParseResult {
  const table = parseCsv(text);
  const index = columnIndex(table.header, HOLDINGS_HEADER_ALIASES);
  requireColumns(index, ["marketValue"]);
  const numberFormat = options.numberFormat ?? inferNumberFormat(table.header);
  const read = cellReader(table.header, index);

  return {
    numberFormat,
    ...parseRows(table, (record): PpParsedHolding => {
      const { columns, get } = read(record.cells);
      const marketValue = parseLocalizedDecimal(get("marketValue"), numberFormat);
      if (marketValue === undefined) {
        throw new PpRowParseError("missing market value");
      }
      const currency = readCurrency(get, options);
      const { hasSecurity, ...security } = readSecurityColumns(get);
      if (!hasSecurity) {
        throw new PpRowParseError("holding row has no security identifier");
      }
      return {
        line: record.line,
        ...security,
        shares: parseLocalizedDecimal(get("shares"), numberFormat),
        marketValue,
        currency,
        securitiesAccount: get("securitiesAccount"),
        columns,
      };
    }),
  };
}
