/**
 * Content hashing and deduplication for stored documents. Mass upload is a core
 * workflow, so re-uploading the same file (same bytes) must be detected rather
 * than stored twice.
 */
import { sha256Hex } from "@sona/core";

/** SHA-256 hex of a document's raw bytes (or text). */
export function hashDocumentContent(data: Uint8Array | string): string {
  return sha256Hex(data);
}

export interface HasContentHash {
  id: string;
  workspaceId: string;
  contentHash: string;
}

/**
 * Returns the id of an existing document in the SAME workspace with the same
 * content hash, or `undefined` if the content is new. Dedup is workspace-scoped
 * so identical bytes uploaded by two tenants never collide (they must not share
 * a document), mirroring the `uq_documents_content(workspace_id, content_hash)`
 * index.
 */
export function findDuplicateByContent(
  workspaceId: string,
  contentHash: string,
  existing: Iterable<HasContentHash>,
): string | undefined {
  for (const doc of existing) {
    if (doc.workspaceId === workspaceId && doc.contentHash === contentHash) {
      return doc.id;
    }
  }
  return undefined;
}

/** Returns true if the content hash already exists in the given workspace. */
export function isDuplicateContent(
  workspaceId: string,
  contentHash: string,
  existing: Iterable<HasContentHash>,
): boolean {
  return findDuplicateByContent(workspaceId, contentHash, existing) !== undefined;
}
