/**
 * Paperless import orchestration.
 *
 * Documents are scanned in `(modified, id)` order from the cursor of the last
 * finished run. For each document the sync applies the tag and MIME policy,
 * downloads the original, verifies its bytes match the declared type, stores
 * it through the {@link DocumentStorage} boundary with content-hash dedup,
 * and appends a redacted metadata record to the raw source vault. The raw
 * record is written last so it doubles as the commit marker: a crash before
 * it leaves nothing that would hide the document from the next run, and hash
 * dedup makes that retry cheap.
 *
 * Re-syncing an unchanged archive imports nothing: a document whose metadata
 * and stored hash match its recorded payload is skipped without a download.
 * When metadata changed (retagged, renamed) a superseding raw record is
 * appended; the original bytes are deduplicated by hash.
 *
 * Paperless is never written to: the {@link PaperlessClient} interface has no
 * mutating operation, and the cursor lives on Sona's side.
 */
import {
  createRawSourceRecord,
  createWorkspaceContext,
  type DocumentStorage,
  type JsonValue,
  type RawSourceRecord,
  sha256Hex,
  supersedeRawSourceRecord,
} from "@sona/core";
import { matchesDeclaredMimeType } from "../email/mime-signatures.js";
import { documentStorageUri } from "../email/sync.js";
import type { RawRecordStore, SyncEnv, SyncStatus } from "../shared.js";
import { PaperlessDocumentTooLargeError } from "./errors.js";
import {
  compareDocumentOrder,
  isTagAllowed,
  nameLookup,
  type PayloadNames,
  paperlessErrorMessage,
  paperlessExternalId,
  paperlessPolicyFingerprint,
  rawPaperlessPayloadJson,
  recordedStoredDocument,
  resolvePaperlessSourcePolicy,
  toRawPaperlessPayload,
} from "./normalize.js";
import type {
  PaperlessClient,
  PaperlessDocument,
  PaperlessSkipReason,
  PaperlessSourcePolicy,
  RawPaperlessStoredDocument,
} from "./types.js";

export type { RawRecordStore, SyncEnv } from "../shared.js";

/** Where the last successful sync stopped. */
export interface PaperlessSyncCursor {
  /** `modified` timestamp of the last fully processed document. */
  lastModified: string;
  /** Its Paperless id, to break ties among documents modified at the same instant. */
  lastDocumentId: number;
  /** Fingerprint of the import policy the cursor was built under; a change triggers a rescan. */
  policyHash: string;
}

export type PaperlessSyncStatus = SyncStatus;

export type PaperlessCursorResetReason = "policy_changed";

export interface PaperlessSyncError {
  /** Paperless document id the error relates to; `undefined` for listing-level failures. */
  documentId: number | undefined;
  /** Redacted: never contains the token, titles, or filenames. */
  message: string;
}

/** Counts, redacted errors, and the cursor — no document content or titles. */
export interface PaperlessSyncSummary {
  runId: string;
  documentsSeen: number;
  documentsIngested: number;
  documentsSkippedNotAllowlisted: number;
  documentsSkippedDuplicate: number;
  documentsSkippedPolicy: number;
  documentsStored: number;
  documentsDeduplicated: number;
  cursorReset: PaperlessCursorResetReason | undefined;
  cursor: PaperlessSyncCursor | undefined;
  errors: PaperlessSyncError[];
}

export interface PaperlessSyncRunStore {
  start(run: {
    runId: string;
    workspaceId: string;
    sourceId: string;
    startedAt: string;
  }): Promise<void>;
  recordError(error: {
    runId: string;
    documentId: number | undefined;
    message: string;
    at: string;
  }): Promise<void>;
  /** `summary.cursor` is the cursor to persist for `latestCursor`; `undefined` on failed runs. */
  finish(run: {
    runId: string;
    status: PaperlessSyncStatus;
    finishedAt: string;
    summary: PaperlessSyncSummary;
  }): Promise<void>;
  latestCursor(input: {
    workspaceId: string;
    sourceId: string;
  }): Promise<PaperlessSyncCursor | undefined>;
}

export interface PaperlessRawRecordStore extends RawRecordStore {
  /** Most recent record for the identity (the latest superseding one, if any). */
  findByExternalId(
    workspaceId: string,
    sourceId: string,
    externalId: string,
  ): Promise<RawSourceRecord | undefined>;
}

