/**
 * Investment evidence for the capital-income section of a tax export.
 *
 * Portfolio drafts already flow through the regular posting → export-line path
 * once reviewed. This additive section preserves what those lines cannot: the
 * security, the gross amount in its original currency, the raw source record,
 * and whether a dividend's deducted tax is *suggested* to be foreign
 * withholding. Sona does not decide creditability or deductibility here — every
 * row is flagged "review required" until a human has reviewed it.
 */
import {
  meetsReviewState,
  type PortfolioDraftTransaction,
  type PortfolioEvent,
  type PortfolioLedgerAccounts,
  type ReviewState,
  suggestsForeignWithholding,
} from "@sona/core";
import { type GenerateOptions, requiredReviewState, sectionForAccount } from "./generate.js";
import type { TaxTemplate } from "./types.js";

export const INVESTMENT_EVIDENCE_KINDS = [
  "dividend",
  "interest",
  /** Standalone or income-related fee (custody, account fees). */
  "investment_fee",
  /** Fee on a position movement (buy/sell/delivery/transfer); acquisition or disposal cost, not a period expense. */
  "transaction_cost",
  "withholding_tax",
] as const;

export type InvestmentEvidenceKind = (typeof INVESTMENT_EVIDENCE_KINDS)[number];

/** One capital-income-relevant leg of a portfolio draft, with full provenance. */
export interface InvestmentEvidenceInput {
  kind: InvestmentEvidenceKind;
  /** ISO YYYY-MM-DD. */
  date: string;
  description: string;
  /** Signed decimal string of the ledger leg. */
  amount: string;
  currency: string;
  /** Ledger account of the leg; the export section is derived from it. */
  account: string;
  grossAmount: string | undefined;
  grossCurrency: string | undefined;
  isin: string | undefined;
  securityName: string | undefined;
  brokerAccountExternalId: string;
  /** Ledger provenance. */
  postingId: string;
  transactionId: string;
  /** Source provenance. */
  eventExternalId: string;
  rawRecordId: string;
  reviewState: ReviewState;
  /** Heuristic suggestion only; never a determination. */
  foreignWithholdingSuggested: boolean;
}

export interface InvestmentEvidenceRow extends InvestmentEvidenceInput {
  /** Template section of the leg's account — the same mapping tax-categories.csv uses. */
  sectionId: string;
  notes: string;
}

export interface InvestmentEvidenceResult {
  rows: InvestmentEvidenceRow[];
  excluded: Array<{ postingId: string; reason: string }>;
}

function notesFor(input: InvestmentEvidenceInput): string {
  const notes: string[] = [];
  if (input.foreignWithholdingSuggested) {
    notes.push("foreign withholding suggested (heuristic)");
  }
  if (input.kind === "investment_fee") {
    notes.push("configured investment fee account");
  }
  if (input.kind === "transaction_cost") {
    notes.push("trade fee (acquisition/disposal cost)");
  }
  if (!meetsReviewState(input.reviewState, "user_reviewed")) {
    notes.push("review required");
  }
  return notes.join("; ");
}

/**
 * Applies the same review gate as export lines: a draft export includes
 * `suggested` evidence, a final export only `user_reviewed` or better. The
 * section comes from the same template mapping as tax-categories.csv, so both
 * files agree on where a posting belongs.
 */
export function generateInvestmentEvidenceRows(
  inputs: readonly InvestmentEvidenceInput[],
  template: TaxTemplate,
  options: GenerateOptions,
): InvestmentEvidenceResult {
  const required = requiredReviewState(options.mode);
  const rows: InvestmentEvidenceRow[] = [];
  const excluded: InvestmentEvidenceResult["excluded"] = [];
  for (const input of inputs) {
    if (!meetsReviewState(input.reviewState, required)) {
      excluded.push({
        postingId: input.postingId,
        reason: `review state "${input.reviewState}" below required "${required}"`,
      });
      continue;
    }
    rows.push({
      ...input,
      sectionId: sectionForAccount(template, input.account).id,
      notes: notesFor(input),
    });
  }
  return { rows, excluded };
}

export interface InvestmentEvidenceFromDraftInput {
  event: PortfolioEvent;
  /** The draft as generated; its legs supply posting ids and amounts. */
  draft: PortfolioDraftTransaction;
  /**
   * Current review state of the persisted ledger transaction. Drafts are born
   * `draft`; only a human review moves them past the export gate, so the
   * caller passes the state as stored, never the draft's initial value.
   */
  reviewState: ReviewState;
  accounts: PortfolioLedgerAccounts;
  rawRecordId: string;
  /** Home country for the foreign-withholding suggestion; defaults to "DE". */
  homeCountry?: string;
}

/**
 * Extracts the capital-income-relevant legs (income, fees, taxes withheld)
 * from a portfolio draft so each export row points at a real posting id.
 * Returns an empty list for events with no such legs (buys, deposits, …).
 */
export function investmentEvidenceFromDraft(
  input: InvestmentEvidenceFromDraftInput,
): InvestmentEvidenceInput[] {
  const { event, draft, accounts } = input;
  const trade = event.kind === "security_transaction" ? event : undefined;
  const foreignWithholdingSuggested =
    trade !== undefined && suggestsForeignWithholding(trade, input.homeCountry);
  const base = {
    date: draft.bookedOn,
    description: draft.description,
    grossAmount: trade?.gross?.amount,
    grossCurrency: trade?.gross?.commodity,
    isin: event.security?.isin,
    securityName: event.security?.name,
    brokerAccountExternalId: event.brokerAccountExternalId,
    transactionId: draft.id,
    eventExternalId: event.externalId,
    rawRecordId: input.rawRecordId,
    reviewState: input.reviewState,
  };
  // First configured account to match wins, should two share a path.
  const kindByAccount = [
    [accounts.dividends, "dividend"],
    [accounts.interest, "interest"],
    [accounts.fees, "investment_fee"],
    [accounts.tradeCosts, "transaction_cost"],
    [accounts.taxesWithheld, "withholding_tax"],
  ] as const satisfies ReadonlyArray<readonly [string, InvestmentEvidenceKind]>;

  const rows: InvestmentEvidenceInput[] = [];
  for (const posting of draft.postings) {
    const kind = kindByAccount.find(([account]) => account === posting.account)?.[1];
    if (kind === undefined) {
      continue;
    }
    rows.push({
      ...base,
      kind,
      amount: posting.amount.amount,
      currency: posting.amount.commodity,
      account: posting.account,
      postingId: posting.id,
      foreignWithholdingSuggested: kind === "withholding_tax" && foreignWithholdingSuggested,
    });
  }
  return rows;
}
