/**
 * Connector-neutral contracts shared by every source adapter.
 */
import type { JsonValue, RawSourceRecord } from "@sona/core";

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

export interface RawRecordStore {
  /**
   * Appends a raw record. MUST be idempotent on the record's dedup key
   * (workspace + source + payload hash): re-importing an unchanged provider
   * payload must be a no-op, not an error, so repeated syncs don't fail on the
   * `uq_raw_records_dedup` constraint.
   */
  append(record: RawSourceRecord): Promise<void>;
}

/**
 * Deep-clones a provider payload into a `JsonValue`, dropping `undefined`
 * fields the way JSON serialization does. Used for raw-vault payloads and the
 * `raw` copy kept on normalized records.
 */
export function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
