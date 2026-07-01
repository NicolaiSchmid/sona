/**
 * Missing-evidence report: tax-relevant postings whose section requires a
 * receipt/document but which have no substantiating evidence yet.
 */
import { sectionForAccount } from "./generate.js";
import type { TaxPostingInput, TaxTemplate } from "./types.js";

export interface MissingEvidenceRow {
  postingId: string;
  transactionId: string;
  date: string;
  account: string;
  sectionId: string;
  amount: string;
  currency: string;
}

/**
 * Returns one row per posting that lands in a receipt-required section but has
 * no evidence documents. Postings in non-required sections are omitted.
 */
export function generateMissingEvidenceReport(
  postings: readonly TaxPostingInput[],
  template: TaxTemplate,
): MissingEvidenceRow[] {
  const rows: MissingEvidenceRow[] = [];
  for (const posting of postings) {
    const section = sectionForAccount(template, posting.account);
    if (section.receiptRequired && posting.evidenceDocumentIds.length === 0) {
      rows.push({
        postingId: posting.postingId,
        transactionId: posting.transactionId,
        date: posting.date,
        account: posting.account,
        sectionId: section.id,
        amount: posting.amount,
        currency: posting.commodity,
      });
    }
  }
  return rows;
}
