/**
 * Depreciation schedule section of the tax export (AfA preparation).
 *
 * Every row names the asset, the schedule configuration version, and the
 * generated ledger transaction/postings (when they exist), so an exported
 * amount is traceable back to the configured rule and its evidence documents.
 *
 * Review gate: a `final` package only contains years whose generated
 * transaction is at least `user_reviewed`. A `draft` package lists every
 * scheduled row for the year — including years not yet generated or still in
 * `draft` — each labelled with its status and "review required", so the user
 * can see what is planned and what still needs work. Amounts are always the
 * output of a configured rule, never a statement about what is deductible.
 */
import {
  type AssetKind,
  type DepreciationSchedule,
  describeDepreciationMethod,
  meetsReviewState,
  type ReviewState,
} from "@sona/core";
import type { MissingEvidenceRow } from "./missing-evidence.js";
import type { ExportMode } from "./types.js";

/** A generated depreciation transaction for one schedule year. */
export interface DepreciationTransactionRef {
  year: number;
  transactionId: string;
  postingIds: string[];
  reviewState: ReviewState;
}

export interface DepreciationScheduleExportInput {
  assetId: string;
  assetName: string;
  assetKind: AssetKind;
  schedule: DepreciationSchedule;
  /** Transactions generated so far for this asset (any year). */
  transactions: readonly DepreciationTransactionRef[];
}

/** Review state of the generated transaction, or `not_generated` if none exists yet. */
export type DepreciationRowStatus = ReviewState | "not_generated";

export interface DepreciationExportRow {
  assetId: string;
  assetName: string;
  assetKind: AssetKind;
  year: number;
  scheduleConfigId: string;
  scheduleVersion: number;
  /** Human-readable configured method, e.g. "linear 2 % per year". */
  configuredMethod: string;
  monthsInService: number;
  depreciableBasis: string;
  openingBookValue: string;
  amount: string;
  closingBookValue: string;
  currency: string;
  transactionId: string | undefined;
  postingIds: string[];
  status: DepreciationRowStatus;
  evidenceDocumentIds: string[];
  notes: string;
}

export interface DepreciationSectionOptions {
  year: number;
  mode: ExportMode;
}

export interface DepreciationSectionResult {
  rows: DepreciationExportRow[];
  /** Scheduled years left out of this export mode and why. */
  excluded: Array<{ assetId: string; year: number; reason: string }>;
  /** Rows with no evidence document, in the shape of the missing-evidence report. */
  missingEvidence: MissingEvidenceRow[];
}

/** Minimum status a row must reach to appear in a final export. */
const FINAL_REQUIRED_STATE: ReviewState = "user_reviewed";

/** Reference used in reports for a scheduled year that has no transaction yet. */
function scheduleReference(configId: string, year: number): string {
  return `schedule:${configId}:${year}`;
}

export function generateDepreciationSection(
  inputs: readonly DepreciationScheduleExportInput[],
  options: DepreciationSectionOptions,
): DepreciationSectionResult {
  const result: DepreciationSectionResult = { rows: [], excluded: [], missingEvidence: [] };

  for (const input of inputs) {
    const { schedule } = input;
    const row = schedule.rows.find((r) => r.year === options.year);
    if (row === undefined) {
      continue;
    }
    const transaction = input.transactions.find(
      (t) => t.year === options.year && t.reviewState !== "superseded",
    );
    const status: DepreciationRowStatus = transaction?.reviewState ?? "not_generated";

    if (options.mode === "final") {
      if (transaction === undefined) {
        result.excluded.push({
          assetId: input.assetId,
          year: options.year,
          reason: "no depreciation transaction generated yet",
        });
        continue;
      }
      if (!meetsReviewState(transaction.reviewState, FINAL_REQUIRED_STATE)) {
        result.excluded.push({
          assetId: input.assetId,
          year: options.year,
          reason: `review state "${transaction.reviewState}" below required "${FINAL_REQUIRED_STATE}"`,
        });
        continue;
      }
    }

    const method = describeDepreciationMethod(schedule.method);
    const reviewRequired = !meetsReviewState(
      status === "not_generated" ? "draft" : status,
      FINAL_REQUIRED_STATE,
    );
    const missingEvidence = row.evidenceDocumentIds.length === 0;
    const notes = [
      `suggested amount from configured rule v${schedule.configVersion} (${method})`,
      ...(reviewRequired ? ["review required"] : []),
      ...(missingEvidence ? ["missing evidence"] : []),
      ...row.notes.map((n) => n.replace(/_/g, " ")),
    ].join("; ");

    result.rows.push({
      assetId: input.assetId,
      assetName: input.assetName,
      assetKind: input.assetKind,
      year: row.year,
      scheduleConfigId: schedule.configId,
      scheduleVersion: schedule.configVersion,
      configuredMethod: method,
      monthsInService: row.monthsInService,
      depreciableBasis: row.depreciableBasis,
      openingBookValue: row.openingBookValue,
      amount: row.amount,
      closingBookValue: row.closingBookValue,
      currency: schedule.commodity,
      transactionId: transaction?.transactionId,
      postingIds: transaction?.postingIds ?? [],
      status,
      evidenceDocumentIds: row.evidenceDocumentIds,
      notes,
    });

    if (missingEvidence) {
      const reference = scheduleReference(schedule.configId, row.year);
      result.missingEvidence.push({
        postingId: transaction?.postingIds[0] ?? reference,
        transactionId: transaction?.transactionId ?? reference,
        date: `${row.year}-12-31`,
        account: `asset:${input.assetId}`,
        sectionId: "depreciation",
        amount: row.amount,
        currency: schedule.commodity,
      });
    }
  }

  return result;
}
