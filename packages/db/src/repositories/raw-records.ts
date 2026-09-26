import { createRawSourceRecord, type RawSourceRecord } from "@sona/core";
import type { DbClient } from "../runner.js";
import { optionalString, parseJson, requiredString, row, rows, stringifyJson } from "./helpers.js";

export class SqliteRawRecordRepository {
  readonly #db: DbClient;

  constructor(db: DbClient) {
    this.#db = db;
  }

  /**
   * Appends idempotently on (workspace, source, payload hash) and returns the
   * stored record — the pre-existing one when the payload was already known —
   * so callers can link normalized records to a raw record that exists.
   */
  async append(record: RawSourceRecord): Promise<RawSourceRecord> {
    this.#db
      .prepare(
        "INSERT OR IGNORE INTO raw_source_records (id, workspace_id, source_id, external_id, record_type, payload_json, payload_hash, observed_at, supersedes_record_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        record.id,
        record.workspaceId,
        record.sourceId,
        record.externalId ?? null,
        record.recordType,
        stringifyJson(record.payloadJson),
        record.payloadHash,
        record.observedAt,
        record.supersedesRecordId ?? null,
        record.createdAt,
      );
    const stored = row(
      this.#db
        .prepare(
          "SELECT id, workspace_id, source_id, external_id, record_type, payload_json, observed_at, supersedes_record_id, created_at FROM raw_source_records WHERE workspace_id = ? AND source_id = ? AND payload_hash = ?",
        )
        .get(record.workspaceId, record.sourceId, record.payloadHash),
    );
    if (stored === undefined) {
      throw new Error("raw record was not stored");
    }
    return rawFromRow(stored);
  }

  async getById(workspaceId: string, id: string): Promise<RawSourceRecord | undefined> {
    const result = row(
      this.#db
        .prepare(
          "SELECT id, workspace_id, source_id, external_id, record_type, payload_json, observed_at, supersedes_record_id, created_at FROM raw_source_records WHERE workspace_id = ? AND id = ?",
        )
        .get(workspaceId, id),
    );
    return result === undefined ? undefined : rawFromRow(result);
  }

  async listForSource(workspaceId: string, sourceId: string): Promise<RawSourceRecord[]> {
    return rows(
      this.#db
        .prepare(
          "SELECT id, workspace_id, source_id, external_id, record_type, payload_json, observed_at, supersedes_record_id, created_at FROM raw_source_records WHERE workspace_id = ? AND source_id = ? ORDER BY created_at, id",
        )
        .all(workspaceId, sourceId),
    ).map(rawFromRow);
  }
}

function rawFromRow(source: Record<string, unknown>): RawSourceRecord {
  return createRawSourceRecord({
    id: requiredString(source, "id"),
    workspaceId: requiredString(source, "workspace_id"),
    sourceId: requiredString(source, "source_id"),
    externalId: optionalString(source, "external_id"),
    recordType: requiredString(source, "record_type") as RawSourceRecord["recordType"],
    payloadJson: parseJson(requiredString(source, "payload_json")),
    observedAt: requiredString(source, "observed_at"),
    createdAt: requiredString(source, "created_at"),
    supersedesRecordId: optionalString(source, "supersedes_record_id"),
  });
}
