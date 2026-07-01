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
  reviewRequiredAccounts: [
    // Real estate: all expense subaccounts are tax-sensitive (interest,
    // maintenance, depreciation, improvements).
    "Expenses:RealEstate",
    "Expenses:RealEstate:*",
    // Medical / legal / insurance / tax advice — base paths and children.
    "Expenses:Medical",
    "Expenses:Medical:*",
    "Expenses:Legal",
    "Expenses:Legal:*",
    "Expenses:Insurance",
    "Expenses:Insurance:*",
    "Expenses:TaxAdvice",
    "Expenses:TaxAdvice:*",
  ],
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

  // Conditions that force review are evaluated first, so a low score can never
  // hide a warning, a sensitive account, or a high-value amount as a silent
  // weak "candidate".
  let forcedReview = false;
  if (score.warnings.length > 0) {
    forcedReview = true;
    reasons.push(...score.warnings);
  }
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

  if (forcedReview) {
    return { outcome: "review", reasons };
  }

  if (score.score < policy.candidateThreshold) {
    reasons.push(`score ${score.score} below candidate threshold ${policy.candidateThreshold}`);
    return { outcome: "candidate", reasons };
  }

  const dateOk =
    score.dateDistanceDays !== undefined && score.dateDistanceDays <= policy.maxDateDistanceDays;

  const canAutoApply =
    policy.enabled &&
    score.score >= policy.minScore &&
    (!policy.requireExactAmount || score.exactAmount) &&
    dateOk;

  if (canAutoApply) {
    reasons.push(`auto-applied at score ${score.score}`);
    return { outcome: "auto_match", reasons };
  }

  reasons.push(`score ${score.score} needs review`);
  return { outcome: "review", reasons };
}

export interface MatchSetItem {
  transactionId: string;
  documentId: string;
  score: MatchScore;
  transaction: MatchableTransaction;
  account?: string;
  policy?: AutoApplyPolicy;
}

export interface ResolvedMatch {
  transactionId: string;
  documentId: string;
  outcome: MatchOutcome;
  reasons: string[];
}

/**
 * Decides a whole candidate set with one-to-one uniqueness enforced: an
 * auto-match is only kept if its transaction and document have no OTHER
 * plausible counterpart in the set. A plausible counterpart is any candidate
 * that resolved to `auto_match` or `review` — so a strong 0.99 match is held for
 * review when a second, merely-plausible receipt also targets that transaction
 * (multiple plausible matches must be resolved by a human).
 */
export function reconcileMatchSet(items: readonly MatchSetItem[]): ResolvedMatch[] {
  const decided = items.map((item) => ({
    item,
    result: decideMatch({
      score: item.score,
      transaction: item.transaction,
      account: item.account,
      policy: item.policy,
    }),
  }));

  const isPlausible = (outcome: MatchOutcome): boolean =>
    outcome === "auto_match" || outcome === "review";

  const txPlausible = new Map<string, number>();
  const docPlausible = new Map<string, number>();
  for (const { item, result } of decided) {
    if (isPlausible(result.outcome)) {
      txPlausible.set(item.transactionId, (txPlausible.get(item.transactionId) ?? 0) + 1);
      docPlausible.set(item.documentId, (docPlausible.get(item.documentId) ?? 0) + 1);
    }
  }

  return decided.map(({ item, result }) => {
    const contested =
      result.outcome === "auto_match" &&
      ((txPlausible.get(item.transactionId) ?? 0) > 1 ||
        (docPlausible.get(item.documentId) ?? 0) > 1);
    if (contested) {
      return {
        transactionId: item.transactionId,
        documentId: item.documentId,
        outcome: "review",
        reasons: [...result.reasons, "multiple plausible matches; needs review"],
      };
    }
    return {
      transactionId: item.transactionId,
      documentId: item.documentId,
      outcome: result.outcome,
      reasons: result.reasons,
    };
  });
}
