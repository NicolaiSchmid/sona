/**
 * Connector-neutral contracts shared by every source adapter.
 */

/** Terminal status of a sync/import run. */
export type SyncStatus = "succeeded" | "completed_with_errors" | "failed";

/** Link from a normalized record back to the raw source record it came from. */
export interface RawLink {
  rawRecordId: string;
}

/** Injected id/time providers so orchestration stays deterministic in tests. */
export interface SyncEnv {
  /** Unique id generator for raw records and the run. */
  ids: () => string;
  /** Current time as an ISO-8601 string. */
  nowIso: () => string;
}
