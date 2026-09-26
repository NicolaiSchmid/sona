/**
 * Depreciation schedule section of the tax export (AfA preparation).
 *
 * Every row names the asset, the schedule configuration version, and the
 * generated ledger transaction/postings (when they exist), so an exported
 * amount is traceable back to the configured rule and its evidence documents.
 *
 * Review gate: a `final` package only contains years whose generated
 * transaction is at least `user_reviewed` AND whose recorded amount still
 * equals the recomputed schedule — a reviewed amount is never silently
 * replaced by a recomputation. A `draft` package lists every scheduled row
 * for the year — including years not yet generated, still in `draft`, or
 * drifted from their recording — each labelled with its status and "review
 * required". Amounts are always the output of a configured rule, never a
 * statement about what is deductible.
 */
import {
  type AssetKind,
  type DepreciationRowNote,
  type DepreciationSchedule,
  depreciationBookedOn,
  describeDepreciationMethod,
  type MoneyAmount,
  meetsReviewState,
  moneyAmountsEqual,
  type ReviewState,
} from "@sona/core";
import { REQUIRED_STATE } from "./generate.js";
import type { MissingEvidenceRow } from "./missing-evidence.js";
import type { ExportMode } from "./types.js";

/**
 * A generated depreciation transaction for one schedule year, as recorded in
 * the ledger (amount and config version at generation time, current review state).
 */
