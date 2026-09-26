/**
 * Claims runnable jobs, dispatches them to the handler for their kind, and
 * records the outcome: success with produced-record provenance, a retry with
 * exponential backoff, or dead-lettering once attempts are exhausted. Every
 * finished attempt appends an audit event; errors are redacted before they
 * are persisted anywhere.
 */
import type { AuditEvent, JsonValue, WorkspaceContext } from "@sona/core";
import { createWorkspaceContext } from "@sona/core";
import type {
  PersistedJob,
  PersistedJobRun,
  RecordRef,
  SqliteAuditEventRepository,
  SqliteJobRepository,
} from "@sona/db";
import { type DbClient, JobLeaseLostError, withTransactionAsync } from "@sona/db";
import type { EnqueueOptions, EnqueueResult, JobQueue } from "./queue.js";
import { redactError } from "./redact.js";
import { isJobKind, type Job, type JobKind, type JobPayloadInput, narrowJob } from "./types.js";

export interface JobHandlerContext<K extends JobKind> {
  job: Job<K>;
  run: PersistedJobRun;
  /** Workspace the job belongs to; every repository call must use it. */
  context: WorkspaceContext;
  /** Attempt start time (ISO-8601); use it instead of the wall clock for determinism. */
  now: string;
  /** Enqueues follow-up work (e.g. extraction after ingest); idempotent by key. */
  enqueue<K2 extends JobKind>(
    kind: K2,
    payload: JobPayloadInput<K2>,
    options?: EnqueueOptions,
  ): Promise<EnqueueResult<K2>>;
  /** Records a record this attempt produced or touched, for provenance. */
  produced(ref: RecordRef): void;
}

/** Returns a JSON summary stored on the run; throw to fail the attempt. */
export type JobHandler<K extends JobKind> = (
  context: JobHandlerContext<K>,
) => Promise<JsonValue | undefined>;

export type JobHandlers = { readonly [K in JobKind]: JobHandler<K> };

/**
 * Thrown by handlers for failures a retry cannot fix (unknown source, an
 * unsupported source kind, a payload referencing a missing record). The job is
 * dead-lettered immediately instead of burning its remaining attempts.
 */
export class NonRetryableJobError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NonRetryableJobError";
  }
}

export interface BackoffPolicy {
  /** Delay before the second attempt. */
  baseMs: number;
  /** Multiplier applied per additional failed attempt. */
  factor: number;
  /** Upper bound on the delay. */
  maxMs: number;
}

export const DEFAULT_BACKOFF_POLICY = {
  baseMs: 30_000,
  factor: 2,
  maxMs: 6 * 60 * 60_000,
} as const satisfies BackoffPolicy;

/** Delay before retrying after `failedAttempts` failures (1 = first failure). */
export function backoffMs(policy: BackoffPolicy, failedAttempts: number): number {
  if (!Number.isInteger(failedAttempts) || failedAttempts < 1) {
    throw new Error(`failedAttempts must be a positive integer, got ${String(failedAttempts)}`);
  }
  return Math.min(policy.maxMs, policy.baseMs * policy.factor ** (failedAttempts - 1));
}

export const JOB_RUN_STATES = ["succeeded", "retry_scheduled", "dead", "lease_lost"] as const;

/**
 * How an attempt ended. `lease_lost` means the handler outlived its lease and
 * another worker took the job over: nothing this attempt did was recorded as
 * the job's outcome, and the takeover attempt owns the job now.
 */
export type JobRunState = (typeof JOB_RUN_STATES)[number];

export interface JobRunOutcome {
  jobId: string;
  runId: string;
  workspaceId: string;
  /** Persisted kind; may be outside {@link JobKind} for a dead-lettered unknown kind. */
  kind: string;
  attempt: number;
  state: JobRunState;
  /** Redacted error for failed attempts. */
  error: string | undefined;
  /** Next run time when a retry was scheduled. */
  runAfter: string | undefined;
  produced: RecordRef[];
}

interface OutcomeDetails {
  state: JobRunState;
  error?: string;
  runAfter?: string;
}

export interface RunOnceOptions {
  /** Maximum jobs to process in this pass. */
  limit?: number;
  /** Restrict to these kinds. */
  kinds?: readonly JobKind[];
}

export interface JobRunnerOptions {
  workerId: string;
  now: () => string;
  leaseMs: number;
  backoff: BackoffPolicy;
}

export interface JobRunnerDependencies {
  db: DbClient;
  jobs: SqliteJobRepository;
  auditEvents: SqliteAuditEventRepository;
  queue: JobQueue;
  handlers: JobHandlers;
}

const DEFAULT_RUN_LIMIT = 25;

/** Narrows the job to `kind` and calls that kind's handler; generic so the pairing is type-checked. */
function dispatch<K extends JobKind>(
  handlers: JobHandlers,
  kind: K,
  persisted: PersistedJob,
  context: Omit<JobHandlerContext<K>, "job">,
): Promise<JsonValue | undefined> {
  const handler: JobHandler<K> = handlers[kind];
  let job: Job<K>;
  try {
    job = narrowJob(persisted, kind);
  } catch (error) {
    // A stored payload that no longer parses will not parse on retry either.
    throw new NonRetryableJobError(redactError(error), { cause: error });
  }
  return handler({ ...context, job });
}

export function jobRunId(jobId: string, attempt: number): string {
  return `job_run:${jobId}:${attempt}`;
}

