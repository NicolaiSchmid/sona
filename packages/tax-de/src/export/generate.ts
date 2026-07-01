/**
 * Maps user-reviewed ledger postings to tax export lines. A draft export may
 * include `suggested` lines; a final export requires each line to be at least
 * `user_reviewed`. Every line is traceable to its posting/transaction and
 * evidence documents.
 */
import { meetsReviewState, type ReviewState } from "@sona/core";
import { matchesAccountPattern } from "./accounts.js";
import type {
  ExportMode,
  TaxExportLine,
  TaxPostingInput,
  TaxSection,
  TaxTemplate,
} from "./types.js";

/** Minimum review state a line must reach to appear in each export mode. */
const REQUIRED_STATE: Record<ExportMode, ReviewState> = {
  draft: "suggested",
  final: "user_reviewed",
};

/** Returns the first section whose patterns match the account, else uncategorized. */
export function sectionForAccount(template: TaxTemplate, account: string): TaxSection {
  for (const section of template.sections) {
    if (section.id === template.uncategorizedSectionId) {
      continue;
    }
    if (section.accountPatterns.some((pattern) => matchesAccountPattern(account, pattern))) {
      return section;
    }
  }
  const fallback = template.sections.find((s) => s.id === template.uncategorizedSectionId);
  if (fallback === undefined) {
    throw new Error(`Template ${template.id} has no uncategorized section`);
  }
  return fallback;
}

export interface GenerateOptions {
  mode: ExportMode;
}

export interface GenerateResult {
  lines: TaxExportLine[];
  /** Postings excluded from this export mode and why. */
  excluded: Array<{ postingId: string; reason: string }>;
}

export function generateExportLines(
  postings: readonly TaxPostingInput[],
  template: TaxTemplate,
  options: GenerateOptions,
): GenerateResult {
  const required = REQUIRED_STATE[options.mode];
  const lines: TaxExportLine[] = [];
  const excluded: Array<{ postingId: string; reason: string }> = [];

  for (const posting of postings) {
    if (!meetsReviewState(posting.reviewState, required)) {
      excluded.push({
        postingId: posting.postingId,
        reason: `review state "${posting.reviewState}" below required "${required}"`,
      });
      continue;
    }

    const section = sectionForAccount(template, posting.account);
    const missingEvidence = section.receiptRequired && posting.evidenceDocumentIds.length === 0;

    lines.push({
      date: posting.date,
      description: posting.description,
      amount: posting.amount,
      currency: posting.commodity,
      account: posting.account,
      sectionId: section.id,
      sectionTitle: section.title,
      sourcePostingId: posting.postingId,
      sourceTransactionId: posting.transactionId,
      evidenceDocumentIds: posting.evidenceDocumentIds,
      reviewState: posting.reviewState,
      notes: missingEvidence ? "missing evidence" : undefined,
    });
  }

  return { lines, excluded };
}