export interface DepreciationTransactionRef {
  year: number;
  transactionId: string;
  /** Posting ids of the transaction, expense posting first. */
  postingIds: string[];
  /** Debit amount actually booked on the expense posting. */
  amount: MoneyAmount;
  /** Schedule configuration version the transaction was generated from. */
  configVersion: number;
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

/**
 * Review state of the live generated transaction, or the process state
 * `not_generated` when no transaction exists for the year yet. Superseded
 * transactions are ignored, so they never surface here.
 */
export type DepreciationRowStatus = Exclude<ReviewState, "superseded"> | "not_generated";

/** A transaction ref whose review state is not `superseded`. */
type LiveDepreciationTransactionRef = DepreciationTransactionRef & {
  reviewState: Exclude<ReviewState, "superseded">;
};

export interface DepreciationExportRow {
  assetId: string;
  assetName: string;
  assetKind: AssetKind;
  year: number;
  configId: string;
  configVersion: number;
  /** Human-readable configured method, e.g. "linear 2 % per year". */
  configuredMethod: string;
  monthsInService: number;
  depreciableBasis: string;
  openingBookValue: string;
  /** Amount from the recomputed schedule under the current configuration. */
  amount: string;
  closingBookValue: string;
  currency: string;
  transactionId: string | undefined;
  postingIds: string[];
  /** Amount booked on the recorded transaction, if one exists. */
  recordedAmount: string | undefined;
  /** Configuration version the recorded transaction was generated from, if any. */
  recordedConfigVersion: number | undefined;
  status: DepreciationRowStatus;
  evidenceDocumentIds: string[];
  notes: string;
}

/** A scheduled or recorded year left out of a final export, and why. */
export interface ExcludedDepreciationYear {
  assetId: string;
  year: number;
  transactionId: string | undefined;
  reason: string;
}

export interface DepreciationSectionOptions {
  year: number;
  mode: ExportMode;
}

export interface DepreciationSectionResult {
  rows: DepreciationExportRow[];
  excluded: ExcludedDepreciationYear[];
  /** Rows with an unsubstantiated contributor, in the shape of the missing-evidence report. */
  missingEvidence: MissingEvidenceRow[];
}

const ROW_NOTE_LABELS = {
  pro_rata: "pro rata",
  final_remainder: "final remainder",
  disposal_year: "disposal year",
  post_completion_improvement: "improvement after full depreciation",
} as const satisfies Record<DepreciationRowNote, string>;

/**
 * Why a scheduled year is not yet final-export ready, or `undefined` if its
 * generated transaction meets the final review gate and still matches the
 * recomputed schedule.
 */
function reviewGap(
  transaction: DepreciationTransactionRef | undefined,
  schedule: Pick<DepreciationSchedule, "configVersion" | "commodity">,
  scheduledAmount: string,
): string | undefined {
  const required = REQUIRED_STATE.final;
  if (transaction === undefined) {
    return "no depreciation transaction generated yet";
  }
  if (!meetsReviewState(transaction.reviewState, required)) {
    return `review state "${transaction.reviewState}" below required "${required}"`;
  }
  // An approval is bound to the configuration it was given under: a new
  // version (method, accounts, residual) needs a fresh review even if the
  // amount happens to be unchanged.
  if (transaction.configVersion !== schedule.configVersion) {
    return `recorded under config v${transaction.configVersion} (${transaction.amount.amount} ${transaction.amount.commodity}); current schedule is v${schedule.configVersion} (${scheduledAmount} ${schedule.commodity}); review required`;
  }
  if (
    !moneyAmountsEqual(transaction.amount, {
      amount: scheduledAmount,
      commodity: schedule.commodity,
    })
  ) {
    return `recorded amount ${transaction.amount.amount} ${transaction.amount.commodity} differs from configured schedule ${scheduledAmount} ${schedule.commodity}; adjustment review required`;
  }
  return undefined;
}

/**
 * Where an exported depreciation row lives in the evidence reports: its ledger
 * transaction/posting once generated, otherwise the stable placeholder
 * `schedule:<configId>:<year>` so a not-yet-generated year is still addressable.
 */
export function depreciationRowReference(
  row: Pick<
    DepreciationExportRow,
    "assetId" | "configId" | "year" | "transactionId" | "postingIds"
  >,
): Pick<MissingEvidenceRow, "postingId" | "transactionId" | "account" | "sectionId"> {
  const placeholder = `schedule:${row.configId}:${row.year}`;
  return {
    postingId: row.postingIds[0] ?? placeholder,
    transactionId: row.transactionId ?? placeholder,
    account: `asset:${row.assetId}`,
    sectionId: "depreciation",
  };
}

export function generateDepreciationSection(
  inputs: readonly DepreciationScheduleExportInput[],
  options: DepreciationSectionOptions,
): DepreciationSectionResult {
  const result: DepreciationSectionResult = { rows: [], excluded: [], missingEvidence: [] };

  for (const input of inputs) {
    const { schedule } = input;
    const live = input.transactions.filter(
      (t): t is LiveDepreciationTransactionRef =>
        t.year === options.year && t.reviewState !== "superseded",
    );
    const [transaction] = live;
    const row = schedule.rows.find((r) => r.year === options.year);
    if (row === undefined) {
      if (transaction !== undefined) {
        // The ledger still carries a year the current configuration no longer
        // schedules (disposal, shorter life). Surface it rather than dropping it.
        result.excluded.push({
          assetId: input.assetId,
          year: options.year,
          transactionId: transaction.transactionId,
          reason: `recorded transaction is outside the current schedule (config v${schedule.configVersion}); adjustment review required`,
        });
      }
      continue;
    }

    const status: DepreciationRowStatus = transaction?.reviewState ?? "not_generated";
    const gap =
      live.length > 1
        ? `more than one live transaction recorded for this year (${live.map((t) => t.transactionId).join(", ")}); review required`
        : reviewGap(transaction, schedule, row.amount);
    if (options.mode === "final" && gap !== undefined) {
      result.excluded.push({
        assetId: input.assetId,
        year: options.year,
        transactionId: transaction?.transactionId,
        reason: gap,
      });
      continue;
    }

    const method = describeDepreciationMethod(schedule.method);
    // Every cost feeding the row must be substantiated, not just some of them.
    const missingEvidence = row.missingEvidenceFor.length > 0;
    const notes = [
      `suggested amount from configured rule v${schedule.configVersion} (${method})`,
      ...(gap !== undefined ? [gap, "review required"] : []),
      ...(missingEvidence ? [`missing evidence for ${row.missingEvidenceFor.join(", ")}`] : []),
      ...row.notes.map((n) => ROW_NOTE_LABELS[n]),
    ].join("; ");

    const exportRow: DepreciationExportRow = {
      assetId: input.assetId,
      assetName: input.assetName,
      assetKind: input.assetKind,
      year: row.year,
      configId: schedule.configId,
      configVersion: schedule.configVersion,
      configuredMethod: method,
      monthsInService: row.monthsInService,
      depreciableBasis: row.depreciableBasis,
      openingBookValue: row.openingBookValue,
      amount: row.amount,
      closingBookValue: row.closingBookValue,
      currency: schedule.commodity,
      transactionId: transaction?.transactionId,
      postingIds: transaction?.postingIds ?? [],
      recordedAmount: transaction?.amount.amount,
      recordedConfigVersion: transaction?.configVersion,
      status,
      evidenceDocumentIds: row.evidenceDocumentIds,
      notes,
    };
    result.rows.push(exportRow);

    if (missingEvidence) {
      result.missingEvidence.push({
        ...depreciationRowReference(exportRow),
        date: depreciationBookedOn(schedule, row.year),
        amount: row.amount,
        currency: schedule.commodity,
      });
    }
  }

  return result;
}
