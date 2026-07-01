/**
 * Deterministic, explainable receipt ↔ transaction scoring. The first
 * implementation is intentionally simple and replaceable; every contribution is
 * reflected in `reasons`/`blockers` so decisions are auditable.
 */
import { isValidDecimalString, isZeroDecimal, sumDecimals } from "@sona/core";
import type { MatchableDocument, MatchableTransaction, MatchScore } from "./matches.js";

/** Score weights. They sum to 1.0 for a perfectly aligned pair. */
const WEIGHT_AMOUNT = 0.6;
const WEIGHT_DATE = 0.15;
const WEIGHT_VENDOR = 0.15;
const WEIGHT_REFERENCE = 0.1;

/** Default window (days) within which booking/document dates are "close". */
export const DEFAULT_MAX_DATE_DISTANCE_DAYS = 5;

/** Common legal-form tokens dropped from vendor comparison. */
const LEGAL_FORM_TOKENS = new Set([
  "gmbh",
  "ag",
  "kg",
  "ohg",
  "sarl",
  "ltd",
  "inc",
  "llc",
  "bv",
  "co",
]);

function negate(amount: string): string {
  return amount.startsWith("-") ? amount.slice(1) : `-${amount}`;
}

function absDecimal(amount: string): string {
  return amount.startsWith("-") ? amount.slice(1) : amount;
}

function amountsEqual(a: string, b: string): boolean {
  if (!isValidDecimalString(a) || !isValidDecimalString(b)) {
    return false;
  }
  return isZeroDecimal(sumDecimals([a, negate(b)]));
}

function parseIsoDay(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return undefined;
  }
  const [, y, m, d] = match;
  const ms = Date.UTC(Number(y), Number(m) - 1, Number(d));
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 86_400_000);
}

function dateDistanceDays(a: string | undefined, b: string | undefined): number | undefined {
  const da = parseIsoDay(a);
  const db = parseIsoDay(b);
  if (da === undefined || db === undefined) {
    return undefined;
  }
  return Math.abs(da - db);
}

function vendorTokens(name: string | undefined): Set<string> {
  if (!name) {
    return new Set();
  }
  const tokens = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 3 && !LEGAL_FORM_TOKENS.has(t));
  return new Set(tokens);
}

/** Token-overlap similarity in [0, 1] between two vendor/counterparty names. */
export function vendorSimilarity(a: string | undefined, b: string | undefined): number {
  const ta = vendorTokens(a);
  const tb = vendorTokens(b);
  if (ta.size === 0 || tb.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const token of ta) {
    if (tb.has(token)) {
      shared += 1;
    }
  }
  return shared / Math.min(ta.size, tb.size);
}

function normalizeRef(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function referenceInRemittance(doc: MatchableDocument, tx: MatchableTransaction): boolean {
  if (tx.remittanceInfo === undefined) {
    return false;
  }
  const haystack = normalizeRef(tx.remittanceInfo);
  for (const ref of [doc.invoiceNumber, doc.paymentReference]) {
    if (ref !== undefined) {
      const needle = normalizeRef(ref);
      if (needle.length >= 4 && haystack.includes(needle)) {
        return true;
      }
    }
  }
  return false;
}

export interface ScoreOptions {
  maxDateDistanceDays?: number;
}

export function scoreMatch(
  transaction: MatchableTransaction,
  document: MatchableDocument,
  options: ScoreOptions = {},
): MatchScore {
  const maxDate = options.maxDateDistanceDays ?? DEFAULT_MAX_DATE_DISTANCE_DAYS;
  const reasons: string[] = [];
  const blockers: string[] = [];
  const dateDistance = dateDistanceDays(transaction.bookedOn, document.documentDate);

  // Currency mismatch is a hard blocker.
  if (
    transaction.currency !== undefined &&
    document.currency !== undefined &&
    transaction.currency !== document.currency
  ) {
    blockers.push("currency mismatch");
    return { score: 0, exactAmount: false, dateDistanceDays: dateDistance, reasons, blockers };
  }

  let score = 0;

  let exactAmount = false;
  if (
    document.totalAmount !== undefined &&
    amountsEqual(absDecimal(transaction.amount), document.totalAmount)
  ) {
    exactAmount = true;
    score += WEIGHT_AMOUNT;
    reasons.push("exact amount");
  }

  if (dateDistance !== undefined) {
    if (dateDistance <= maxDate) {
      score += WEIGHT_DATE * (1 - dateDistance / maxDate);
      reasons.push(`date within ${dateDistance} day(s)`);
    } else {
      reasons.push(`date ${dateDistance} days apart`);
    }
  }

  const similarity = vendorSimilarity(transaction.counterpartyName, document.vendorName);
  if (similarity > 0) {
    score += WEIGHT_VENDOR * similarity;
    reasons.push("vendor similarity");
  }

  if (referenceInRemittance(document, transaction)) {
    score += WEIGHT_REFERENCE;
    reasons.push("reference in remittance");
  }

  return {
    score: Number(Math.min(1, score).toFixed(4)),
    exactAmount,
    dateDistanceDays: dateDistance,
    reasons,
    blockers,
  };
}
