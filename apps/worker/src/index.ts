/**
 * @sona/worker
 *
 * Background jobs: source sync with draft postings, document ingest,
 * extraction, reconciliation, and export generation. Jobs are idempotent by
 * key, retried with backoff, and every attempt is recorded with provenance.
 *
 * The public surface is the composed runtime (`createWorker`), the typed queue
 * the MCP facade enqueues through, the job model, the scheduler, and the
 * handler-level service functions. Id formats stay internal to their modules.
 */

/** Package version marker, used to verify wiring and test discovery. */
export const sonaWorkerVersion = "0.0.0" as const;

export { isWorkerActor, WORKER_ACTORS } from "./actors.js";
export {
  createDocumentIngestHandler,
  DOCUMENT_STORAGE_SCHEME,
  type DocumentIngestDependencies,
  type IngestDocumentInput,
  type IngestDocumentResult,
  ingestDocument,
} from "./jobs/document-ingest.js";
export {
  DRAFT_POSTING_STATES,
  type DraftPostingDependencies,
  type DraftPostingInput,
  type DraftPostingResult,
  type DraftPostingSource,
  type DraftPostingState,
  ensureDraftPosting,
} from "./jobs/draft-postings.js";
export {
  createExportGenerationHandler,
  DEFAULT_TAX_TEMPLATES,
  type ExportGenerationDependencies,
  type GenerateExportInput,
  type GenerateExportResult,
  generateExport,
} from "./jobs/export-generation.js";
export {
  createExtractionHandler,
  DEFAULT_EXTRACTION_REVIEW_MIN_CONFIDENCE,
  type ExtractDocumentInput,
  type ExtractDocumentResult,
  type ExtractionDependencies,
  extractDocument,
} from "./jobs/extraction.js";
export {
  type AcquirePortalFetchJobInput,
  type GetPortalFetchConnectionInput,
  InMemoryPortalFetchConnectionRepository,
  InMemoryPortalFetchJobStateStore,
  InMemoryPortalFetchRunRecorder,
  type PortalFetchConnection,
  type PortalFetchConnectionRepository,
  type PortalFetchJobLeaseKey,
  type PortalFetchJobReservation,
  type PortalFetchJobStateStore,
  type PortalFetchJobStatus,
  type PortalFetchRunRecorder,
  type RecordPortalFetchRunInput,
  type RunPortalFetchJobInput,
  type RunPortalFetchJobResult,
  runPortalFetchJob,
} from "./jobs/portal-fetch.js";
export {
  createPortalFetchHandler,
  DEFAULT_PORTAL_FETCH_COOLDOWN_MS,
  type PortalFetchDependencies,
} from "./jobs/portal-fetch-handler.js";
export {
  type EnqueueOptions,
  type EnqueueResult,
  type JobListFilter,
  JobQueue,
  type JobQueueOptions,
  type JobStatus,
  type PersistedJobRun,
} from "./jobs/queue.js";
export {
  createReconciliationHandler,
  DEFAULT_RECONCILIATION_WINDOW_DAYS,
  type PersistedMatchOutcome,
  RECONCILIATION_SKIP_REASONS,
  type ReconcileDocumentInput,
  type ReconcileDocumentResult,
  type ReconciliationDependencies,
  type ReconciliationSkipReason,
  reconcileDocument,
} from "./jobs/reconciliation.js";
export { redactError, redactJson, redactText } from "./jobs/redact.js";
export {
  type BackoffPolicy,
  backoffMs,
  DEFAULT_BACKOFF_POLICY,
  JOB_RUN_STATES,
  type JobHandler,
  type JobHandlerContext,
  type JobHandlers,
  JobRunner,
  type JobRunnerDependencies,
  type JobRunnerOptions,
  type JobRunOutcome,
  type JobRunState,
  NonRetryableJobError,
  type RunOnceOptions,
} from "./jobs/runner.js";
export {
  type BankSourceSyncResult,
  createSourceSyncHandler,
  type EmailSession,
  type EmailSourceSyncResult,
  type EnableBankingSession,
  isSyncableSourceKind,
  type RunSourceSyncInput,
  runSourceSync,
  type SourceSyncDependencies,
  type SourceSyncGateway,
  type SourceSyncResult,
  SYNCABLE_SOURCE_KINDS,
  type SyncableSourceKind,
  type SyncError,
} from "./jobs/source-sync.js";
export {
  DOCUMENT_SOURCE_KINDS,
  defaultIdempotencyKey,
  EXPORT_MODES,
  type ExportMode,
  InvalidJobPayloadError,
  isJobKind,
  JOB_KINDS,
  JOB_PAYLOAD_SCHEMAS,
  type Job,
  type JobKind,
  type JobPayload,
  type JobPayloadInput,
  type JobPayloadSchemas,
  narrowJob,
  narrowJobKind,
  parseJobPayload,
} from "./jobs/types.js";
export {
  enqueueScheduledSyncs,
  runScheduler,
  type ScheduledSyncFailure,
  type ScheduledSyncs,
  type SchedulerDependencies,
  type SchedulerOptions,
  syncWindowFor,
  type TickOptions,
  type TickResult,
  tick,
} from "./scheduler.js";
export {
  createSecretStoreSourceSyncGateway,
  type SecretStoreSourceSyncGatewayOptions,
} from "./source-sync-gateway.js";
export {
  createWorker,
  createWorkerRepositories,
  WORKER_DEFAULTS,
  type WorkerRepositories,
  type WorkerRuntime,
  type WorkerRuntimeOptions,
} from "./worker.js";
