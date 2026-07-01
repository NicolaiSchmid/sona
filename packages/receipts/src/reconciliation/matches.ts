/**
 * Normalized inputs and outputs for receipt ↔ transaction matching. These are
 * deliberately independent of any DB implementation so scoring can be tested in
 * isolation.
 */
import type { JsonValue } from "@sona/core";

/** A bank transaction, as far as matching is concerned. */
export interface MatchableTransaction {
  id: string;
  /** Signed decimal string (negative = outflow). */
  amount: string;
  currency: string;
  /** ISO YYYY-MM-DD. */
  bookedOn: string | undefined;
  valueDate: string | undefined;
  counterpartyName: string | undefined;
  remittanceInfo: string | undefined;
  /** Ledger account the transaction is (tentatively) booked against. */
  account: string | undefined;
  /** 0..1 confidence in the source's reliability. */
  sourceReliability: number | undefined;
}

/** A document/receipt, as far as matching is concerned. */
export interface MatchableDocument {
  id: string;
  /** Gross total as a positive decimal string. */
  totalAmount: string | undefined;
  currency: string | undefined;
  documentDate: string | undefined;
  dueDate: string | undefined;
  vendorName: string | undefined;
  invoiceNumber: string | undefined;
  paymentReference: string | undefined;
  /** Extraction confidence in [0, 1]. */
  confidence: number | undefined;
  sourceReliability: number | undefined;
}

/** An explainable score for a (transaction, document) pair. */
export interface MatchScore {
  /** Composite score in [0, 1]. */
  score: number;
  /** Whether the absolute amounts matched exactly. */
  exactAmount: boolean;
  /** Absolute day distance between booking and document dates, if both known. */
  dateDistanceDays: number | undefined;
  /** Positive signals that contributed to the score. */
  reasons: string[];
  /** Hard reasons this pair cannot match (e.g. currency mismatch). */
  blockers: string[];
}

/** How a scored candidate resolved. Mirrors docs/receipt-reconciliation output states. */
export type MatchOutcome = "auto_match" | "review" | "candidate" | "no_match";

export interface MatchCandidate {
  id: string;
  workspaceId: string;
  transactionId: string;
  documentId: string;
  score: number;
  reasons: JsonValue;
  blockers: JsonValue;
  outcome: MatchOutcome;
  createdAt: string;
}

export type MatchDecisionKind = "approved" | "rejected" | "adjusted";

export interface MatchDecision {
  id: string;
  workspaceId: string;
  candidateId: string;
  decision: MatchDecisionKind;
  actor: string;
  notes: string | undefined;
  createdAt: string;
}
