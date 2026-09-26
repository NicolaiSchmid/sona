/**
 * Shapes for the read-only Paperless-ngx import source.
 *
 * Paperless stays an adapter: Sona lists documents, downloads originals, and
 * copies them into its own storage with provenance pointing back at the
 * Paperless document id. The client interface has no method that could
 * create, edit, tag, or delete anything on the Paperless side, and the
 * `content` (OCR text) field is never requested or stored.
 */

export interface PaperlessNamedEntity {
  id: number;
  name: string;
}

export type PaperlessTag = PaperlessNamedEntity;
export type PaperlessCorrespondent = PaperlessNamedEntity;
export type PaperlessDocumentType = PaperlessNamedEntity;

/** Metadata of one Paperless document; no OCR content, no notes, no owner. */
export interface PaperlessDocument {
  id: number;
  title: string;
  /** ISO-8601 timestamps as returned by Paperless. */
  created: string;
  modified: string;
  added: string;
  correspondentId: number | undefined;
  documentTypeId: number | undefined;
  tagIds: readonly number[];
  archiveSerialNumber: number | undefined;
  originalFileName: string | undefined;
  /** Declared MIME type of the original, when the instance reports it. */
  mimeType: string | undefined;
}

export interface PaperlessPage<T> {
  results: T[];
  /** Whether another page exists after this one. */
  hasMore: boolean;
}

export interface ListDocumentsInput {
  /** Only documents modified at or after this ISO timestamp. */
  modifiedSince: string | undefined;
  /** 1-based page number, ordered by `(modified, id)` ascending. */
  page: number;
  pageSize: number;
}

export interface DownloadOriginalInput {
  documentId: number;
  /** Hard cap; the client must fail rather than return more bytes. */
  maxBytes: number;
}

export interface PaperlessDownload {
  bytes: Uint8Array;
  /** `Content-Type` of the download response, lower-cased, without parameters. */
  contentType: string | undefined;
}

/**
 * Read-only Paperless access. Deliberately no create/update/delete/bulk-edit
 * operations; the sync cannot mutate the archive even by mistake.
 */
export interface PaperlessClient {
  /** Workspace whose credentials this client authenticates with; syncs refuse a mismatch. */
  readonly workspaceId: string;
  /** Hostname of the configured instance, recorded as provenance. Never a URL with credentials. */
  readonly instanceHost: string;
  listTags(): Promise<PaperlessTag[]>;
  listCorrespondents(): Promise<PaperlessCorrespondent[]>;
  listDocumentTypes(): Promise<PaperlessDocumentType[]>;
  listDocuments(input: ListDocumentsInput): Promise<PaperlessPage<PaperlessDocument>>;
  downloadOriginal(input: DownloadOriginalInput): Promise<PaperlessDownload>;
}

/** Per-source import policy. All fields have conservative defaults. */
export interface PaperlessSourcePolicy {
  /**
   * Import only documents carrying at least one of these tag names
   * (case-insensitive). When empty, every document is imported.
   */
  requiredTagNames?: readonly string[];
  /** Lower-cased MIME types to import. Default: PDF plus common image types. */
  allowedMimeTypes?: readonly string[];
  /** Originals larger than this are skipped and counted. Default 50 MiB. */
  maxDocumentBytes?: number;
  /** ISO timestamp bounding the very first sync (no cursor yet). */
  initialModifiedSince?: string;
}

export type PaperlessSkipReason =
  | "tag_not_allowed"
  | "mime_type_not_allowed"
  | "above_size_limit"
  /** Downloaded bytes did not carry the signature of the declared type. */
  | "content_type_mismatch";

/** What was stored for a document: hash and size, never the bytes. */
export interface RawPaperlessStoredDocument {
  contentHash: string;
  byteLength: number;
  mimeType: string;
}

/**
 * Metadata written to the raw source vault. Tag/correspondent/type names are
 * resolved at import time so the record stays readable if Paperless renames
 * them later; OCR content is intentionally absent.
 */
export interface RawPaperlessDocumentPayload {
  kind: "paperless_document";
  instanceHost: string;
  paperlessId: number;
  title: string;
  created: string;
  modified: string;
  added: string;
  correspondent: string | undefined;
  documentType: string | undefined;
  tags: readonly string[];
  archiveSerialNumber: number | undefined;
  originalFileName: string | undefined;
  document: RawPaperlessStoredDocument;
}
