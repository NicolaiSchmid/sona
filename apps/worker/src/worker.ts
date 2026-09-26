/**
 * Composition root: builds the repositories, queue, handlers, and runner over
 * one database connection plus the injected external boundaries (document
 * storage, provider credentials, extraction provider).
 */
import type { DocumentStorage } from "@sona/core";
import {
  type DbClient,
  SqliteAuditEventRepository,
  SqliteBankRecordRepository,
  SqliteDocumentExtractionRepository,
  SqliteDocumentRepository,
  SqliteEmailSyncRunRepository,
  SqliteEvidenceLinkRepository,
  SqliteJobRepository,
  SqliteLedgerRepository,
  SqliteMatchCandidateRepository,
  SqliteRawRecordRepository,
  SqliteReviewQueueRepository,
  SqliteSourceRepository,
  SqliteSyncRunRepository,
} from "@sona/db";
import type { AutoApplyPolicy, ExtractionProvider } from "@sona/receipts";
import type { TaxTemplate } from "@sona/tax-de";
import { createDocumentIngestHandler } from "./jobs/document-ingest.js";
import { createExportGenerationHandler } from "./jobs/export-generation.js";
import { createExtractionHandler } from "./jobs/extraction.js";
import {
  createPortalFetchHandler,
  type PortalFetchDependencies,
} from "./jobs/portal-fetch-handler.js";
import { JobQueue } from "./jobs/queue.js";
import { createReconciliationHandler } from "./jobs/reconciliation.js";
import {
  type BackoffPolicy,
  DEFAULT_BACKOFF_POLICY,
  type JobHandlers,
  JobRunner,
  type JobRunOutcome,
  type RunOnceOptions,
} from "./jobs/runner.js";
import { createSourceSyncHandler, type SourceSyncGateway } from "./jobs/source-sync.js";

export interface WorkerRepositories {
  jobs: SqliteJobRepository;
  sources: SqliteSourceRepository;
  syncRuns: SqliteSyncRunRepository;
  emailSyncRuns: SqliteEmailSyncRunRepository;
  rawRecords: SqliteRawRecordRepository;
  bankRecords: SqliteBankRecordRepository;
  ledger: SqliteLedgerRepository;
  evidenceLinks: SqliteEvidenceLinkRepository;
  auditEvents: SqliteAuditEventRepository;
  documents: SqliteDocumentRepository;
  extractions: SqliteDocumentExtractionRepository;
  matchCandidates: SqliteMatchCandidateRepository;
  reviewQueue: SqliteReviewQueueRepository;
}

export function createWorkerRepositories(db: DbClient): WorkerRepositories {
  return {
    jobs: new SqliteJobRepository(db),
    sources: new SqliteSourceRepository(db),
    syncRuns: new SqliteSyncRunRepository(db),
    emailSyncRuns: new SqliteEmailSyncRunRepository(db),
    rawRecords: new SqliteRawRecordRepository(db),
    bankRecords: new SqliteBankRecordRepository(db),
    ledger: new SqliteLedgerRepository(db),
    evidenceLinks: new SqliteEvidenceLinkRepository(db),
    auditEvents: new SqliteAuditEventRepository(db),
    documents: new SqliteDocumentRepository(db),
    extractions: new SqliteDocumentExtractionRepository(db),
    matchCandidates: new SqliteMatchCandidateRepository(db),
    reviewQueue: new SqliteReviewQueueRepository(db),
  };
}