/** Document row produced by Paperless import; assignable to `@sona/receipts`' `StoredDocument`. */
export interface IngestedPaperlessDocument {
  id: string;
  workspaceId: string;
  contentHash: string;
  mimeType: string;
  originalFilename: string;
  storageUri: string;
  sourceKind: "paperless";
  sourceMetadata: JsonValue;
  retentionState: "active";
  createdAt: string;
}

export interface PaperlessDocumentStore {
  findByContentHash(workspaceId: string, contentHash: string): Promise<{ id: string } | undefined>;
  /** Inserts the row, or returns the existing row when the content hash is already present. */
  save(document: IngestedPaperlessDocument): Promise<{ id: string }>;
}

/** Documents listed per API round trip when {@link RunPaperlessSyncInput.pageSize} is not set. */
export const DEFAULT_PAGE_SIZE = 100;

export interface RunPaperlessSyncInput {
  workspaceId: string;
  sourceId: string;
  client: PaperlessClient;
  policy?: PaperlessSourcePolicy;
  runStore: PaperlessSyncRunStore;
  rawStore: PaperlessRawRecordStore;
  documentStore: PaperlessDocumentStore;
  documentStorage: DocumentStorage;
  env: SyncEnv;
  /** Transport tuning only; not part of the policy fingerprint. */
  pageSize?: number;
}

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/tiff": "tiff",
  "image/webp": "webp",
};

function documentFilename(document: PaperlessDocument, mimeType: string): string {
  const original = document.originalFileName?.trim();
  if (original !== undefined && original.length > 0) {
    return original;
  }
  return `paperless-${document.id}.${MIME_EXTENSIONS[mimeType] ?? "bin"}`;
}

type DocumentOutcome =
  | { kind: "stored" | "deduplicated"; stored: RawPaperlessStoredDocument }
  | { kind: "skipped"; reason: PaperlessSkipReason };

/** Whether `document` is at or before the cursor position and therefore already processed. */
function atOrBeforeCursor(document: PaperlessDocument, cursor: PaperlessSyncCursor): boolean {
  return (
    compareDocumentOrder(document, {
      modified: cursor.lastModified,
      id: cursor.lastDocumentId,
    }) <= 0
  );
}

