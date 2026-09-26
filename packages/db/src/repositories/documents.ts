import type { DocumentExtraction, StoredDocument } from "@sona/receipts";
import type { DbClient } from "../runner.js";
import { optionalString, parseJson, requiredString, row, rows, stringifyJson } from "./helpers.js";
import { RECORD_TYPES } from "./records.js";

export interface StoredDocumentExtraction extends DocumentExtraction {
  id: string;
  workspaceId: string;
  createdAt: string;
}

/** Correlated subquery: an outgoing `substantiates` edge from document `d`. Constants only, never input. */
const SUBSTANTIATES_FROM_DOCUMENT = `SELECT 1 FROM evidence_links e WHERE e.workspace_id = d.workspace_id AND e.from_type = '${RECORD_TYPES.document}' AND e.from_id = d.id AND e.kind = 'substantiates'`;

export class SqliteDocumentRepository {
  readonly #db: DbClient;

  constructor(db: DbClient) {
    this.#db = db;
  }

  async save(document: StoredDocument): Promise<StoredDocument> {
    const existing = await this.findByContentHash(document.workspaceId, document.contentHash);
    if (existing !== undefined) {
      return existing;
    }
    this.#db
      .prepare(
        "INSERT INTO documents (id, workspace_id, content_hash, mime_type, original_filename, storage_uri, source_kind, source_metadata_json, retention_state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        document.id,
        document.workspaceId,
        document.contentHash,
        document.mimeType,
        document.originalFilename,
        document.storageUri,
        document.sourceKind,
        document.sourceMetadata === undefined ? null : stringifyJson(document.sourceMetadata),
        document.retentionState,
        document.createdAt,
      );
    return document;
  }

  async getById(workspaceId: string, id: string): Promise<StoredDocument | undefined> {
    const result = row(
      this.#db
        .prepare("SELECT * FROM documents WHERE workspace_id = ? AND id = ?")
        .get(workspaceId, id),
    );
    return result === undefined ? undefined : documentFromRow(result);
  }

  /**
   * Documents no `substantiates` evidence link starts from — receipts still
   * waiting for their transaction. Oldest first; used to re-run reconciliation
   * once new bank transactions arrive.
   */
  async listUnsubstantiated(workspaceId: string, limit = 500): Promise<StoredDocument[]> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`document list limit must be a positive integer, got ${String(limit)}`);
    }
    return rows(
      this.#db
        .prepare(
          `SELECT d.* FROM documents d WHERE d.workspace_id = ? AND d.retention_state = 'active' AND NOT EXISTS (${SUBSTANTIATES_FROM_DOCUMENT}) ORDER BY d.created_at, d.id LIMIT ?`,
        )
        .all(workspaceId, limit),
    ).map(documentFromRow);
  }

  /**
   * Unsubstantiated documents that reconciliation can act on: an extraction
   * with a total exists. The worker re-queues these when new bank transactions
   * arrive; documents still awaiting extraction or review of a missing total
   * would only produce no-op jobs.
   */
  async listAwaitingReconciliation(workspaceId: string, limit = 500): Promise<StoredDocument[]> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`document list limit must be a positive integer, got ${String(limit)}`);
    }
    return rows(
      this.#db
        .prepare(
          `SELECT d.* FROM documents d WHERE d.workspace_id = ? AND d.retention_state = 'active' AND EXISTS (SELECT 1 FROM document_extractions x WHERE x.workspace_id = d.workspace_id AND x.document_id = d.id AND x.total_amount IS NOT NULL) AND NOT EXISTS (${SUBSTANTIATES_FROM_DOCUMENT}) ORDER BY d.created_at, d.id LIMIT ?`,
        )
        .all(workspaceId, limit),
    ).map(documentFromRow);
  }

  async findByContentHash(
    workspaceId: string,
    contentHash: string,
  ): Promise<StoredDocument | undefined> {
    const result = row(
      this.#db
        .prepare("SELECT * FROM documents WHERE workspace_id = ? AND content_hash = ?")
        .get(workspaceId, contentHash),
    );
    return result === undefined ? undefined : documentFromRow(result);
  }
}

export class SqliteDocumentExtractionRepository {
  readonly #db: DbClient;

  constructor(db: DbClient) {
    this.#db = db;
  }

  async save(
    workspaceId: string,
    input: { id: string; extraction: DocumentExtraction; createdAt: string },
  ): Promise<StoredDocumentExtraction> {
    const extraction = input.extraction;
    this.#db
      .prepare(
        "INSERT INTO document_extractions (id, workspace_id, document_id, vendor_name, document_date, due_date, total_amount, tax_amount, currency, invoice_number, payment_reference, extracted_text, confidence, extractor_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.id,
        workspaceId,
        extraction.documentId,
        extraction.vendorName ?? null,
        extraction.documentDate ?? null,
        extraction.dueDate ?? null,
        extraction.totalAmount ?? null,
        extraction.taxAmount ?? null,
        extraction.currency ?? null,
        extraction.invoiceNumber ?? null,
        extraction.paymentReference ?? null,
        extraction.extractedText ?? null,
        String(extraction.confidence),
        extraction.extractorVersion,
        input.createdAt,
      );
    return {
      id: input.id,
      workspaceId,
      ...extraction,
      createdAt: input.createdAt,
    };
  }

  async getById(workspaceId: string, id: string): Promise<StoredDocumentExtraction | undefined> {
    const result = row(
      this.#db
        .prepare("SELECT * FROM document_extractions WHERE workspace_id = ? AND id = ?")
        .get(workspaceId, id),
    );
    return result === undefined ? undefined : extractionFromRow(result);
  }

  async listForDocument(
    workspaceId: string,
    documentId: string,
  ): Promise<StoredDocumentExtraction[]> {
    return rows(
      this.#db
        .prepare(
          "SELECT * FROM document_extractions WHERE workspace_id = ? AND document_id = ? ORDER BY created_at, id",
        )
        .all(workspaceId, documentId),
    ).map(extractionFromRow);
  }
}

function documentFromRow(source: Record<string, unknown>): StoredDocument {
  const metadata = optionalString(source, "source_metadata_json");
  return {
    id: requiredString(source, "id"),
    workspaceId: requiredString(source, "workspace_id"),
    contentHash: requiredString(source, "content_hash"),
    mimeType: requiredString(source, "mime_type"),
    originalFilename: requiredString(source, "original_filename"),
    storageUri: requiredString(source, "storage_uri"),
    sourceKind: requiredString(source, "source_kind") as StoredDocument["sourceKind"],
    sourceMetadata: metadata === undefined ? undefined : parseJson(metadata),
    retentionState: requiredString(source, "retention_state") as StoredDocument["retentionState"],
    createdAt: requiredString(source, "created_at"),
  };
}

function extractionFromRow(source: Record<string, unknown>): StoredDocumentExtraction {
  return {
    id: requiredString(source, "id"),
    workspaceId: requiredString(source, "workspace_id"),
    documentId: requiredString(source, "document_id"),
    vendorName: optionalString(source, "vendor_name"),
    documentDate: optionalString(source, "document_date"),
    dueDate: optionalString(source, "due_date"),
    totalAmount: optionalString(source, "total_amount"),
    taxAmount: optionalString(source, "tax_amount"),
    currency: optionalString(source, "currency"),
    invoiceNumber: optionalString(source, "invoice_number"),
    paymentReference: optionalString(source, "payment_reference"),
    extractedText: optionalString(source, "extracted_text"),
    confidence: Number(requiredString(source, "confidence")),
    extractorVersion: requiredString(source, "extractor_version"),
    createdAt: requiredString(source, "created_at"),
  };
}
