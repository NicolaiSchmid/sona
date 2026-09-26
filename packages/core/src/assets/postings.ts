/**
 * Annual depreciation postings.
 *
 * Each schedule row becomes one balanced double-entry transaction in `draft`
 * review state: the configured expense account is debited (positive amount)
 * and the configured accumulated-depreciation contra-asset account is credited
 * (negative amount). Drafts always require human review — nothing here
 * approves, suggests, or exports.
 *
 * Generation is idempotent per asset-year: rows that already have a recorded
 * transaction are skipped, never rewritten. If a recomputed schedule disagrees
 * with an already-recorded year, the difference is reported so the user can
 * decide on an explicit adjustment posting.
 */
import type { EvidenceLink } from "../evidence/types";
import { validateBalancedTransaction } from "../ledger/balance";
import type { LedgerPosting, LedgerTransaction } from "../ledger/types";
import { isZeroDecimal, sumDecimals } from "../money/decimal";
import type { MoneyAmount } from "../money/types";
import type { ReviewState } from "../review/types";
import {
  type DepreciationSchedule,
  type DepreciationScheduleRow,
  describeDepreciationMethod,
} from "./schedule";
import type { Asset, DepreciationScheduleConfig } from "./types";

/** Evidence-graph record type names used for asset-related links. */
export const ASSET_RECORD_TYPES = {
  asset: "asset",
  scheduleConfig: "asset_depreciation_schedule",
  document: "document",
  ledgerTransaction: "ledger_transaction",
} as const;

/**
 * Deterministic transaction id for an asset-year under a configuration
 * version. Deterministic ids make regeneration reproducible; idempotency is
 * still enforced per asset-year via {@link planDepreciationDrafts}.
 */
export function depreciationTransactionId(
  assetId: string,
  configVersion: number,
  year: number,
): string {
  return `depr:${assetId}:v${configVersion}:${year}`;
}

export interface DepreciationDraft {
  assetId: string;
  year: number;
  configId: string;
  configVersion: number;
  transaction: LedgerTransaction;
  evidenceLinks: EvidenceLink[];
}

export interface BuildDepreciationDraftInput {
  asset: Asset;
  config: DepreciationScheduleConfig;
  schedule: DepreciationSchedule;
  row: DepreciationScheduleRow;
  /** ISO timestamp recorded as `createdAt` on the transaction and links. */
  createdAt: string;
}

/** Booking date: the disposal date in a disposal year, otherwise 31 December. */
function bookedOnFor(schedule: DepreciationSchedule, row: DepreciationScheduleRow): string {
  if (schedule.disposedOn?.startsWith(`${row.year}-`)) {
    return schedule.disposedOn;
  }
  return `${row.year}-12-31`;
}

export function buildDepreciationDraft(input: BuildDepreciationDraftInput): DepreciationDraft {
  const { asset, config, schedule, row } = input;
  if (schedule.assetId !== asset.id || schedule.configId !== config.id) {
    throw new Error(`Schedule does not belong to asset ${asset.id} / config ${config.id}`);
  }
  const transactionId = depreciationTransactionId(asset.id, config.version, row.year);
  const debit: MoneyAmount = { amount: row.amount, commodity: schedule.commodity };
  const credit: MoneyAmount = { amount: `-${row.amount}`, commodity: schedule.commodity };
  const memo = `configured rule v${config.version}: ${describeDepreciationMethod(config.method)}`;

  const postings: LedgerPosting[] = [
    {
      id: `${transactionId}:expense`,
      transactionId,
      account: config.expenseAccount,
      amount: debit,
      memo,
    },
    {
      id: `${transactionId}:accumulated`,
      transactionId,
      account: config.accumulatedDepreciationAccount,
      amount: credit,
      memo,
    },
  ];

  const balance = validateBalancedTransaction(postings);
  if (!balance.balanced) {
    throw new Error(
      `Depreciation draft ${transactionId} is unbalanced: ${balance.errors.join("; ")}`,
    );
  }

  const transaction: LedgerTransaction = {
    id: transactionId,
    workspaceId: asset.workspaceId,
    bookedOn: bookedOnFor(schedule, row),
    description: `Suggested depreciation ${row.year}: ${asset.name} (configured schedule v${config.version}, review required)`,
    postings,
    reviewState: "draft",
    createdAt: input.createdAt,
  };

  const evidenceLinks: EvidenceLink[] = [
    {
      id: `${transactionId}:link:schedule`,
      workspaceId: asset.workspaceId,
      fromType: ASSET_RECORD_TYPES.ledgerTransaction,
      fromId: transactionId,
      toType: ASSET_RECORD_TYPES.scheduleConfig,
      toId: config.id,
      kind: "generated_from",
      notes: `asset ${asset.id}, year ${row.year}, schedule config v${config.version}`,
      createdAt: input.createdAt,
    },
    ...row.evidenceDocumentIds.map(
      (documentId): EvidenceLink => ({
        id: `${transactionId}:link:doc:${documentId}`,
        workspaceId: asset.workspaceId,
        fromType: ASSET_RECORD_TYPES.document,
        fromId: documentId,
        toType: ASSET_RECORD_TYPES.ledgerTransaction,
        toId: transactionId,
        kind: "substantiates",
        createdAt: input.createdAt,
      }),
    ),
  ];

  return {
    assetId: asset.id,
    year: row.year,
    configId: config.id,
    configVersion: config.version,
    transaction,
    evidenceLinks,
  };
}

