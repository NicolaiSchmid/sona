/**
 * Email sync orchestration.
 *
 * For each new message in the configured folder (UID cursor, scanned in
 * pages), the sync applies the sender allowlist, selects attachments by
 * MIME/size policy, downloads only those parts, verifies the bytes match the
 * declared type, stores them through the {@link DocumentStorage} boundary
 * with content-hash dedup, and finally appends a redacted metadata record to
 * the raw source vault. The raw record is written last so it doubles as the
 * commit marker for message-id dedup: a crash before it leaves nothing that
 * would hide the message from the next run, and document dedup makes that
 * retry cheap. When a policy change re-admits parts of an already recorded
 * message, only those parts are fetched and a superseding raw record is
 * appended.
 *
 * Mailbox access is read-only: the {@link ImapClient} interface exposes no
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
import type { RawRecordStore, SyncEnv } from "../shared.js";
import { AttachmentUnavailableError } from "./errors.js";
import { matchesDeclaredMimeType } from "./mime-signatures.js";
import {
  errorMessageRedacted,
  isSenderAllowed,
  messageExternalId,
  policyFingerprint,
  rawEmailPayloadJson,
  recordedAttachments,
  resolveEmailSourcePolicy,
  selectAttachments,
  toRawEmailPayload,
} from "./normalize.js";
import type {
  AttachmentSkipReason,
  EmailAttachmentPart,
  EmailMessageSummary,
  EmailSourcePolicy,
  ImapClient,
  OpenedFolder,
  RawEmailAttachment,
} from "./types.js";

export type { RawRecordStore, SyncEnv } from "../shared.js";

/** Where the last successful sync stopped, per folder. */
export interface EmailSyncCursor {
  folder: string;
  /** Mailbox UIDVALIDITY the UIDs belong to; a change invalidates the cursor. */
  uidValidity: string;
  /** Highest UID up to which every message was processed successfully. */
  lastUid: number;
  /** Fingerprint of the ingestion policy the cursor was built under; a change triggers a rescan. */
  policyHash: string;
}

export type EmailSyncStatus = "succeeded" | "completed_with_errors" | "failed";

export type EmailCursorResetReason = "uid_validity_changed" | "policy_changed";

export interface EmailSyncError {
  /** Message UID the error relates to; `undefined` for connection/folder-level failures. */
  uid: number | undefined;
  /** Redacted: never contains addresses, filenames, or credentials. */
  message: string;
}

/**
 * Counts, redacted errors, and the cursor — no message content. The cursor
 * carries the configured folder name, which is operator configuration rather
 * than mail content, but treat it as workspace data all the same.
 */
export interface EmailSyncSummary {
  runId: string;
  messagesSeen: number;
  messagesIngested: number;
  messagesSkippedNotAllowlisted: number;
  messagesSkippedDuplicate: number;
  messagesWithoutDocuments: number;
  attachmentsStored: number;
  attachmentsDeduplicated: number;
  attachmentsSkipped: number;
  /** Set when a previous cursor existed but could not be reused. */
  cursorReset: EmailCursorResetReason | undefined;
  cursor: EmailSyncCursor | undefined;
  errors: EmailSyncError[];
}

export interface EmailSyncRunStore {
  start(run: {
    runId: string;
    workspaceId: string;
    sourceId: string;
    startedAt: string;
  }): Promise<void>;
  recordError(error: {
    runId: string;
    uid: number | undefined;
    message: string;
    at: string;
  }): Promise<void>;
  /** `summary.cursor` is the cursor to persist for `latestCursor`; `undefined` on failed runs. */
  finish(run: {
    runId: string;
    status: EmailSyncStatus;
    finishedAt: string;
    summary: EmailSyncSummary;
  }): Promise<void>;
  /** Cursor recorded by the most recent finished run for this source and folder. */
  latestCursor(input: {
    workspaceId: string;
    sourceId: string;
    folder: string;
  }): Promise<EmailSyncCursor | undefined>;
}

export interface EmailRawRecordStore extends RawRecordStore {
  /** Most recent record for the identity (the latest superseding one, if any). */
  findByExternalId(
    workspaceId: string,
    sourceId: string,
    externalId: string,
  ): Promise<RawSourceRecord | undefined>;
}

/**
 * Document row produced by email ingestion. Assignable to `@sona/receipts`'
 * `StoredDocument`, with the email-specific literals fixed.
 */
export interface IngestedEmailDocument {
  id: string;
  workspaceId: string;
  contentHash: string;
  mimeType: string;
  originalFilename: string;
  storageUri: string;
  sourceKind: "email";
  sourceMetadata: JsonValue;
  retentionState: "active";
  createdAt: string;
}

