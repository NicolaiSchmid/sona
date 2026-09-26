/**
 * ELSTER-oriented draft mapping model.
 *
 * A mapping is configurable data, like a tax template: it groups export
 * sections into Anlage-level line groupings whose totals a user copies into
 * the official forms by hand. It never asserts that a grouping is legally
 * correct or that an amount is deductible, and nothing in this module can
 * transmit anything — the output is a document for review.
 */
import type { ReviewState } from "@sona/core";

/**
 * One Anlage-level line grouping. An export line joins the first group whose
 * `sectionIds` contain its section and — when `accountPatterns` is set — whose
 * patterns match its ledger account (`*` suffix glob, as in templates).
 */
export interface ElsterLineGroup {
  /** Stable id, e.g. "anlage_v_income". */
  id: string;
  /** Official form the grouping prepares values for, e.g. "Anlage V". */
  anlage: string;
  /** Neutral label of the line grouping; must not claim a legal outcome. */
  lineLabel: string;
  /** What the user should verify before copying the total. */
  description: string;
  /** Template section ids feeding this grouping. */
  sectionIds: readonly string[];
  /** Optional refinement inside a section, e.g. income vs. expense accounts. */
  accountPatterns?: readonly string[];
}

export interface ElsterDraftMapping {
  id: string;
  /** Template the section ids refer to. */
  templateId: string;
  /** Bumped on every change so a rendered draft names the rules it used. */
  version: number;
  /** First tax year the mapping applies to (inclusive). */
  minTaxYear: number;
  /** Last tax year the mapping applies to (inclusive); open-ended when omitted. */
  maxTaxYear?: number;
  groups: readonly ElsterLineGroup[];
}

/** Trace of one export line inside a grouping: posting, transaction, evidence. */
export interface ElsterDraftLine {
  /** Export line id; the same posting id keys `tax-categories.csv`. */
  exportLineId: string;
  postingId: string;
  transactionId: string;
  date: string;
  description: string;
  amount: string;
  currency: string;
  account: string;
  sectionId: string;
  reviewState: ReviewState;
  evidenceDocumentIds: readonly string[];
  /** Review flags carried over from the export line, e.g. "missing evidence". */
  flags: readonly string[];
}

export interface ElsterDraftTotal {
  currency: string;
  amount: string;
}

export interface ElsterDraftGroup {
  groupId: string;
  anlage: string;
  lineLabel: string;
  description: string;
  /** One total per currency; a group with mixed currencies never sums across them. */
  totals: readonly ElsterDraftTotal[];
  lines: readonly ElsterDraftLine[];
}

/** Reviewed lines whose section no grouping claims; listed, never dropped. */
export interface ElsterUnmappedSection {
  sectionId: string;
  sectionTitle: string;
  totals: readonly ElsterDraftTotal[];
  lines: readonly ElsterDraftLine[];
}

export interface ElsterExcludedPosting {
  postingId: string;
  reason: string;
}

export interface ElsterDraft {
  year: number;
  templateId: string;
  mappingId: string;
  mappingVersion: number;
  /** Minimum review state a line needed to enter the draft. */
  requiredReviewState: ReviewState;
  groups: readonly ElsterDraftGroup[];
  unmapped: readonly ElsterUnmappedSection[];
  excluded: readonly ElsterExcludedPosting[];
}
