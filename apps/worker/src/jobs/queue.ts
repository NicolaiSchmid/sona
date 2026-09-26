/**
 * Workspace-scoped, typed entry point to the job table. Payloads are validated
 * against the kind's schema and the idempotency key is derived from the parsed
 * payload, so callers (scheduler, MCP facade, web uploads) cannot enqueue
 * malformed or accidentally duplicated work.
 */
import { requireWorkspaceContext, type WorkspaceContext } from "@sona/core";
import type { ListJobsFilter, PersistedJobRun, SqliteJobRepository } from "@sona/db";
import {
  defaultIdempotencyKey,
  type Job,
  type JobKind,
  type JobPayloadInput,
  narrowJob,
  narrowJobKind,
  parseJobPayload,
} from "./types.js";

export type { JobStatus, PersistedJobRun } from "@sona/db";

/** Filter for {@link JobQueue.list}: the repository filter with kinds narrowed to {@link JobKind}. */
export interface JobListFilter extends Omit<ListJobsFilter, "kinds"> {
  kinds?: readonly JobKind[];
}

export interface EnqueueOptions {
  /** Overrides the payload-derived key (e.g. to force a fresh export revision). */
  idempotencyKey?: string;
  /** Earliest run time (ISO-8601); defaults to now. */
  runAfter?: string;
  maxAttempts?: number;
}

export interface EnqueueResult<K extends JobKind> {
  job: Job<K>;
  /** False when an existing job with the same idempotency key was returned. */
  created: boolean;
}

export interface JobQueueOptions {
  ids: () => string;
  now: () => string;
  /** Attempts before a job is dead-lettered. */
  defaultMaxAttempts: number;
}

/**
 * The facade-facing side of the job table: enqueue typed jobs for a workspace
 * and read them back. Never claims or runs jobs; that is {@link JobRunner}.
 */
export class JobQueue {
  readonly #jobs: SqliteJobRepository;
  readonly #options: JobQueueOptions;

  constructor(jobs: SqliteJobRepository, options: JobQueueOptions) {
    this.#jobs = jobs;
    this.#options = options;
  }

  async enqueue<K extends JobKind>(
    context: WorkspaceContext,
    kind: K,
    payload: JobPayloadInput<K>,
    options: EnqueueOptions = {},
  ): Promise<EnqueueResult<K>> {
    const { workspaceId } = requireWorkspaceContext(context);
    const parsed = parseJobPayload(kind, payload);
    const now = this.#options.now();
    const result = await this.#jobs.enqueue({
      id: this.#options.ids(),
      workspaceId,
      kind,
      payload: parsed,
      idempotencyKey: options.idempotencyKey ?? defaultIdempotencyKey(kind, parsed),
      maxAttempts: options.maxAttempts ?? this.#options.defaultMaxAttempts,
      runAfter: options.runAfter ?? now,
      createdAt: now,
    });
    return { job: narrowJob(result.job, kind), created: result.created };
  }

  async get(context: WorkspaceContext, jobId: string): Promise<Job | undefined> {
    const { workspaceId } = requireWorkspaceContext(context);
    const job = await this.#jobs.getById(workspaceId, jobId);
    return job === undefined ? undefined : narrowJobKind(job);
  }

  async list(context: WorkspaceContext, filter: JobListFilter = {}): Promise<Job[]> {
    const { workspaceId } = requireWorkspaceContext(context);
    return (await this.#jobs.list(workspaceId, filter)).map(narrowJobKind);
  }

  async listRuns(context: WorkspaceContext, jobId: string): Promise<PersistedJobRun[]> {
    const { workspaceId } = requireWorkspaceContext(context);
    return this.#jobs.listRuns(workspaceId, jobId);
  }
}
