/**
 * Provenance records for browser-fetched documents, and conversion into
 * `@sona/receipts` document metadata so fetched files become first-class
 * evidence. Credentials/secrets must never appear here.
 */
import type { JsonValue } from "@sona/core";
import type { StoredDocument } from "@sona/receipts";

/** Per-run provenance for an executed portal task. */
export interface TaskRunProvenance {
  runId: string;
  taskId: string;
  taskVersion: number;
  /** Portal domain the run operated against (from the task allowlist). */
  portalDomain: string;
  /** Which execution backend ran the task (e.g. "browserbase", "fake"). */
  browserProvider: string;
  workspaceId: string;
  /** ISO timestamp of the run. */
  fetchedAt: string;
}

export type ExtractionStatus = "pending" | "extracted" | "failed";

/** Provenance for a single fetched document. */
export interface FetchedDocumentProvenance {
  sourcePortal: string;
  taskId: string;
  taskVersion: number;
  runId: string;
  /** Original URL, only if safe to retain (no tokens/secrets). */
  sourceUrl: string | undefined;
  downloadedFilename: string;
  contentHash: string;
  fetchedAt: string;
  browserProvider: string;
  workspaceId: string;
  extractionStatus: ExtractionStatus;
}

/** A document fetched by a portal task, before it is stored. */
export interface FetchedDocument {
  filename: string;
  mimeType: string;
  contentHash: string;
  sourceUrl: string | undefined;
  provenance: FetchedDocumentProvenance;
}

export interface ToStoredDocumentInput {
  document: FetchedDocument;
  /** Id assigned to the stored document. */
  id: string;
  /** Location the original bytes were written to. */
  storageUri: string;
  createdAt: string;
}

/**
 * Converts a fetched document + its provenance into a `StoredDocument` for
 * `@sona/receipts` (source kind `portal`, provenance carried in
 * `sourceMetadata`). The content hash is preserved for dedup.
 */
export function toStoredDocument(input: ToStoredDocumentInput): StoredDocument {
  const { document, id, storageUri, createdAt } = input;
  const provenance = document.provenance;
  return {
    id,
    workspaceId: provenance.workspaceId,
    contentHash: document.contentHash,
    mimeType: document.mimeType,
    originalFilename: document.filename,
    storageUri,
    sourceKind: "portal",
    sourceMetadata: provenanceToJson(provenance),
    retentionState: "active",
    createdAt,
  };
}

function provenanceToJson(provenance: FetchedDocumentProvenance): JsonValue {
  return {
    sourcePortal: provenance.sourcePortal,
    taskId: provenance.taskId,
    taskVersion: provenance.taskVersion,
    runId: provenance.runId,
    sourceUrl: provenance.sourceUrl ?? null,
    downloadedFilename: provenance.downloadedFilename,
    contentHash: provenance.contentHash,
    fetchedAt: provenance.fetchedAt,
    browserProvider: provenance.browserProvider,
    extractionStatus: provenance.extractionStatus,
  };
}