export interface EmailDocumentStore {
  findByContentHash(workspaceId: string, contentHash: string): Promise<{ id: string } | undefined>;
  /**
   * Inserts the row, or returns the existing row when the content hash is
   * already present (concurrent import). The returned id tells the caller
   * whether its bytes are referenced.
   */
  save(document: IngestedEmailDocument): Promise<{ id: string }>;
}

/** Messages fetched per IMAP round trip when {@link RunEmailSyncInput.batchSize} is not set. */
export const DEFAULT_BATCH_SIZE = 200;

export interface RunEmailSyncInput {
  workspaceId: string;
  sourceId: string;
  client: ImapClient;
  policy?: EmailSourcePolicy;
  runStore: EmailSyncRunStore;
  rawStore: EmailRawRecordStore;
  documentStore: EmailDocumentStore;
  documentStorage: DocumentStorage;
  env: SyncEnv;
  /**
   * Messages fetched per IMAP round trip; default {@link DEFAULT_BATCH_SIZE}.
   * Transport tuning only — deliberately not part of the policy fingerprint.
   */
  batchSize?: number;
}

/** URI recorded on the document row for bytes held by the `DocumentStorage` backend. */
export function documentStorageUri(workspaceId: string, documentId: string): string {
  return `sona-document://${encodeURIComponent(workspaceId)}/${encodeURIComponent(documentId)}`;
}

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/tiff": "tiff",
  "image/webp": "webp",
};

function attachmentFilename(message: EmailMessageSummary, part: EmailAttachmentPart): string {
  if (part.filename !== undefined && part.filename.trim().length > 0) {
    return part.filename.trim();
  }
  const extension = MIME_EXTENSIONS[part.mimeType] ?? "bin";
  return `email-${message.uid}-part-${part.partId}.${extension}`;
}

type AttachmentOutcome =
  | { kind: "stored" | "deduplicated"; entry: RawEmailAttachment }
  | { kind: "skipped"; reason: AttachmentSkipReason };

interface ResolvedCursor {
  cursor: EmailSyncCursor;
  reset: EmailCursorResetReason | undefined;
}

/**
 * Decides whether the previous cursor can be resumed. A changed UIDVALIDITY
 * means the server renumbered the folder, and a changed policy means earlier
 * skips may now be wanted: either way start over. Message-id and content-hash
 * dedup keep the rescan from producing duplicates.
 */
function resolveCursor(
  previous: EmailSyncCursor | undefined,
  opened: OpenedFolder,
  policyHash: string,
): ResolvedCursor {
  let reset: EmailCursorResetReason | undefined;
  if (previous !== undefined && previous.uidValidity !== opened.uidValidity) {
    reset = "uid_validity_changed";
  } else if (previous !== undefined && previous.policyHash !== policyHash) {
    reset = "policy_changed";
  }
  const reusable = previous !== undefined && reset === undefined;
  return {
    cursor: {
      folder: opened.folder,
      uidValidity: opened.uidValidity,
      lastUid: reusable ? previous.lastUid : 0,
      policyHash,
    },
    reset,
  };
}

