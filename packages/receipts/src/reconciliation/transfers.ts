/**
 * Transfer-leg matching: pairs a broker cash movement (deposit/withdrawal) with
 * the bank transaction that funded or received it. Reuses the receipt matching
 * primitives — explainable {@link MatchScore}s, the conservative
 * {@link AutoApplyPolicy}, and one-to-one set resolution — so transfer
 * decisions are auditable the same way receipt matches are. Uncertain pairs and
 * unmatched movements are emitted as review items, never silently dropped.
 */
import {
  absDecimal,
  isNegativeDecimal,
  isValidDecimalString,
  isZeroDecimal,
  type JsonValue,
  type ReviewState,
} from "@sona/core";
import type { MatchableTransaction, MatchOutcome, MatchScore } from "./matches.js";
import { type AutoApplyPolicy, decideMatch, reconcileMatchSet } from "./policies.js";
import {
  amountsEqual,
  dateDistanceDays,
  MIN_SOURCE_RELIABILITY,
  normalizeCurrency,
  type ScoreOptions,
  vendorSimilarity,
} from "./scoring.js";

/** A broker cash movement, as far as transfer matching is concerned. */
export interface MatchableCashMovement {
  id: string;
  /** Signed from the broker's perspective: deposit positive, withdrawal negative. */
  amount: string;
  currency: string;
  /** ISO YYYY-MM-DD. */
  date: string | undefined;
  /** Broker/account label to compare against the bank counterparty. */
  brokerName: string | undefined;
  note: string | undefined;
  sourceReliability: number | undefined;
}

export const TRANSFER_SCORER_VERSION = "transfer-legs@1" as const;

/** Score weights; a same-day exact transfer with a recognized broker scores 1.0. */
const WEIGHT_AMOUNT = 0.7;
const WEIGHT_DATE = 0.2;
const WEIGHT_NAME = 0.1;

/** Transfers settle fast; a wider window than this is suspicious. */
export const DEFAULT_TRANSFER_MAX_DATE_DISTANCE_DAYS = 3;

/**
 * Conservative defaults for transfer legs: exact amount, a recognizable broker
 * in the bank counterparty/remittance, and same-day booking. The composite
 * cannot be reached on amount + date alone (0.9), so an unrelated same-day
 * payment of the same amount is never auto-matched; and a one-day drift with
 * a recognized broker (0.9333) still goes to review by design — T+1 transfers
 * are common enough that a human should confirm the pairing. Large transfers
 * always go to review.
 */
export const DEFAULT_TRANSFER_AUTO_APPLY_POLICY: AutoApplyPolicy = {
  enabled: true,
  minScore: 0.95,
  requireExactAmount: true,
  maxDateDistanceDays: DEFAULT_TRANSFER_MAX_DATE_DISTANCE_DAYS,
  reviewRequiredAccounts: [],
  reviewAboveAmount: "10000",
  candidateThreshold: 0.5,
};

/** Normalized currency code, or undefined when blank (blank is "unknown", not a mismatch). */
function knownCurrency(code: string | undefined): string | undefined {
  const normalized = normalizeCurrency(code);
  return normalized === "" ? undefined : normalized;
}

function emptyScore(
  dateDistance: number | undefined,
  blockers: string[],
  warnings: string[],
): MatchScore {
  return {
    score: 0,
    exactAmount: false,
    dateDistanceDays: dateDistance,
    reasons: [],
    blockers,
    warnings,
  };
}

/**
 * Scores a bank transaction against a broker cash movement. A bank outflow can
 * only pair with a broker deposit and a bank inflow with a broker withdrawal;
 * same-direction or cross-currency pairs are blocked outright.
 */
