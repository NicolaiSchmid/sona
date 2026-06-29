/**
 * Source records and the append-only raw vault.
 *
 * Raw source records are immutable. Corrections never mutate an existing
 * record; instead a new record is appended that supersedes the prior one via
 * {@link supersedeRawSourceRecord}. This preserves a faithful, auditable trail
 * of exactly what each provider returned.
 */
import { type JsonValue, stableJsonHash } from "../util/hash";

/** The kind of upstream Sona collects from. */
export type SourceKind =
  | "enable_banking"
  | "fints"
  | "email"
  | "upload"
  | "portal"
  | "portfolio"
  | "manual";

export type SourceStatus = "active" | "paused" | "error" | "revoked";

export interface Source {
  id: string;
  workspaceId: string;
  kind: SourceKind;
  displayName: string;
  status: SourceStatus;
  createdAt: string;
}

/** What a raw source record represents. Open-ended; extend as connectors land. */
export type RawSourceRecordType =
  | "bank_account"
  | "bank_balance"
  | "bank_transaction"
  | "document"
  | "portfolio_event"
  | "asset_event";

export interface RawSourceRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly sourceId: string;
  /** Provider-assigned identifier for this record, when available. */
  readonly externalId: string | undefined;
  readonly recordType: RawSourceRecordType;
  /** Verbatim provider payload. Cloned and deeply frozen; never edited after creation. */
  readonly payloadJson: JsonValue;
  /** Stable hash of the payload, used for idempotent imports and dedup. */
  readonly payloadHash: string;
  /** When the provider observed/returned this record (ISO timestamp). */
  readonly observedAt: string;
  /** If this record corrects a prior one, the superseded record's id. */
  readonly supersedesRecordId: string | undefined;
  readonly createdAt: string;
}

export interface CreateRawSourceRecordInput {
  id: string;
  workspaceId: string;
  sourceId: string;
  externalId?: string;
  recordType: RawSourceRecordType;
  payloadJson: JsonValue;
  observedAt: string;
  createdAt: string;
  supersedesRecordId?: string;
}

/** Recursively freezes a value and everything it transitively contains. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Creates a frozen raw source record with a computed payload hash. The payload
 * is cloned and deeply frozen so neither the record nor its nested payload can
 * be mutated after creation — keeping `payloadHash`, dedup, and audit faithful.
 */
export function createRawSourceRecord(input: CreateRawSourceRecordInput): RawSourceRecord {
  const payloadJson = deepFreeze(structuredClone(input.payloadJson));
  return Object.freeze({
    id: input.id,
    workspaceId: input.workspaceId,
    sourceId: input.sourceId,
    externalId: input.externalId,
    recordType: input.recordType,
    payloadJson,
    payloadHash: stableJsonHash(payloadJson),
    observedAt: input.observedAt,
    supersedesRecordId: input.supersedesRecordId,
    createdAt: input.createdAt,
  });
}

/**
 * Appends a correction: returns a new frozen record that supersedes `original`
 * without mutating it. The original retains its identity and payload.
 */
export function supersedeRawSourceRecord(
  original: RawSourceRecord,
  input: Omit<CreateRawSourceRecordInput, "supersedesRecordId" | "workspaceId" | "sourceId">,
): RawSourceRecord {
  return createRawSourceRecord({
    ...input,
    workspaceId: original.workspaceId,
    sourceId: original.sourceId,
    supersedesRecordId: original.id,
  });
}
