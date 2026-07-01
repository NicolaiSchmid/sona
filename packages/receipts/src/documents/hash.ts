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
  contentHash: string;
}

/**
 * Returns the id of an existing document with the same content hash, or
 * `undefined` if the content is new.
 */
export function findDuplicateByContent(
  contentHash: string,
  existing: Iterable<HasContentHash>,
): string | undefined {
  for (const doc of existing) {
    if (doc.contentHash === contentHash) {
      return doc.id;
    }
  }
  return undefined;
}

/** Returns true if the content hash is already present in `existing`. */
export function isDuplicateContent(
  contentHash: string,
  existing: Iterable<HasContentHash>,
): boolean {
  return findDuplicateByContent(contentHash, existing) !== undefined;
}
