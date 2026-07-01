/**
 * Tax export model. Templates are configurable data that MAP user-reviewed
 * ledger categories to export sections. They must not assert legal
 * deductibility — wording stays neutral (suggested / configured / review
 * required) and humans approve tax-relevant decisions.
 */
import type { ReviewState } from "@sona/core";

export interface TaxSection {
  /** Stable id, e.g. "rental_property". */
  id: string;
  /** Neutral, preparation-oriented title. */
  title: string;
  /** Short description of what belongs here. No deductibility claims. */
  description: string;
  /** Ledger account path patterns that map to this section (`*` suffix glob). */
  accountPatterns: string[];
  /** Whether postings in this section require substantiating evidence. */
  receiptRequired: boolean;
}

export interface TaxTemplate {
  id: string;
  jurisdiction: "DE";
  audience: "private_individual";
  sections: TaxSection[];
  /** Fallback section for postings that match no configured section. */
  uncategorizedSectionId: string;
}

/** A single ledger posting, as far as tax mapping is concerned. */
export interface TaxPostingInput {
  postingId: string;
  transactionId: string;
  /** ISO YYYY-MM-DD. */
  date: string;
  description: string;
  /** Signed decimal string. */
  amount: string;
  commodity: string;
  account: string;
  reviewState: ReviewState;
  /** Ids of documents that substantiate this posting. */
  evidenceDocumentIds: string[];
}

export interface TaxExportLine {
  date: string;
  description: string;
  amount: string;
  currency: string;
  account: string;
  sectionId: string;
  sectionTitle: string;
  sourcePostingId: string;
  sourceTransactionId: string;
  evidenceDocumentIds: string[];
  reviewState: ReviewState;
  notes: string | undefined;
}

export type ExportMode = "draft" | "final";
