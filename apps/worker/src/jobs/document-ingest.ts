/**
 * `document_ingest`: turns staged bytes into a first-class document. The
 * original is hashed, deduplicated per workspace, stored under the document id
 * in `DocumentStorage`, recorded in the `documents` table, and queued for
 * extraction. A re-upload of identical bytes returns the existing document.
 */
import {
  type DocumentStorage,
  type DocumentStream,
  type JsonValue,
  sha256Hex,
  type WorkspaceContext,
} from "@sona/core";
import { RECORD_TYPES, type SqliteDocumentRepository } from "@sona/db";
import { type DocumentSourceKind, hashDocumentContent, type StoredDocument } from "@sona/receipts";
import { redactJson } from "./redact.js";
import { type JobHandler, NonRetryableJobError } from "./runner.js";

export interface DocumentIngestDependencies {
  documents: SqliteDocumentRepository;
  storage: DocumentStorage;
}

export interface IngestDocumentInput {
  context: WorkspaceContext;
  bytes: Uint8Array;
  mimeType: string;
  originalFilename: string;
  sourceKind: DocumentSourceKind;
  sourceMetadata?: JsonValue;
  now: string;
}

export interface IngestDocumentResult {
  document: StoredDocument;
  /** False when identical bytes were already stored in the workspace. */
  created: boolean;
}

/** Storage URI scheme for originals kept in the configured `DocumentStorage`. */
export const DOCUMENT_STORAGE_SCHEME = "sona-document" as const;

export function documentStorageUri(workspaceId: string, documentId: string): string {
  return `${DOCUMENT_STORAGE_SCHEME}://${workspaceId}/${documentId}`;
}

/**
 * Deterministic document id from the workspace and content hash, so retries
 * converge on one row while identical bytes in two workspaces never share the
 * global primary key.
 */
export function documentIdForHash(workspaceId: string, contentHash: string): string {
  return `doc_${sha256Hex(`${workspaceId}\u0000${contentHash}`).slice(0, 32)}`;
}

export async function ingestDocument(
  deps: DocumentIngestDependencies,
  input: IngestDocumentInput,
): Promise<IngestDocumentResult> {
  const { context } = input;
  const { workspaceId } = context;
  if (input.bytes.byteLength === 0) {
    throw new NonRetryableJobError("cannot ingest an empty document");
  }
  const contentHash = hashDocumentContent(input.bytes);
  const existing = await deps.documents.findByContentHash(workspaceId, contentHash);
  if (existing !== undefined) {
    return { document: existing, created: false };
  }

  const id = documentIdForHash(workspaceId, contentHash);
  // Bytes first: a row must never point at an original that is not stored.
  await deps.storage.put({
    context,
    id,
    bytes: input.bytes,
    contentType: input.mimeType,
    originalFilename: input.originalFilename,
    createdAt: input.now,
    metadata: { sourceKind: input.sourceKind },
  });
  // `save` returns the existing row when the hash landed between the lookup
  // above and this write; the deterministic id makes that the same document.
  const document = await deps.documents.save({
    id,
    workspaceId,
    contentHash,
    mimeType: input.mimeType,
    originalFilename: input.originalFilename,
    storageUri: documentStorageUri(workspaceId, id),
    sourceKind: input.sourceKind,
    sourceMetadata:
      input.sourceMetadata === undefined ? undefined : redactJson(input.sourceMetadata),
    retentionState: "active",
    createdAt: input.now,
  });
  return { document, created: document.createdAt === input.now };
}

export function createDocumentIngestHandler(
  deps: DocumentIngestDependencies,
): JobHandler<"document_ingest"> {
  return async ({ job, context, now, enqueue, produced }) => {
    const { uploadId, sourceKind, sourceMetadata } = job.payload;
    let staged: DocumentStream;
    try {
      staged = await deps.storage.get({ context, id: uploadId });
    } catch (error) {
      throw new NonRetryableJobError(`staged upload ${uploadId} is not readable`, {
        cause: error,
      });
    }
    const result = await ingestDocument(deps, {
      context,
      bytes: staged.bytes,
      mimeType: staged.document.contentType,
      originalFilename: staged.document.originalFilename ?? uploadId,
      sourceKind,
      sourceMetadata,
      now,
    });
    produced({ type: RECORD_TYPES.document, id: result.document.id });
    const extraction = await enqueue("extraction", { documentId: result.document.id });
    if (result.document.id !== uploadId) {
      // The original now lives under the document id; drop the staging copy.
      await deps.storage.delete({ context, id: uploadId });
    }
    return {
      documentId: result.document.id,
      contentHash: result.document.contentHash,
      created: result.created,
      extractionJobId: extraction.job.id,
    };
  };
}
