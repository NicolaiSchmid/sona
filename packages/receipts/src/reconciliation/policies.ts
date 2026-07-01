/**
 * Conservative, configurable auto-apply policy. High-confidence matches may be
 * applied automatically, but tax-relevant or high-value uncertain matches must
 * enter a review queue (see docs/receipt-reconciliation.md).
 */
import { isZeroDecimal, sumDecimals } from "@sona/core";
import type { MatchableTransaction, MatchOutcome, MatchScore } from "./matches.js";

export interface AutoApplyPolicy {
  /** Master switch. When false, nothing is ever auto-applied. */
  enabled: boolean;
  /** Minimum composite score to auto-apply. */
  minScore: number;
  /** Require an exact amount match to auto-apply. */
  requireExactAmount: boolean;
  /** Maximum booking↔document day distance to auto-apply. */
  maxDateDistanceDays: number;
  /** Account glob patterns that always require human review. */
  reviewRequiredAccounts: string[];
  /** Absolute amount (decimal string) above which review is always required. */
  reviewAboveAmount: string | undefined;
  /** Below this score a pair is a weak candidate, not a review item. */
  candidateThreshold: number;
}

export const DEFAULT_AUTO_APPLY_POLICY: AutoApplyPolicy = {
  enabled: true,
  minScore: 0.97,
  requireExactAmount: true,
  maxDateDistanceDays: 5,
  reviewRequiredAccounts: ["Expenses:RealEstate:Improvements", "Expenses:Medical:*"],
  reviewAboveAmount: "1000",
  candidateThreshold: 0.5,
};

/** Matches an account path against a glob pattern (`*` suffix = prefix match). */
export function accountMatchesPattern(account: string, pattern: string): boolean {
  if (pattern.endsWith(":*")) {
    return account.startsWith(pattern.slice(0, -1)); // keep the trailing ":"
  }
  if (pattern.endsWith("*")) {
    return account.startsWith(pattern.slice(0, -1));
  }
  return account === pattern;
}

function absDecimal(amount: string): string {
  return amount.startsWith("-") ? amount.slice(1) : amount;
}

function negate(amount: string): string {
  return amount.startsWith("-") ? amount.slice(1) : `-${amount}`;
}

/** Returns true if decimal `a` is strictly greater than decimal `b`. */
function decimalGreaterThan(a: string, b: string): boolean {
  const diff = sumDecimals([a, negate(b)]);
  return !isZeroDecimal(diff) && !diff.startsWith("-");
}

export interface DecideMatchInput {
  score: MatchScore;
  transaction: MatchableTransaction;
  /** Account to evaluate against review-required patterns; defaults to the transaction's. */
  account?: string;
  policy?: AutoApplyPolicy;
}

export interface MatchDecisionResult {
  outcome: MatchOutcome;
  reasons: string[];
}

export function decideMatch(input: DecideMatchInput): MatchDecisionResult {
  const policy = input.policy ?? DEFAULT_AUTO_APPLY_POLICY;
  const { score, transaction } = input;
  const account = input.account ?? transaction.account;
  const reasons: string[] = [];

  if (score.blockers.length > 0) {
    return { outcome: "no_match", reasons: [...score.blockers] };
  }

  if (score.score < policy.candidateThreshold) {
    reasons.push(`score ${score.score} below candidate threshold ${policy.candidateThreshold}`);
    return { outcome: "candidate", reasons };
  }

  // Conditions that force review even for a strong score.
  let forcedReview = false;
  if (account !== undefined) {
    const matched = policy.reviewRequiredAccounts.find((p) => accountMatchesPattern(account, p));
    if (matched) {
      forcedReview = true;
      reasons.push(`account ${account} requires review (${matched})`);
    }
  }
  if (
    policy.reviewAboveAmount !== undefined &&
    decimalGreaterThan(absDecimal(transaction.amount), policy.reviewAboveAmount)
  ) {
    forcedReview = true;
    reasons.push(`amount exceeds ${policy.reviewAboveAmount}`);
  }

  const dateOk =
    score.dateDistanceDays !== undefined && score.dateDistanceDays <= policy.maxDateDistanceDays;

  const canAutoApply =
    policy.enabled &&
    !forcedReview &&
    score.score >= policy.minScore &&
    (!policy.requireExactAmount || score.exactAmount) &&
    dateOk;

  if (canAutoApply) {
    reasons.push(`auto-applied at score ${score.score}`);
    return { outcome: "auto_match", reasons };
  }

  if (!forcedReview) {
    reasons.push(`score ${score.score} needs review`);
  }
  return { outcome: "review", reasons };
}
