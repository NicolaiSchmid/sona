/**
 * SQLite-backed evidence graph edges. Links are validated with the
 * `@sona/core` schema at the write boundary and deduplicated on the full typed
 * edge `(from, to, kind)` within a workspace, so re-running a pipeline never
 * produces a second identical link.
 *
 * Endpoints are polymorphic. For record types backed by a table, the endpoint
 * must exist in the link's workspace, so an edge can never point at another
 * tenant's record or at nothing. Types without a table yet are accepted as-is.
 */
import { type EvidenceLink, evidenceLinkSchema, isEvidenceLinkKind } from "@sona/core";
import type { DbClient } from "../runner.js";
import { optionalString, type Row, requiredLiteral, requiredString, row, rows } from "./helpers.js";
import { RECORD_TYPES, type RecordRef, type RecordType } from "./records.js";

/** Tables backing the endpoint types that can be verified; the rest are trusted as-is. */
const ENDPOINT_TABLES = {
  ledger_transaction: "ledger_transactions",
  ledger_posting: "ledger_postings",
  document: "documents",
  raw_source_record: "raw_source_records",
  bank_transaction: "bank_transactions",
  match_decision: "match_decisions",
  review_event: "review_events",
  review_item: "review_items",
  asset: "assets",
  asset_depreciation_schedule: "asset_depreciation_schedules",
} as const satisfies Partial<Record<RecordType, string>>;

function endpointTable(type: string): string | undefined {
  return Object.hasOwn(ENDPOINT_TABLES, type)
    ? (ENDPOINT_TABLES as Readonly<Record<string, string>>)[type]
    : undefined;
}

export interface LinkEvidenceResult {
  link: EvidenceLink;
  /** False when an identical edge already existed and was returned instead. */
  created: boolean;
}

const LINK_SELECT =
  "SELECT id, workspace_id, from_type, from_id, to_type, to_id, kind, notes, created_at FROM evidence_links";

const EDGE_WHERE =
  "WHERE workspace_id = ? AND from_type = ? AND from_id = ? AND to_type = ? AND to_id = ? AND kind = ?";

export class SqliteEvidenceLinkRepository {
  readonly #db: DbClient;

  constructor(db: DbClient) {
    this.#db = db;
  }

  /** Records a typed edge; an identical edge in the workspace is returned unchanged. */
  async link(input: EvidenceLink): Promise<LinkEvidenceResult> {
    const link = evidenceLinkSchema.parse(input);
    this.#assertEndpointExists(link.workspaceId, { type: link.fromType, id: link.fromId });
    this.#assertEndpointExists(link.workspaceId, { type: link.toType, id: link.toId });
    const existing = this.#findEdge(link);
    if (existing !== undefined) {
      return { link: existing, created: false };
    }
    // The unique edge index makes a concurrent duplicate a no-op rather than an error.
    this.#db
      .prepare(
        "INSERT INTO evidence_links (id, workspace_id, from_type, from_id, to_type, to_id, kind, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id, from_type, from_id, to_type, to_id, kind) DO NOTHING",
      )
      .run(
        link.id,
        link.workspaceId,
        link.fromType,
        link.fromId,
        link.toType,
        link.toId,
        link.kind,
        link.notes ?? null,
        link.createdAt,
      );
    const persisted = this.#findEdge(link);
    if (persisted === undefined) {
      throw new Error("evidence link was not persisted");
    }
    return { link: persisted, created: persisted.id === link.id };
  }

  async getById(workspaceId: string, id: string): Promise<EvidenceLink | undefined> {
    const result = row(
      this.#db.prepare(`${LINK_SELECT} WHERE workspace_id = ? AND id = ?`).get(workspaceId, id),
    );
    return result === undefined ? undefined : linkFromRow(result);
  }

  /** Every link where the record is either endpoint. */
  async listForRecord(workspaceId: string, record: RecordRef): Promise<EvidenceLink[]> {
    return rows(
      this.#db
        .prepare(
          `${LINK_SELECT} WHERE workspace_id = ? AND ((from_type = ? AND from_id = ?) OR (to_type = ? AND to_id = ?)) ORDER BY created_at, id`,
        )
        .all(workspaceId, record.type, record.id, record.type, record.id),
    ).map(linkFromRow);
  }

  async listForTransaction(workspaceId: string, transactionId: string): Promise<EvidenceLink[]> {
    return this.listForRecord(workspaceId, {
      type: RECORD_TYPES.ledgerTransaction,
      id: transactionId,
    });
  }

  async listForDocument(workspaceId: string, documentId: string): Promise<EvidenceLink[]> {
    return this.listForRecord(workspaceId, { type: RECORD_TYPES.document, id: documentId });
  }

  #assertEndpointExists(workspaceId: string, endpoint: RecordRef): void {
    const table = endpointTable(endpoint.type);
    if (table === undefined) {
      return;
    }
    // `table` comes from the constant map above, never from input.
    const found = this.#db
      .prepare(`SELECT 1 FROM ${table} WHERE workspace_id = ? AND id = ?`)
      .get(workspaceId, endpoint.id);
    if (found === undefined) {
      throw new Error(`evidence endpoint ${endpoint.type}:${endpoint.id} not found in workspace`);
    }
  }

  #findEdge(link: EvidenceLink): EvidenceLink | undefined {
    const result = row(
      this.#db
        .prepare(`${LINK_SELECT} ${EDGE_WHERE}`)
        .get(link.workspaceId, link.fromType, link.fromId, link.toType, link.toId, link.kind),
    );
    return result === undefined ? undefined : linkFromRow(result);
  }
}

function linkFromRow(source: Row): EvidenceLink {
  return {
    id: requiredString(source, "id"),
    workspaceId: requiredString(source, "workspace_id"),
    fromType: requiredString(source, "from_type"),
    fromId: requiredString(source, "from_id"),
    toType: requiredString(source, "to_type"),
    toId: requiredString(source, "to_id"),
    kind: requiredLiteral(source, "kind", isEvidenceLinkKind),
    notes: optionalString(source, "notes"),
    createdAt: requiredString(source, "created_at"),
  };
}
