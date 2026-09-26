/**
 * Pure helpers for the Paperless import: policy resolution and fingerprint,
 * tag filtering, cursor ordering, and the redacted raw-record payload. No I/O.
 */
import { type JsonValue, stableJsonHash } from "@sona/core";
import { DEFAULT_ALLOWED_MIME_TYPES, redactSensitiveText } from "../email/normalize.js";
import { toJsonValue } from "../shared.js";
import type {
  PaperlessDocument,
  PaperlessNamedEntity,
  PaperlessSourcePolicy,
  RawPaperlessDocumentPayload,
  RawPaperlessStoredDocument,
} from "./types.js";

export { DEFAULT_ALLOWED_MIME_TYPES } from "../email/normalize.js";

export const DEFAULT_MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

/**
 * Version of the code-level import rules. Part of the policy fingerprint so a
 * rule fix triggers a rescan of documents those rules skipped.
 */
export const PAPERLESS_IMPORT_RULES_VERSION = 1;

export interface ResolvedPaperlessSourcePolicy {
  requiredTagNames: ReadonlySet<string>;
  allowedMimeTypes: ReadonlySet<string>;
  maxDocumentBytes: number;
  initialModifiedSince: string | undefined;
}

export function resolvePaperlessSourcePolicy(
  policy: PaperlessSourcePolicy = {},
): ResolvedPaperlessSourcePolicy {
  if (
    policy.initialModifiedSince !== undefined &&
    Number.isNaN(Date.parse(policy.initialModifiedSince))
  ) {
    throw new Error("initialModifiedSince must be an ISO-8601 timestamp");
  }
  const maxDocumentBytes = policy.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
  if (!Number.isInteger(maxDocumentBytes) || maxDocumentBytes <= 0) {
    throw new Error("maxDocumentBytes must be a positive integer");
  }
  return {
    requiredTagNames: new Set(
      (policy.requiredTagNames ?? [])
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name.length > 0),
    ),
    allowedMimeTypes: new Set(
      (policy.allowedMimeTypes ?? DEFAULT_ALLOWED_MIME_TYPES).map((type) => type.toLowerCase()),
    ),
    maxDocumentBytes,
    initialModifiedSince: policy.initialModifiedSince,
  };
}

/** Stable hash of the fields that decide whether a document is imported. */
export function paperlessPolicyFingerprint(policy: ResolvedPaperlessSourcePolicy): string {
  return stableJsonHash({
    rulesVersion: PAPERLESS_IMPORT_RULES_VERSION,
    requiredTagNames: [...policy.requiredTagNames].sort(),
    allowedMimeTypes: [...policy.allowedMimeTypes].sort(),
    maxDocumentBytes: policy.maxDocumentBytes,
  });
}

/** `id → name` lookup for tags, correspondents, and document types. */
export type NameLookup = ReadonlyMap<number, string>;

export function nameLookup(entities: readonly PaperlessNamedEntity[]): NameLookup {
  return new Map(entities.map((entity) => [entity.id, entity.name]));
}

/** Resolved tag names of a document; unknown ids are kept as `#<id>` so nothing is silently lost. */
export function tagNames(document: PaperlessDocument, tags: NameLookup): string[] {
  return document.tagIds.map((id) => tags.get(id) ?? `#${id}`);
}

/** Whether the document carries at least one required tag (or no tags are required). */
export function isTagAllowed(
  document: PaperlessDocument,
  tags: NameLookup,
  policy: ResolvedPaperlessSourcePolicy,
): boolean {
  if (policy.requiredTagNames.size === 0) {
    return true;
  }
  return tagNames(document, tags).some((name) => policy.requiredTagNames.has(name.toLowerCase()));
}

/**
 * Sync order and cursor position: `(modified, id)`. Timestamps are compared as
 * instants, so an instance that renders offsets differently between calls
 * cannot reorder documents.
 */
export function compareDocumentOrder(
  a: Pick<PaperlessDocument, "modified" | "id">,
  b: Pick<PaperlessDocument, "modified" | "id">,
): number {
  const byModified = Date.parse(a.modified) - Date.parse(b.modified);
  return byModified !== 0 ? byModified : a.id - b.id;
}

export function paperlessExternalId(documentId: number): string {
  return `paperless:${documentId}`;
}

export interface PayloadNames {
  tags: NameLookup;
  correspondents: NameLookup;
  documentTypes: NameLookup;
}

export function toRawPaperlessPayload(
  instanceHost: string,
  document: PaperlessDocument,
  names: PayloadNames,
  stored: RawPaperlessStoredDocument,
): RawPaperlessDocumentPayload {
  return {
    kind: "paperless_document",
    instanceHost,
    paperlessId: document.id,
    title: document.title,
    created: document.created,
    modified: document.modified,
    added: document.added,
    correspondent:
      document.correspondentId === undefined
        ? undefined
        : (names.correspondents.get(document.correspondentId) ?? `#${document.correspondentId}`),
    documentType:
      document.documentTypeId === undefined
        ? undefined
        : (names.documentTypes.get(document.documentTypeId) ?? `#${document.documentTypeId}`),
    tags: tagNames(document, names.tags),
    archiveSerialNumber: document.archiveSerialNumber,
    originalFileName: document.originalFileName,
    document: stored,
  };
}

/** `JsonValue` view of the payload (drops `undefined` fields like JSON does). */
export function rawPaperlessPayloadJson(payload: RawPaperlessDocumentPayload): JsonValue {
  return toJsonValue(payload);
}

/**
 * The stored-document entry of a previously recorded payload, so a rescan can
 * decide whether anything changed without downloading. Malformed entries are
 * ignored rather than trusted.
 */
export function recordedStoredDocument(payload: JsonValue): RawPaperlessStoredDocument | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const document = payload["document"];
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    return undefined;
  }
  const { contentHash, byteLength, mimeType } = document;
  if (
    typeof contentHash === "string" &&
    typeof byteLength === "number" &&
    typeof mimeType === "string"
  ) {
    return { contentHash, byteLength, mimeType };
  }
  return undefined;
}

/** Strips a `Content-Type` header down to its lower-cased media type. */
export function mediaType(contentType: string | undefined | null): string | undefined {
  if (contentType === undefined || contentType === null) {
    return undefined;
  }
  const type = contentType.split(";")[0]?.trim().toLowerCase();
  return type === undefined || type.length === 0 ? undefined : type;
}

/**
 * Redacts a Paperless error for run records: caller-supplied secrets (the API
 * token), email addresses, and anything that looks like a URL query string.
 */
export function paperlessErrorMessage(error: unknown, secrets: readonly string[] = []): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(message, secrets).replace(/\?[^\s)]*/g, "?[redacted]");
}