export interface WorkerRuntimeOptions {
  db: DbClient;
  storage: DocumentStorage;
  sourceSync: SourceSyncGateway;
  extraction: {
    provider: ExtractionProvider;
    reviewMinConfidence?: number;
  };
  reconciliation?: {
    policy?: AutoApplyPolicy;
    windowDays?: number;
  };
  taxTemplates?: Readonly<Record<string, TaxTemplate>>;
  /** Browser portal fetching; when omitted, `portal_fetch` jobs are dead-lettered. */
  portalFetch?: PortalFetchDependencies;
  /** Stable identity of this worker process; owns job leases. */
  workerId?: string;
  ids?: () => string;
  now?: () => string;
  leaseMs?: number;
  backoff?: BackoffPolicy;
  defaultMaxAttempts?: number;
  /** Override individual repositories (tests). */
  repositories?: Partial<WorkerRepositories>;
}

/** The composed job system: what the scheduler, CLI, and MCP facade hold on to. */
export interface WorkerRuntime {
  repositories: WorkerRepositories;
  queue: JobQueue;
  runner: JobRunner;
  /** Claims and processes one batch of jobs; the unit the scheduler and CLI call. */
  runOnce(options?: RunOnceOptions): Promise<JobRunOutcome[]>;
}

export const WORKER_DEFAULTS = {
  leaseMs: 15 * 60_000,
  defaultMaxAttempts: 5,
} as const;

export function createWorker(options: WorkerRuntimeOptions): WorkerRuntime {
  const ids = options.ids ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date().toISOString());
  const workerId = options.workerId ?? `worker-${ids()}`;
  const repositories: WorkerRepositories = {
    ...createWorkerRepositories(options.db),
    ...options.repositories,
  };
  const queue = new JobQueue(repositories.jobs, {
    ids,
    now,
    defaultMaxAttempts: options.defaultMaxAttempts ?? WORKER_DEFAULTS.defaultMaxAttempts,
  });
  const handlers: JobHandlers = {
    source_sync: createSourceSyncHandler({
      db: options.db,
      sources: repositories.sources,
      syncRuns: repositories.syncRuns,
      emailSyncRuns: repositories.emailSyncRuns,
      rawRecords: repositories.rawRecords,
      bankRecords: repositories.bankRecords,
      documents: repositories.documents,
      storage: options.storage,
      ledger: repositories.ledger,
      evidenceLinks: repositories.evidenceLinks,
      reviewQueue: repositories.reviewQueue,
      gateway: options.sourceSync,
      ids,
    }),
    portal_fetch: createPortalFetchHandler(options.portalFetch),
    document_ingest: createDocumentIngestHandler({
      documents: repositories.documents,
      storage: options.storage,
    }),
    extraction: createExtractionHandler({
      db: options.db,
      documents: repositories.documents,
      extractions: repositories.extractions,
      reviewQueue: repositories.reviewQueue,
      storage: options.storage,
      provider: options.extraction.provider,
      reviewMinConfidence: options.extraction.reviewMinConfidence,
    }),
    reconciliation: createReconciliationHandler({
      db: options.db,
      documents: repositories.documents,
      extractions: repositories.extractions,
      bankRecords: repositories.bankRecords,
      matchCandidates: repositories.matchCandidates,
      reviewQueue: repositories.reviewQueue,
      evidenceLinks: repositories.evidenceLinks,
      ledger: repositories.ledger,
      auditEvents: repositories.auditEvents,
      policy: options.reconciliation?.policy,
      windowDays: options.reconciliation?.windowDays,
      ids,
    }),
    export_generation: createExportGenerationHandler({
      ledger: repositories.ledger,
      evidenceLinks: repositories.evidenceLinks,
      storage: options.storage,
      templates: options.taxTemplates,
    }),
  };
  const runner = new JobRunner(
    {
      db: options.db,
      jobs: repositories.jobs,
      auditEvents: repositories.auditEvents,
      queue,
      handlers,
    },
    {
      workerId,
      now,
      leaseMs: options.leaseMs ?? WORKER_DEFAULTS.leaseMs,
      backoff: options.backoff ?? DEFAULT_BACKOFF_POLICY,
    },
  );
  return {
    repositories,
    queue,
    runner,
    runOnce: (runOptions) => runner.runOnce(runOptions),
  };
}