export async function runEmailSync(input: RunEmailSyncInput): Promise<EmailSyncSummary> {
  const { workspaceId, sourceId, client, runStore, rawStore, documentStore, documentStorage, env } =
    input;
  if (client.workspaceId !== workspaceId) {
    // A client authenticates with one workspace's credentials; its mail must
    // never be written under another workspace.
    throw new Error("IMAP client is bound to a different workspace than the sync");
  }
  const policy = resolveEmailSourcePolicy(input.policy);
  const policyHash = policyFingerprint(policy);
  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE;
  const context = createWorkspaceContext({ workspaceId });

  const runId = env.ids();
  await runStore.start({ runId, workspaceId, sourceId, startedAt: env.nowIso() });

  const summary: EmailSyncSummary = {
    runId,
    messagesSeen: 0,
    messagesIngested: 0,
    messagesSkippedNotAllowlisted: 0,
    messagesSkippedDuplicate: 0,
    messagesWithoutDocuments: 0,
    attachmentsStored: 0,
    attachmentsDeduplicated: 0,
    attachmentsSkipped: 0,
    cursorReset: undefined,
    cursor: undefined,
    errors: [],
  };

  /** Records a redacted error; returns the redacted message. */
  const fail = async (uid: number | undefined, error: unknown): Promise<string> => {
    const message = errorMessageRedacted(error);
    summary.errors.push({ uid, message });
    try {
      await runStore.recordError({ runId, uid, message, at: env.nowIso() });
    } catch (storeError) {
      // The run must still reach a terminal status; keep the store failure
      // visible in the summary that `finish` persists.
      summary.errors.push({
        uid,
        message: `recording the error failed: ${errorMessageRedacted(storeError)}`,
      });
    }
    return message;
  };

  const finish = async (status: EmailSyncStatus): Promise<void> => {
    await runStore.finish({ runId, status, finishedAt: env.nowIso(), summary });
  };

  /**
   * Stores one document; storage/database errors are re-thrown without the
   * filename. Returns `deduplicated` when a concurrent import won the race.
   */
  const storeDocument = async (
    message: EmailMessageSummary,
    externalId: string,
    part: EmailAttachmentPart,
    bytes: Uint8Array,
    contentHash: string,
  ): Promise<"stored" | "deduplicated"> => {
    const filename = attachmentFilename(message, part);
    const documentId = env.ids();
    const createdAt = env.nowIso();
    const dropBlob = (): Promise<void> =>
      documentStorage.delete({ context, id: documentId }).catch(() => undefined);
    try {
      await documentStorage.put({
        context,
        id: documentId,
        bytes,
        contentType: part.mimeType,
        originalFilename: filename,
        createdAt,
        metadata: { sourceId, messageExternalId: externalId, partId: part.partId },
      });
      let saved: { id: string };
      try {
        saved = await documentStore.save({
          id: documentId,
          workspaceId,
          contentHash,
          mimeType: part.mimeType,
          originalFilename: filename,
          storageUri: documentStorageUri(workspaceId, documentId),
          sourceKind: "email",
          sourceMetadata: {
            sourceId,
            messageExternalId: externalId,
            folder: message.folder,
            uid: message.uid,
            partId: part.partId,
            messageId: message.messageId ?? null,
            fromAddress: message.from?.address ?? null,
            subject: message.subject ?? null,
            date: message.date ?? null,
          },
          retentionState: "active",
          createdAt,
        });
      } catch (error) {
        // No row means no reference: drop the blob so the retry does not leave an orphan.
        await dropBlob();
        throw error;
      }
      if (saved.id !== documentId) {
        // Another writer stored the same bytes between our hash lookup and
        // save; the row references its blob, not ours.
        await dropBlob();
        return "deduplicated";
      }
      return "stored";
    } catch (error) {
      // Storage/database errors often quote paths or filenames; keep those out of run records.
      throw new Error(
        `storing part ${part.partId} of UID ${message.uid} failed: ${errorMessageRedacted(error, [filename])}`,
      );
    }
  };

  /** Downloads, verifies, and stores one attachment. */
  const ingestAttachment = async (
    message: EmailMessageSummary,
    externalId: string,
    part: EmailAttachmentPart,
  ): Promise<AttachmentOutcome> => {
    let bytes: Uint8Array;
    try {
      bytes = await client.fetchAttachment({
        folder: message.folder,
        uid: message.uid,
        partId: part.partId,
        maxBytes: policy.maxAttachmentBytes,
      });
    } catch (error) {
      if (error instanceof AttachmentUnavailableError) {
        // Will never succeed on retry; skipping keeps the cursor moving.
        return { kind: "skipped", reason: error.reason };
      }
      throw error;
    }
    // Declared sizes and Content-Types are server/sender-supplied; re-check the
    // image floor on real bytes and never store bytes as a type they are not
    // (e.g. HTML labelled as PDF).
    if (part.mimeType.startsWith("image/") && bytes.byteLength < policy.minImageBytes) {
      return { kind: "skipped", reason: "below_size_threshold" };
    }
    if (!matchesDeclaredMimeType(bytes, part.mimeType)) {
      return { kind: "skipped", reason: "content_type_mismatch" };
    }
    const contentHash = sha256Hex(bytes);
    const entry: RawEmailAttachment = {
      partId: part.partId,
      // Raw record keeps the header value verbatim; the document row gets the trimmed name.
      filename: part.filename,
      mimeType: part.mimeType,
      byteLength: bytes.byteLength,
      contentHash,
    };
    if ((await documentStore.findByContentHash(workspaceId, contentHash)) !== undefined) {
      return { kind: "deduplicated", entry };
    }
    const kind = await storeDocument(message, externalId, part, bytes, contentHash);
    return { kind, entry };
  };

  const ingestMessage = async (message: EmailMessageSummary): Promise<void> => {
    if (!isSenderAllowed(message.from, policy.allowedSenders)) {
      summary.messagesSkippedNotAllowlisted += 1;
      return;
    }
    const externalId = messageExternalId(message);
    const existing = await rawStore.findByExternalId(workspaceId, sourceId, externalId);
    const alreadyKept = existing === undefined ? [] : recordedAttachments(existing.payloadJson);
    const keptPartIds = new Set(alreadyKept.map((attachment) => attachment.partId));

    // Parts already on the recorded message are not fetched again; a policy
    // change can only add parts, and those get a superseding record below.
    const selection = selectAttachments(message.attachments, policy);
    const pending = selection.selected.filter((part) => !keptPartIds.has(part.partId));
    if (existing !== undefined && pending.length === 0) {
      summary.messagesSkippedDuplicate += 1;
      return;
    }
    summary.attachmentsSkipped += selection.skipped.length;

    const stored: RawEmailAttachment[] = [];
    for (const part of pending) {
      const outcome = await ingestAttachment(message, externalId, part);
      switch (outcome.kind) {
        case "stored":
          summary.attachmentsStored += 1;
          stored.push(outcome.entry);
          break;
        case "deduplicated":
          summary.attachmentsDeduplicated += 1;
          stored.push(outcome.entry);
          break;
        case "skipped":
          summary.attachmentsSkipped += 1;
          if (outcome.reason === "part_unavailable") {
            // Not a policy decision: the server advertised a part it did not
            // return. Surface it without pinning the cursor on it.
            await fail(
              message.uid,
              new Error(`part ${part.partId} was not returned by the server; skipped`),
            );
          }
          break;
      }
    }
    if (stored.length === 0) {
      if (existing === undefined) {
        // Nothing evidentiary to keep, so no metadata is recorded either.
        summary.messagesWithoutDocuments += 1;
      } else {
        summary.messagesSkippedDuplicate += 1;
      }
      return;
    }

    const at = env.nowIso();
    const recordInput = {
      id: env.ids(),
      externalId,
      recordType: "document",
      payloadJson: rawEmailPayloadJson(toRawEmailPayload(message, [...alreadyKept, ...stored])),
      observedAt: message.date ?? at,
      createdAt: at,
    } as const;
    await rawStore.append(
      existing === undefined
        ? createRawSourceRecord({ ...recordInput, workspaceId, sourceId })
        : supersedeRawSourceRecord(existing, recordInput),
    );
    summary.messagesIngested += 1;
  };

  /**
   * One page of messages past `sinceUid`, ascending. Re-filtered and sorted
   * here so the cursor invariant below holds for any `ImapClient`
   * implementation, not only the shipped ones.
   */
  const fetchBatch = async (
    sinceUid: number,
    sinceDate: string | undefined,
  ): Promise<EmailMessageSummary[]> =>
    (
      await client.fetchMessagesSince({
        folder: policy.folder,
        sinceUid,
        sinceDate,
        limit: batchSize,
      })
    )
      .filter((message) => message.uid > sinceUid)
      .sort((a, b) => a.uid - b.uid);

  let cursor: EmailSyncCursor;
  let sinceDate: string | undefined;
  let batch: EmailMessageSummary[];
  try {
    await client.connect();
    const opened = await client.openFolder(policy.folder);
    const previous = await runStore.latestCursor({ workspaceId, sourceId, folder: policy.folder });
    const resolved = resolveCursor(previous, opened, policyHash);
    cursor = resolved.cursor;
    summary.cursorReset = resolved.reset;
    // Only a scan from UID 0 is date-bounded; later pages of the same scan keep the bound.
    sinceDate = cursor.lastUid === 0 ? policy.initialSinceDate : undefined;
    batch = await fetchBatch(cursor.lastUid, sinceDate);
  } catch (error) {
    const message = await fail(undefined, error);
    await disconnectQuietly(client);
    await finish("failed");
    // Re-throw the redacted form only; the raw error may carry addresses.
    throw new Error(`Email sync failed: ${message}`);
  }

  try {
    // The cursor only advances while every earlier message is durable, so the
    // first failure pins it: that message is retried next run. Later messages
    // are still processed so one poisoned message cannot block newer invoices;
    // message-id and content dedup make re-seeing them cheap.
    let cursorPinned = false;
    for (let last = batch.at(-1); last !== undefined; last = batch.at(-1)) {
      for (const message of batch) {
        summary.messagesSeen += 1;
        try {
          await ingestMessage(message);
          if (!cursorPinned) {
            cursor.lastUid = message.uid;
          }
        } catch (error) {
          cursorPinned = true;
          await fail(message.uid, error);
        }
      }
      try {
        // Loop until an empty page so a page shrunk by a concurrent expunge
        // cannot end the scan early.
        batch = await fetchBatch(last.uid, sinceDate);
      } catch (error) {
        // Progress so far is kept; the next run resumes from the cursor.
        await fail(undefined, error);
        break;
      }
    }
  } finally {
    await disconnectQuietly(client);
  }

  summary.cursor = cursor;
  await finish(summary.errors.length > 0 ? "completed_with_errors" : "succeeded");
  return summary;
}

async function disconnectQuietly(client: ImapClient): Promise<void> {
  try {
    await client.disconnect();
  } catch {
    // A failed LOGOUT must not mask the sync outcome; the socket is dropped anyway.
  }
}