export async function runPaperlessSync(
  input: RunPaperlessSyncInput,
): Promise<PaperlessSyncSummary> {
  const { workspaceId, sourceId, client, runStore, rawStore, documentStore, documentStorage, env } =
    input;
  if (client.workspaceId !== workspaceId) {
    throw new Error("Paperless client is bound to a different workspace than the sync");
  }
  const policy = resolvePaperlessSourcePolicy(input.policy);
  const policyHash = paperlessPolicyFingerprint(policy);
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error("pageSize must be a positive integer");
  }
  const context = createWorkspaceContext({ workspaceId });

  const runId = env.ids();
  await runStore.start({ runId, workspaceId, sourceId, startedAt: env.nowIso() });

  const summary: PaperlessSyncSummary = {
    runId,
    documentsSeen: 0,
    documentsIngested: 0,
    documentsSkippedNotAllowlisted: 0,
    documentsSkippedDuplicate: 0,
    documentsSkippedPolicy: 0,
    documentsStored: 0,
    documentsDeduplicated: 0,
    cursorReset: undefined,
    cursor: undefined,
    errors: [],
  };

  const fail = async (documentId: number | undefined, error: unknown): Promise<string> => {
    const message = paperlessErrorMessage(error);
    summary.errors.push({ documentId, message });
    try {
      await runStore.recordError({ runId, documentId, message, at: env.nowIso() });
    } catch (storeError) {
      summary.errors.push({
        documentId,
        message: `recording the error failed: ${paperlessErrorMessage(storeError)}`,
      });
    }
    return message;
  };

  const finish = async (status: PaperlessSyncStatus): Promise<void> => {
    await runStore.finish({ runId, status, finishedAt: env.nowIso(), summary });
  };

  /** Stores one original; returns `deduplicated` when a concurrent import won the race. */
  const storeDocument = async (
    document: PaperlessDocument,
    names: PayloadNames,
    mimeType: string,
    bytes: Uint8Array,
    contentHash: string,
  ): Promise<"stored" | "deduplicated"> => {
    const filename = documentFilename(document, mimeType);
    const documentId = env.ids();
    const createdAt = env.nowIso();
    const externalId = paperlessExternalId(document.id);
    const dropBlob = async (): Promise<void> => {
      try {
        await documentStorage.delete({ context, id: documentId });
      } catch (error) {
        await fail(
          document.id,
          new Error(
            `removing the orphaned blob failed: ${paperlessErrorMessage(error, [filename, document.title])}`,
          ),
        );
      }
    };
    try {
      await documentStorage.put({
        context,
        id: documentId,
        bytes,
        contentType: mimeType,
        originalFilename: filename,
        createdAt,
        metadata: { sourceId, paperlessExternalId: externalId, instanceHost: client.instanceHost },
      });
      let saved: { id: string };
      try {
        saved = await documentStore.save({
          id: documentId,
          workspaceId,
          contentHash,
          mimeType,
          originalFilename: filename,
          storageUri: documentStorageUri(workspaceId, documentId),
          sourceKind: "paperless",
          sourceMetadata: {
            sourceId,
            instanceHost: client.instanceHost,
            paperlessId: document.id,
            paperlessExternalId: externalId,
            title: document.title,
            created: document.created,
            modified: document.modified,
            tags: [
              ...(names.tags.size === 0
                ? []
                : document.tagIds.map((id) => names.tags.get(id) ?? `#${id}`)),
            ],
            correspondent:
              document.correspondentId === undefined
                ? null
                : (names.correspondents.get(document.correspondentId) ??
                  `#${document.correspondentId}`),
            documentType:
              document.documentTypeId === undefined
                ? null
                : (names.documentTypes.get(document.documentTypeId) ??
                  `#${document.documentTypeId}`),
            archiveSerialNumber: document.archiveSerialNumber ?? null,
          },
          retentionState: "active",
          createdAt,
        });
      } catch (error) {
        await dropBlob();
        if ((await documentStore.findByContentHash(workspaceId, contentHash)) !== undefined) {
          return "deduplicated";
        }
        throw error;
      }
      if (saved.id !== documentId) {
        await dropBlob();
        return "deduplicated";
      }
      return "stored";
    } catch (error) {
      throw new Error(
        `storing document ${document.id} failed: ${paperlessErrorMessage(error, [filename, document.title])}`,
      );
    }
  };

  /** Downloads, verifies, and stores one original. */
  const ingestOriginal = async (
    document: PaperlessDocument,
    names: PayloadNames,
  ): Promise<DocumentOutcome> => {
    let download: Awaited<ReturnType<PaperlessClient["downloadOriginal"]>>;
    try {
      download = await client.downloadOriginal({
        documentId: document.id,
        maxBytes: policy.maxDocumentBytes,
      });
    } catch (error) {
      if (error instanceof PaperlessDocumentTooLargeError) {
        return { kind: "skipped", reason: "above_size_limit" };
      }
      throw error;
    }
    // The listing's type is preferred; the download header is the fallback.
    const mimeType = document.mimeType ?? download.contentType;
    if (mimeType === undefined || !policy.allowedMimeTypes.has(mimeType)) {
      return { kind: "skipped", reason: "mime_type_not_allowed" };
    }
    if (!matchesDeclaredMimeType(download.bytes, mimeType)) {
      return { kind: "skipped", reason: "content_type_mismatch" };
    }
    const contentHash = sha256Hex(download.bytes);
    const stored: RawPaperlessStoredDocument = {
      contentHash,
      byteLength: download.bytes.byteLength,
      mimeType,
    };
    if ((await documentStore.findByContentHash(workspaceId, contentHash)) !== undefined) {
      return { kind: "deduplicated", stored };
    }
    const kind = await storeDocument(document, names, mimeType, download.bytes, contentHash);
    return { kind, stored };
  };

  const ingestDocument = async (
    document: PaperlessDocument,
    names: PayloadNames,
  ): Promise<void> => {
    if (!isTagAllowed(document, names.tags, policy)) {
      summary.documentsSkippedNotAllowlisted += 1;
      return;
    }
    // A listed MIME type outside the policy is skipped before any download.
    if (document.mimeType !== undefined && !policy.allowedMimeTypes.has(document.mimeType)) {
      summary.documentsSkippedPolicy += 1;
      return;
    }
    const externalId = paperlessExternalId(document.id);
    const existing = await rawStore.findByExternalId(workspaceId, sourceId, externalId);
    const recorded =
      existing === undefined ? undefined : recordedStoredDocument(existing.payloadJson);
    if (existing !== undefined && recorded !== undefined) {
      // Unchanged metadata around an already stored original: nothing to do.
      const candidate = createRawSourceRecord({
        id: "candidate",
        workspaceId,
        sourceId,
        externalId,
        recordType: "document",
        payloadJson: rawPaperlessPayloadJson(
          toRawPaperlessPayload(client.instanceHost, document, names, recorded),
        ),
        observedAt: document.modified,
        createdAt: document.modified,
      });
      if (candidate.payloadHash === existing.payloadHash) {
        summary.documentsSkippedDuplicate += 1;
        return;
      }
    }

    const outcome = await ingestOriginal(document, names);
    if (outcome.kind === "skipped") {
      summary.documentsSkippedPolicy += 1;
      return;
    }
    if (outcome.kind === "stored") {
      summary.documentsStored += 1;
    } else {
      summary.documentsDeduplicated += 1;
    }

    const at = env.nowIso();
    const recordInput = {
      id: env.ids(),
      externalId,
      recordType: "document",
      payloadJson: rawPaperlessPayloadJson(
        toRawPaperlessPayload(client.instanceHost, document, names, outcome.stored),
      ),
      observedAt: document.modified,
      createdAt: at,
    } as const;
    await rawStore.append(
      existing === undefined
        ? createRawSourceRecord({ ...recordInput, workspaceId, sourceId })
        : supersedeRawSourceRecord(existing, recordInput),
    );
    summary.documentsIngested += 1;
  };

  /** One page in `(modified, id)` order, re-sorted here so the cursor invariant holds for any client. */
  const fetchPage = async (
    page: number,
    modifiedSince: string | undefined,
  ): Promise<{ documents: PaperlessDocument[]; hasMore: boolean }> => {
    const result = await client.listDocuments({ modifiedSince, page, pageSize });
    return { documents: [...result.results].sort(compareDocumentOrder), hasMore: result.hasMore };
  };

  let cursor: PaperlessSyncCursor | undefined;
  let names: PayloadNames;
  let modifiedSince: string | undefined;
  let page: { documents: PaperlessDocument[]; hasMore: boolean };
  try {
    const previous = await runStore.latestCursor({ workspaceId, sourceId });
    if (previous !== undefined && previous.policyHash !== policyHash) {
      summary.cursorReset = "policy_changed";
      cursor = undefined;
    } else {
      cursor = previous;
    }
    names = {
      tags: nameLookup(await client.listTags()),
      correspondents: nameLookup(await client.listCorrespondents()),
      documentTypes: nameLookup(await client.listDocumentTypes()),
    };
    modifiedSince = cursor?.lastModified ?? policy.initialModifiedSince;
    page = await fetchPage(1, modifiedSince);
  } catch (error) {
    // Nothing has been written yet: a failed listing leaves no partial state.
    const message = await fail(undefined, error);
    await finish("failed");
    throw new Error(`Paperless sync failed: ${message}`);
  }

  // The cursor only advances while every earlier document is durable, so the
  // first failure pins it: that document is retried next run. Later documents
  // are still processed so one poisoned file cannot block newer ones.
  let cursorPinned = false;
  let advanced: PaperlessSyncCursor | undefined = cursor;
  for (let pageNumber = 1; ; pageNumber++) {
    for (const document of page.documents) {
      if (cursor !== undefined && atOrBeforeCursor(document, cursor)) {
        continue;
      }
      summary.documentsSeen += 1;
      try {
        await ingestDocument(document, names);
        if (!cursorPinned) {
          advanced = {
            lastModified: document.modified,
            lastDocumentId: document.id,
            policyHash,
          };
        }
      } catch (error) {
        cursorPinned = true;
        await fail(document.id, error);
      }
    }
    if (!page.hasMore) {
      break;
    }
    try {
      page = await fetchPage(pageNumber + 1, modifiedSince);
    } catch (error) {
      await fail(undefined, error);
      break;
    }
  }

  summary.cursor = advanced;
  await finish(summary.errors.length > 0 ? "completed_with_errors" : "succeeded");
  return summary;
}