function outcome(
  job: PersistedJob,
  run: PersistedJobRun,
  produced: RecordRef[],
  details: OutcomeDetails,
): JobRunOutcome {
  return {
    jobId: job.id,
    runId: run.id,
    workspaceId: job.workspaceId,
    kind: job.kind,
    attempt: run.attempt,
    state: details.state,
    error: details.error,
    runAfter: details.runAfter,
    produced,
  };
}

export class JobRunner {
  readonly #deps: JobRunnerDependencies;
  readonly #options: JobRunnerOptions;

  constructor(deps: JobRunnerDependencies, options: JobRunnerOptions) {
    this.#deps = deps;
    this.#options = options;
  }

  /**
   * Processes up to `limit` runnable jobs sequentially. Jobs are claimed one
   * at a time right before they run, so a lease starts when its work starts
   * rather than when the batch was assembled — a long first job cannot expire
   * the leases of the jobs queued behind it.
   */
  async runOnce(options: RunOnceOptions = {}): Promise<JobRunOutcome[]> {
    const limit = options.limit ?? DEFAULT_RUN_LIMIT;
    const outcomes: JobRunOutcome[] = [];
    while (outcomes.length < limit) {
      const [claimed] = await this.#deps.jobs.claim({
        workerId: this.#options.workerId,
        now: this.#options.now(),
        leaseMs: this.#options.leaseMs,
        limit: 1,
        kinds: options.kinds,
        runIdFor: (job, attempt) => jobRunId(job.id, attempt),
      });
      if (claimed === undefined) {
        break;
      }
      outcomes.push(await this.#process(claimed.job, claimed.run));
    }
    return outcomes;
  }

  /**
   * Runs the handler, then writes the attempt's outcome and audit event
   * atomically. A lost lease is an outcome of its own rather than an
   * exception, so one slow job never abandons the rest of the batch.
   */
  async #process(persisted: PersistedJob, run: PersistedJobRun): Promise<JobRunOutcome> {
    const produced: RecordRef[] = [];
    let write: (finishedAt: string) => Promise<OutcomeDetails>;
    try {
      if (!isJobKind(persisted.kind)) {
        throw new NonRetryableJobError(`unknown job kind ${JSON.stringify(persisted.kind)}`);
      }
      const context = createWorkspaceContext({ workspaceId: persisted.workspaceId });
      const result = await dispatch(this.#deps.handlers, persisted.kind, persisted, {
        run,
        context,
        now: run.startedAt,
        enqueue: (followUpKind, payload, options) =>
          this.#deps.queue.enqueue(context, followUpKind, payload, options),
        produced: (ref) => {
          if (!produced.some((existing) => existing.type === ref.type && existing.id === ref.id)) {
            produced.push({ type: ref.type, id: ref.id });
          }
        },
      });
      write = (finishedAt) => this.#recordSuccess(persisted, run, produced, result, finishedAt);
    } catch (error) {
      write = (finishedAt) => this.#recordFailure(persisted, run, produced, error, finishedAt);
    }

    const finishedAt = this.#options.now();
    try {
      const details = await withTransactionAsync(this.#deps.db, () => write(finishedAt));
      return outcome(persisted, run, produced, details);
    } catch (error) {
      if (error instanceof JobLeaseLostError) {
        return outcome(persisted, run, produced, { state: "lease_lost", error: error.message });
      }
      throw error;
    }
  }

  async #recordSuccess(
    persisted: PersistedJob,
    run: PersistedJobRun,
    produced: RecordRef[],
    result: JsonValue | undefined,
    finishedAt: string,
  ): Promise<OutcomeDetails> {
    await this.#deps.jobs.succeed({
      workspaceId: persisted.workspaceId,
      jobId: persisted.id,
      runId: run.id,
      workerId: this.#options.workerId,
      finishedAt,
      result,
      produced,
    });
    await this.#deps.auditEvents.append(
      this.#auditEvent(persisted, run, finishedAt, "job.run.succeeded", {
        produced: produced.map((ref) => ({ type: ref.type, id: ref.id })),
      }),
    );
    return { state: "succeeded" };
  }

  async #recordFailure(
    persisted: PersistedJob,
    run: PersistedJobRun,
    produced: RecordRef[],
    error: unknown,
    finishedAt: string,
  ): Promise<OutcomeDetails> {
    const message = redactError(error);
    const exhausted = persisted.attempts >= persisted.maxAttempts;
    const retryAt =
      error instanceof NonRetryableJobError || exhausted
        ? undefined
        : new Date(
            Date.parse(finishedAt) + backoffMs(this.#options.backoff, persisted.attempts),
          ).toISOString();
    await this.#deps.jobs.fail({
      workspaceId: persisted.workspaceId,
      jobId: persisted.id,
      runId: run.id,
      workerId: this.#options.workerId,
      finishedAt,
      error: message,
      retryAt,
      produced,
    });
    await this.#deps.auditEvents.append(
      this.#auditEvent(persisted, run, finishedAt, "job.run.failed", {
        error: message,
        retryAt: retryAt ?? null,
        dead: retryAt === undefined,
      }),
    );
    return {
      state: retryAt === undefined ? "dead" : "retry_scheduled",
      error: message,
      runAfter: retryAt,
    };
  }

  #auditEvent(
    job: PersistedJob,
    run: PersistedJobRun,
    at: string,
    action: "job.run.succeeded" | "job.run.failed",
    metadata: Record<string, JsonValue>,
  ): AuditEvent {
    return {
      id: `audit:${run.id}:${action}`,
      workspaceId: job.workspaceId,
      action,
      actor: `worker:${this.#options.workerId}`,
      targetType: "job",
      targetId: job.id,
      metadata: { kind: job.kind, runId: run.id, attempt: run.attempt, ...metadata },
      createdAt: at,
    };
  }
}
