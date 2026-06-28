/**
 * Review states track how far a derived fact (classification, match, export
 * line) has progressed through human/advisor approval. AI may produce
 * `suggested` records; tax-relevant outputs require a human review state
 * before they appear in a final export.
 */
export const REVIEW_STATES = [
  "draft",
  "suggested",
  "user_reviewed",
  "advisor_reviewed",
  "exported",
  "superseded",
] as const;

export type ReviewState = (typeof REVIEW_STATES)[number];

export function isReviewState(value: string): value is ReviewState {
  return (REVIEW_STATES as readonly string[]).includes(value);
}

/**
 * Monotonic rank of the approval progression. `superseded` is terminal and
 * deliberately ranked below `draft`: a superseded record never "meets" a
 * required review state.
 */
const REVIEW_STATE_RANK: Record<ReviewState, number> = {
  superseded: -1,
  draft: 0,
  suggested: 1,
  user_reviewed: 2,
  advisor_reviewed: 3,
  exported: 4,
};

/**
 * Returns true if `actual` is at least as approved as `required`.
 * `superseded` never satisfies any requirement.
 */
export function meetsReviewState(actual: ReviewState, required: ReviewState): boolean {
  if (actual === "superseded") {
    return false;
  }
  return REVIEW_STATE_RANK[actual] >= REVIEW_STATE_RANK[required];
}

/** A recorded human or rule decision that moves a record between review states. */
export interface ReviewEvent {
  id: string;
  workspaceId: string;
  /** Domain record type the decision applies to, e.g. "ledger_posting". */
  targetType: string;
  targetId: string;
  fromState: ReviewState;
  toState: ReviewState;
  /** Who made the decision: a user id, "rule:<id>", or "system". */
  actor: string;
  notes?: string;
  createdAt: string;
}
