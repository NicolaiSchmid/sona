/**
 * Provenance records for browser-fetched documents, and conversion into
 * `@sona/receipts` document metadata so fetched files become first-class
 * evidence. Credentials/secrets must never appear here.
 */
import type { JsonValue } from "@sona/core";
import type { StoredDocument } from "@sona/receipts";
import type { ALLOWED_NON_IDEMPOTENT_REASONS, PortalHttpMethodException } from "./schema.js";
import { sanitizeUrl } from "./url.js";

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
  /** Requests the network guard refused during the run. */
  blockedRequests: BlockedPortalRequest[];
  /** Non-idempotent requests let through under a reviewed task exception. */
  allowedNonIdempotentRequests: AllowedNonIdempotentPortalRequest[];
}

export type BlockedPortalRequestReason =
  | "off_allowlist"
  | "non_idempotent_method"
  | "unreviewed_body"
  | "websocket";

/** Playwright's resource classification; adapters map unknown kinds to `other`. */
export const PORTAL_RESOURCE_TYPES = [
  "document",
  "stylesheet",
  "image",
  "media",
  "font",
  "script",
  "texttrack",
  "xhr",
  "fetch",
  "eventsource",
  "websocket",
  "manifest",
  "other",
] as const;

export type PortalResourceType = (typeof PORTAL_RESOURCE_TYPES)[number];

export interface BlockedPortalRequest {
  /** Sanitized: no query, fragment, or userinfo. */
  url: string;
  method: string;
  resourceType: PortalResourceType;
  reason: BlockedPortalRequestReason;
}

export type AllowedNonIdempotentRequestReason = (typeof ALLOWED_NON_IDEMPOTENT_REASONS)[number];

export interface AllowedNonIdempotentPortalRequest {
  /** Sanitized: no query, fragment, or userinfo. */
  url: string;
  method: PortalHttpMethodException["method"];
  reason: AllowedNonIdempotentRequestReason;
  justification: string;
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

/** URI scheme for `objectRef` content that points at a stored document by id. */
export const STORED_DOCUMENT_URI_SCHEME = "stored-document:";

/**
 * The fetched bytes, carried so a real runner can hand them to document storage.
 * `bytes` inlines small payloads; `path` points at a temp file; `objectRef`
 * references an already-uploaded object (`stored-document:<id>` once the
 * runner has persisted it, so run results never carry document bytes).
 */
export type FetchedContent =
  | { kind: "bytes"; bytes: Uint8Array }
  | { kind: "path"; path: string }
  | { kind: "objectRef"; uri: string };

/** A document fetched by a portal task, before it is stored. */
export interface FetchedDocument {
  filename: string;
  mimeType: string;
  contentHash: string;
  sourceUrl: string | undefined;
  /** The payload to persist (bytes, temp path, or an object reference). */
  content: FetchedContent;
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
  // The dedup hash and the provenance hash must agree, or one record is wrong.
  if (document.contentHash !== provenance.contentHash) {
    throw new Error("content hash mismatch between fetched document and its provenance");
  }
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

/** Provenance JSON carries the sanitized URL, or null when absent or unparseable. */
function jsonSourceUrl(raw: string | undefined): string | null {
  return raw === undefined ? null : (sanitizeUrl(raw) ?? null);
}

function provenanceToJson(provenance: FetchedDocumentProvenance): JsonValue {
  return {
    sourcePortal: provenance.sourcePortal,
    taskId: provenance.taskId,
    taskVersion: provenance.taskVersion,
    runId: provenance.runId,
    sourceUrl: jsonSourceUrl(provenance.sourceUrl),
    downloadedFilename: provenance.downloadedFilename,
    contentHash: provenance.contentHash,
    fetchedAt: provenance.fetchedAt,
    browserProvider: provenance.browserProvider,
    extractionStatus: provenance.extractionStatus,
  };
}