/** A depreciation transaction already recorded for an asset-year. */
export interface RecordedDepreciation {
  year: number;
  transactionId: string;
  amount: MoneyAmount;
  reviewState: ReviewState;
}

export interface SkippedDepreciationYear {
  year: number;
  transactionId: string;
  reason: "already_recorded";
}

/** A recorded year whose amount no longer matches the recomputed schedule. */
export interface DepreciationDiscrepancy {
  year: number;
  transactionId: string;
  recordedAmount: string;
  scheduledAmount: string;
  reviewState: ReviewState;
  /** Never auto-corrected: the user decides on an explicit adjustment posting. */
  resolution: "adjustment_posting_required";
}

export interface DepreciationPlan {
  create: DepreciationDraft[];
  skipped: SkippedDepreciationYear[];
  discrepancies: DepreciationDiscrepancy[];
}

export interface PlanDepreciationDraftsInput {
  asset: Asset;
  config: DepreciationScheduleConfig;
  schedule: DepreciationSchedule;
  /** Already-recorded depreciation transactions for this asset (any config version). */
  recorded: readonly RecordedDepreciation[];
  /** Last year to generate drafts for, inclusive (typically the current or export year). */
  throughYear: number;
  createdAt: string;
}

/**
 * Decides which schedule rows still need a draft transaction. Years with a
 * live (non-superseded) recorded transaction are skipped regardless of review
 * state, so reviewed postings are never modified by recomputation.
 */
export function planDepreciationDrafts(input: PlanDepreciationDraftsInput): DepreciationPlan {
  const live = new Map<number, RecordedDepreciation>();
  for (const entry of input.recorded) {
    if (entry.reviewState !== "superseded") {
      live.set(entry.year, entry);
    }
  }

  const plan: DepreciationPlan = { create: [], skipped: [], discrepancies: [] };
  for (const row of input.schedule.rows) {
    if (row.year > input.throughYear) {
      break;
    }
    const existing = live.get(row.year);
    if (existing === undefined) {
      plan.create.push(
        buildDepreciationDraft({
          asset: input.asset,
          config: input.config,
          schedule: input.schedule,
          row,
          createdAt: input.createdAt,
        }),
      );
      continue;
    }
    plan.skipped.push({
      year: row.year,
      transactionId: existing.transactionId,
      reason: "already_recorded",
    });
    const sameAmount =
      existing.amount.commodity === input.schedule.commodity &&
      isZeroDecimal(sumDecimals([existing.amount.amount, `-${row.amount}`]));
    if (!sameAmount) {
      plan.discrepancies.push({
        year: row.year,
        transactionId: existing.transactionId,
        recordedAmount: existing.amount.amount,
        scheduledAmount: row.amount,
        reviewState: existing.reviewState,
        resolution: "adjustment_posting_required",
      });
    }
  }
  return plan;
}
