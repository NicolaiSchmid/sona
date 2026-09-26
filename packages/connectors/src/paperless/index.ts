/**
 * Read-only Paperless-ngx import: a thin client interface with a deterministic
 * fake and a `fetch`-backed implementation, pure policy helpers, and sync
 * orchestration over injected stores. Originals are copied into Sona storage
 * with provenance pointing back at the Paperless document; the archive is
 * never modified and the cursor lives on Sona's side.
 */

export {
  createPaperlessHttpClient,
  type PaperlessConnectionSettings,
  type PaperlessFetch,
  type PaperlessHttpClientInput,
  type PaperlessHttpRequestInit,
  type PaperlessHttpResponse,
  resolvePaperlessBaseUrl,
} from "./client.js";
export {
  PaperlessBaseUrlRejectedError,
  PaperlessClientError,
  PaperlessDocumentTooLargeError,
  type PaperlessOperation,
  PaperlessReadOnlyViolationError,
} from "./errors.js";
export {
  FakePaperlessClient,
  type FakePaperlessClientOptions,
  type FakePaperlessDocument,
} from "./fake-client.js";
export {
  compareDocumentOrder,
  DEFAULT_ALLOWED_MIME_TYPES,
  DEFAULT_MAX_DOCUMENT_BYTES,
  isTagAllowed,
  mediaType,
  type NameLookup,
  nameLookup,
  PAPERLESS_IMPORT_RULES_VERSION,
  type PayloadNames,
  paperlessErrorMessage,
  paperlessExternalId,
  paperlessPolicyFingerprint,
  type ResolvedPaperlessSourcePolicy,
  rawPaperlessPayloadJson,
  recordedStoredDocument,
  resolvePaperlessSourcePolicy,
  tagNames,
  toRawPaperlessPayload,
} from "./normalize.js";
export {
  DEFAULT_PAGE_SIZE,
  type IngestedPaperlessDocument,
  type PaperlessCursorResetReason,
  type PaperlessDocumentStore,
  type PaperlessRawRecordStore,
  type PaperlessSyncCursor,
  type PaperlessSyncError,
  type PaperlessSyncRunStore,
  type PaperlessSyncStatus,
  type PaperlessSyncSummary,
  type RawRecordStore,
  type RunPaperlessSyncInput,
  runPaperlessSync,
  type SyncEnv,
} from "./sync.js";
export type * from "./types.js";
