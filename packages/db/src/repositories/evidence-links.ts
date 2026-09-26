/**
 * SQLite-backed evidence graph edges. Links are validated with the
 * `@sona/core` schema at the write boundary and deduplicated on the full typed
 * edge `(from, to, kind)` within a workspace, so re-running a pipeline never
 * produces a second identical link.
 *
 * Endpoints are polymorphic ids and are not checked for existence here; the
 * service that knows the record types is responsible for linking real,
 * same-workspace records.
 */
import { type EvidenceLink, evidenceLinkSchema, isEvidenceLinkKind } from "@sona/core";
import type { DbClient } from "../runner.js";
import { optionalString, type Row, requiredLiteral, requiredString, row, rows } from "./helpers.js";

/** Record type names used on evidence link and review event endpoints across Sona. */
export const EVIDENCE_RECORD_TYPES = {
  ledgerTransaction: "ledger_transaction",
  ledgerPosting: "ledger_posting",
  document: "document",
  rawSourceRecord: "raw_source_record",
  bankTransaction: "bank_transaction",
  matchDecision: "match_decision",
  reviewEvent: "review_event",
  reviewItem: "review_item",
  taxExportLine: "tax_export_line",
} as const;

export type EvidenceRecordType = (typeof EVIDENCE_RECORD_TYPES)[keyof typeof EVIDENCE_RECORD_TYPES];

/** A polymorphic reference to any domain record. */
export interface RecordRef {
  type: string;
  id: string;
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
      type: EVIDENCE_RECORD_TYPES.ledgerTransaction,
      id: transactionId,
    });
  }

  async listForDocument(workspaceId: string, documentId: string): Promise<EvidenceLink[]> {
    return this.listForRecord(workspaceId, {
      type: EVIDENCE_RECORD_TYPES.document,
      id: documentId,
    });
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
