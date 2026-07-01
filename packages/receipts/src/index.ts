/**
 * @sona/receipts
 *
 * Document storage, text/OCR extraction, and receipt ↔ transaction matching.
 * Receipts are first-class evidence stored internally for normal users.
 */

/** Package version marker, used to verify wiring and test discovery. */
export const sonaReceiptsVersion = "0.0.0" as const;

export {
  findDuplicateByContent,
  type HasContentHash,
  hashDocumentContent,
  isDuplicateContent,
} from "./documents/hash.js";
export type { DocumentSourceKind, RetentionState, StoredDocument } from "./documents/types.js";
export type { DocumentExtraction } from "./extraction/types.js";
export type {
  MatchableDocument,
  MatchableTransaction,
  MatchCandidate,
  MatchDecision,
  MatchDecisionKind,
  MatchOutcome,
  MatchScore,
} from "./reconciliation/matches.js";
export {
  type AutoApplyPolicy,
  accountMatchesPattern,
  DEFAULT_AUTO_APPLY_POLICY,
  type DecideMatchInput,
  decideMatch,
  type MatchDecisionResult,
} from "./reconciliation/policies.js";
export {
  DEFAULT_MAX_DATE_DISTANCE_DAYS,
  type ScoreOptions,
  scoreMatch,
  vendorSimilarity,
} from "./reconciliation/scoring.js";
