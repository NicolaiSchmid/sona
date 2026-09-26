/**
 * Read-only email (IMAP) invoice ingestion: a thin client interface with a
 * deterministic fake and an `imapflow`-backed implementation, pure allowlist /
 * attachment policy helpers, and sync orchestration over injected stores.
 * Mail is never moved, flagged, or deleted; the cursor lives on Sona's side.
 */

export {
  AttachmentUnavailableError,
  type AttachmentUnavailableReason,
  ImapClientError,
  type ImapOperation,
} from "./errors.js";
export {
  type FakeFolder,
  FakeImapClient,
  type FakeImapClientOptions,
  type FakeImapCommand,
  type FakeMessage,
  ImapReadOnlyViolationError,
  type MutatingImapCommand,
} from "./fake-imap-client.js";
export {
  createImapFlowClient,
  type ImapConnectionSettings,
  type ImapFlowClientInput,
  type ImapFlowFactory,
  type ImapFlowLike,
} from "./imap-client.js";
export { matchesDeclaredMimeType } from "./mime-signatures.js";
export {
  DEFAULT_ALLOWED_MIME_TYPES,
  DEFAULT_FOLDER,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  DEFAULT_MIN_IMAGE_BYTES,
  errorMessageRedacted,
  isSenderAllowed,
  messageExternalId,
  normalizeMessageId,
  policyFingerprint,
  type ResolvedEmailSourcePolicy,
  rawEmailPayloadJson,
  redactSensitiveText,
  resolveEmailSourcePolicy,
  selectAttachments,
  toRawEmailPayload,
} from "./normalize.js";
export {
  DEFAULT_BATCH_SIZE,
  documentStorageUri,
  type EmailCursorResetReason,
  type EmailDocumentStore,
  type EmailRawRecordStore,
  type EmailSyncCursor,
  type EmailSyncError,
  type EmailSyncRunStore,
  type EmailSyncStatus,
  type EmailSyncSummary,
  type IngestedEmailDocument,
  type RawRecordStore,
  type RunEmailSyncInput,
  runEmailSync,
  type SyncEnv,
} from "./sync.js";
export type * from "./types.js";
