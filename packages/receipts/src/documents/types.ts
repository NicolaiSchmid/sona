/**
 * Documents are first-class evidence. Sona stores originals internally for
 * normal users; external systems (e.g. Paperless) are optional adapters, not
 * the default. Every document records provenance, a content hash for dedup, and
 * a retention state.
 */
import type { JsonValue } from "@sona/core";

export type DocumentSourceKind = "upload" | "email" | "portal" | "paperless" | "api";

export type RetentionState = "active" | "archived" | "delete_requested" | "deleted";

export interface StoredDocument {
  id: string;
  workspaceId: string;
  /** SHA-256 of the original bytes, used for deduplication. */
  contentHash: string;
  mimeType: string;
  originalFilename: string;
  /** Location in the document storage backend (object store / filesystem). */
  storageUri: string;
  sourceKind: DocumentSourceKind;
  /** Provenance: source URL, portal/email metadata, upload context, etc. */
  sourceMetadata: JsonValue | undefined;
  retentionState: RetentionState;
  createdAt: string;
}