export function scoreTransferLegs(
  transaction: MatchableTransaction,
  movement: MatchableCashMovement,
  options: ScoreOptions = {},
): MatchScore {
  const maxDate = options.maxDateDistanceDays ?? DEFAULT_TRANSFER_MAX_DATE_DISTANCE_DAYS;
  const dateDistance = dateDistanceDays(transaction.bookedOn, movement.date);
  const txCurrency = knownCurrency(transaction.currency);
  const mvCurrency = knownCurrency(movement.currency);
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (txCurrency !== undefined && mvCurrency !== undefined && txCurrency !== mvCurrency) {
    blockers.push("currency mismatch");
  }
  if (!isValidDecimalString(transaction.amount) || !isValidDecimalString(movement.amount)) {
    // Block rather than throw so one malformed row cannot abort a whole batch.
    blockers.push("invalid amount");
  } else if (isZeroDecimal(transaction.amount) || isZeroDecimal(movement.amount)) {
    blockers.push("zero amount");
  } else if (isNegativeDecimal(transaction.amount) === isNegativeDecimal(movement.amount)) {
    blockers.push("same direction: a transfer needs one outflow and one inflow leg");
  }
  if (blockers.length > 0) {
    return emptyScore(dateDistance, blockers, warnings);
  }

  if (txCurrency === undefined || mvCurrency === undefined) {
    warnings.push("unknown currency");
  }
  if (
    (movement.sourceReliability !== undefined &&
      movement.sourceReliability < MIN_SOURCE_RELIABILITY) ||
    (transaction.sourceReliability !== undefined &&
      transaction.sourceReliability < MIN_SOURCE_RELIABILITY)
  ) {
    warnings.push("low source reliability");
  }

  const reasons: string[] = [];
  let score = 0;
  const exactAmount = amountsEqual(absDecimal(transaction.amount), absDecimal(movement.amount));
  if (exactAmount) {
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
  const haystack = [transaction.counterpartyName, transaction.remittanceInfo]
    .filter((v): v is string => v !== undefined)
    .join(" ");
  const similarity = vendorSimilarity(haystack === "" ? undefined : haystack, movement.brokerName);
  if (similarity > 0) {
    score += WEIGHT_NAME * similarity;
    reasons.push("broker name in counterparty/remittance");
  }

  return {
    score: Number(Math.min(1, score).toFixed(4)),
    exactAmount,
    dateDistanceDays: dateDistance,
    reasons,
    blockers,
    warnings,
  };
}

export interface TransferLegMatch {
  bankTransactionId: string;
  cashMovementId: string;
  score: MatchScore;
  outcome: MatchOutcome;
  reasons: string[];
}

/** Structurally compatible with the persisted review item shape. */
export interface TransferReviewItem {
  id: string;
  workspaceId: string;
  targetType: "transfer_leg_match" | "portfolio_cash_movement";
  targetId: string;
  state: ReviewState;
  reason: JsonValue;
  createdAt: string;
  updatedAt: string;
}

export interface TransferReconciliationResult {
  /** Every scored pair that was not blocked, with its resolved outcome. */
  matches: TransferLegMatch[];
  /** Pairs that met the policy and are unique on both sides. */
  autoMatched: TransferLegMatch[];
  /** Review items for uncertain pairs and for movements with no counterpart. */
  reviewItems: TransferReviewItem[];
  unmatchedMovementIds: string[];
}

interface ScoredPair {
  movement: MatchableCashMovement;
  transaction: MatchableTransaction;
  score: MatchScore;
}

export interface ReconcileTransferLegsInput {
  workspaceId: string;
  transactions: readonly MatchableTransaction[];
  movements: readonly MatchableCashMovement[];
  policy?: AutoApplyPolicy;
  scoreOptions?: ScoreOptions;
  ids: () => string;
  nowIso: () => string;
}

/**
 * Reconciles broker cash movements against bank transactions. Auto-matches
 * only when the pair meets the policy and neither leg has another plausible
 * counterpart; every other plausible pair and every unmatched movement becomes
 * a review item so nothing is silently lost.
 */
export function reconcileTransferLegs(
  input: ReconcileTransferLegsInput,
): TransferReconciliationResult {
  const policy = input.policy ?? DEFAULT_TRANSFER_AUTO_APPLY_POLICY;
  // Score with the policy's window unless the caller overrides it, so scoring
  // and the auto-apply decision agree on what "in window" means.
  const scoreOptions = input.scoreOptions ?? { maxDateDistanceDays: policy.maxDateDistanceDays };
  const scored: ScoredPair[] = [];
  for (const movement of input.movements) {
    for (const transaction of input.transactions) {
      const score = scoreTransferLegs(transaction, movement, scoreOptions);
      if (score.blockers.length === 0) {
        scored.push({ movement, transaction, score });
      }
    }
  }

  // The set resolver is side-agnostic: `documentId` carries the cash-movement
  // id here so one-to-one contention is enforced for transfers as for receipts.
  const resolved = reconcileMatchSet(
    scored.map(({ movement, transaction, score }) => ({
      transactionId: transaction.id,
      documentId: movement.id,
      score,
      transaction,
      policy,
    })),
  );

  const scoreByPair = new Map(
    scored.map(({ movement, transaction, score }) => [`${transaction.id}|${movement.id}`, score]),
  );
  const matches: TransferLegMatch[] = resolved.map((r) => {
    const score = scoreByPair.get(`${r.transactionId}|${r.documentId}`);
    if (score === undefined) {
      throw new Error("resolved pair without a score");
    }
    return {
      bankTransactionId: r.transactionId,
      cashMovementId: r.documentId,
      score,
      outcome: r.outcome,
      reasons: r.reasons,
    };
  });

  const autoMatched = matches.filter((m) => m.outcome === "auto_match");
  const settledMovements = new Set(autoMatched.map((m) => m.cashMovementId));
  const now = input.nowIso();
  const reviewItems: TransferReviewItem[] = [];
  const unmatchedMovementIds: string[] = [];

  for (const movement of input.movements) {
    if (settledMovements.has(movement.id)) {
      continue;
    }
    const candidates = matches.filter(
      (m) => m.cashMovementId === movement.id && m.outcome === "review",
    );
    if (candidates.length > 0) {
      reviewItems.push({
        id: input.ids(),
        workspaceId: input.workspaceId,
        targetType: "transfer_leg_match",
        targetId: movement.id,
        state: "suggested",
        reason: {
          kind: "transfer_leg_candidates",
          scorerVersion: TRANSFER_SCORER_VERSION,
          candidates: candidates.map((c) => ({
            bankTransactionId: c.bankTransactionId,
            score: c.score.score,
            reasons: c.reasons,
          })),
        },
        createdAt: now,
        updatedAt: now,
      });
      continue;
    }
    unmatchedMovementIds.push(movement.id);
    reviewItems.push({
      id: input.ids(),
      workspaceId: input.workspaceId,
      targetType: "portfolio_cash_movement",
      targetId: movement.id,
      state: "draft",
      reason: {
        kind: "unmatched_broker_cash_movement",
        scorerVersion: TRANSFER_SCORER_VERSION,
        amount: movement.amount,
        currency: movement.currency,
        date: movement.date ?? null,
      },
      createdAt: now,
      updatedAt: now,
    });
  }

  return { matches, autoMatched, reviewItems, unmatchedMovementIds };
}

/** Convenience for a single pair: score then decide under the transfer policy. */
export function decideTransferLegs(
  transaction: MatchableTransaction,
  movement: MatchableCashMovement,
  policy: AutoApplyPolicy = DEFAULT_TRANSFER_AUTO_APPLY_POLICY,
): TransferLegMatch {
  const score = scoreTransferLegs(transaction, movement, {
    maxDateDistanceDays: policy.maxDateDistanceDays,
  });
  const decision = decideMatch({ score, transaction, policy });
  return {
    bankTransactionId: transaction.id,
    cashMovementId: movement.id,
    score,
    outcome: decision.outcome,
    reasons: decision.reasons,
  };
}
