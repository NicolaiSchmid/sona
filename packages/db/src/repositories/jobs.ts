/**
 * SQLite-backed job queue and run provenance (`migrations/0008_jobs.sql`).
 *
 * Invariants enforced here:
 *
 * - enqueueing under an existing workspace-scoped idempotency key returns the
 *   existing job instead of creating a second one,
 * - a job is claimed by exactly one worker at a time: the claim is a
 *   compare-and-swap on `(status, attempts)` inside a transaction, and takes a
 *   lease that another worker may only take over once it has expired,
 * - every attempt has its own append-only `job_runs` row; a run that lost its
 *   lease is closed as `failed` when the job is taken over,
 * - terminal writes (`succeed`/`fail`) require the caller to still hold the
 *   lease, so a slow worker whose lease was taken over cannot overwrite the
 *   newer attempt's outcome.
 *
 * Retry policy (backoff, max attempts) is decided by the worker; this layer
 * only records the decision (`retryAt` vs. dead-letter).
 */
import type { JsonValue } from "@sona/core";
import type { DbClient, DbValue } from "../runner.js";
import {
  optionalString,
  parseJson,
  placeholders,
  type Row,
  requiredLiteral,
  requiredNumber,
  requiredString,
  row,
  rows,
  stringifyJson,
  withTransaction,
} from "./helpers.js";
import type { RecordRef } from "./records.js";

export const JOB_STATUSES = ["queued", "running", "succeeded", "dead"] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export function isJobStatus(value: string): value is JobStatus {
  return (JOB_STATUSES as readonly string[]).includes(value);
}

export const JOB_RUN_STATUSES = ["running", "succeeded", "failed"] as const;

export type JobRunStatus = (typeof JOB_RUN_STATUSES)[number];

export function isJobRunStatus(value: string): value is JobRunStatus {
  return (JOB_RUN_STATUSES as readonly string[]).includes(value);
}

export interface PersistedJob {
  id: string;
  workspaceId: string;
  kind: string;
  payload: JsonValue;
  idempotencyKey: string;
  status: JobStatus;
  /** Number of delivery attempts started so far. */
  attempts: number;
  maxAttempts: number;
  /** Earliest time the job may be claimed (ISO-8601). */
  runAfter: string;
  leaseOwner: string | undefined;
  leaseUntil: string | undefined;
  /** Redacted summary of the most recent failure. */
  lastError: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface PersistedJobRun {
  id: string;
  workspaceId: string;
  jobId: string;
  attempt: number;
  workerId: string;
  status: JobRunStatus;
  startedAt: string;
  finishedAt: string | undefined;
  error: string | undefined;
  result: JsonValue | undefined;
  /** Records this attempt produced or touched, for provenance. */
  produced: RecordRef[];
}

export interface EnqueueJobInput {
  id: string;
  workspaceId: string;
  kind: string;
  payload: JsonValue;
  idempotencyKey: string;
  maxAttempts: number;
  runAfter: string;
  createdAt: string;
}

export interface EnqueueJobResult {
  job: PersistedJob;
  /** False when an existing job was returned via its idempotency key. */
  created: boolean;
}

export interface ClaimJobsInput {
  workerId: string;
  /** Current time (ISO-8601); jobs with `runAfter` in the future are skipped. */
  now: string;
  /** Lease duration; a lease that lapses may be taken over by another worker. */
  leaseMs: number;
  /** Maximum number of jobs to claim. */
  limit: number;
  /** Restrict to these kinds; all kinds when omitted. */
  kinds?: readonly string[];
  /** Generates the id for each new run row. */
  runIdFor: (job: PersistedJob, attempt: number) => string;
}

export interface ClaimedJob {
  job: PersistedJob;
  run: PersistedJobRun;
}

export interface JobRunOutcomeInput {
  workspaceId: string;
  jobId: string;
  runId: string;
  /** Must match the lease owner recorded at claim time. */
  workerId: string;
  finishedAt: string;
}

export interface SucceedJobRunInput extends JobRunOutcomeInput {
  result?: JsonValue;
  produced: readonly RecordRef[];
}

export interface FailJobRunInput extends JobRunOutcomeInput {
  /** Redacted error summary. */
  error: string;
  /** When to retry; `undefined` dead-letters the job. */
  retryAt: string | undefined;
  produced?: readonly RecordRef[];
}

export interface ListJobsFilter {
  kinds?: readonly string[];
  statuses?: readonly JobStatus[];
  /** Maximum number of jobs, oldest first. */
  limit?: number;
}

/** Thrown when a terminal write arrives after the lease was lost or the job already settled. */
export class JobLeaseLostError extends Error {
  readonly jobId: string;

  constructor(jobId: string, detail: string) {
    super(`job ${jobId}: ${detail}`);
    this.name = "JobLeaseLostError";
    this.jobId = jobId;
  }
}

const JOB_SELECT =
  "SELECT id, workspace_id, kind, payload_json, idempotency_key, status, attempts, max_attempts, run_after, lease_owner, lease_until, last_error, created_at, updated_at FROM jobs";

const RUN_SELECT =
  "SELECT id, workspace_id, job_id, attempt, worker_id, status, started_at, finished_at, error, result_json, produced_json FROM job_runs";

export class SqliteJobRepository {
  readonly #db: DbClient;

  constructor(db: DbClient) {
    this.#db = db;
  }

  /** Inserts the job unless its idempotency key already exists in the workspace. */
  async enqueue(input: EnqueueJobInput): Promise<EnqueueJobResult> {
    if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) {
      throw new Error(
        `job maxAttempts must be a positive integer, got ${String(input.maxAttempts)}`,
      );
    }
    return withTransaction(this.#db, () => {
      this.#db
        .prepare(
          "INSERT INTO jobs (id, workspace_id, kind, payload_json, idempotency_key, status, attempts, max_attempts, run_after, lease_owner, lease_until, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, NULL, NULL, NULL, ?, ?) ON CONFLICT (workspace_id, idempotency_key) DO NOTHING",
        )
        .run(
          input.id,
          input.workspaceId,
          input.kind,
          stringifyJson(input.payload),
          input.idempotencyKey,
          input.maxAttempts,
          input.runAfter,
          input.createdAt,
          input.createdAt,
        );
      const job = this.#byIdempotencyKey(input.workspaceId, input.idempotencyKey);
      if (job === undefined) {
        throw new Error("job was not persisted");
      }
      return { job, created: job.id === input.id };
    });
  }

  /**
   * Claims up to `limit` runnable jobs for `workerId`, across workspaces (the
   * worker is a system actor; handlers receive each job's workspace). A job is
   * runnable when it is `queued` with `runAfter <= now`, or `running` with an
   * expired lease. Each claim increments `attempts` and opens a run row.
   */
  async claim(input: ClaimJobsInput): Promise<ClaimedJob[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error(`job claim limit must be a positive integer, got ${String(input.limit)}`);
    }
    if (input.kinds !== undefined && input.kinds.length === 0) {
      return [];
    }
    return withTransaction(this.#db, () => {
      const leaseUntil = new Date(Date.parse(input.now) + input.leaseMs).toISOString();
      const clauses = [
        "((status = 'queued' AND run_after <= ?) OR (status = 'running' AND lease_until < ?))",
      ];
      const params: DbValue[] = [input.now, input.now];
      if (input.kinds !== undefined) {
        clauses.push(`kind IN ${placeholders(input.kinds.length)}`);
        params.push(...input.kinds);
      }
      params.push(input.limit);
      const candidates = rows(
        this.#db
          .prepare(
            `${JOB_SELECT} WHERE ${clauses.join(" AND ")} ORDER BY run_after, created_at, id LIMIT ?`,
          )
          .all(...params),
      ).map(jobFromRow);

      const claimed: ClaimedJob[] = [];
      for (const candidate of candidates) {
        const attempt = candidate.attempts + 1;
        // Compare-and-swap on the state observed above; a concurrent claimer
        // that won changes status/attempts and this update matches nothing.
        this.#db
          .prepare(
            "UPDATE jobs SET status = 'running', attempts = ?, lease_owner = ?, lease_until = ?, updated_at = ? WHERE workspace_id = ? AND id = ? AND status = ? AND attempts = ?",
          )
          .run(
            attempt,
            input.workerId,
            leaseUntil,
            input.now,
            candidate.workspaceId,
            candidate.id,
            candidate.status,
            candidate.attempts,
          );
        const job = this.#requireJob(candidate.workspaceId, candidate.id);
        if (job.leaseOwner !== input.workerId || job.attempts !== attempt) {
          continue;
        }
        if (candidate.status === "running") {
          this.#closeOrphanedRun(candidate, input.now);
        }
        const run: PersistedJobRun = {
          id: input.runIdFor(job, attempt),
          workspaceId: job.workspaceId,
          jobId: job.id,
          attempt,
          workerId: input.workerId,
          status: "running",
          startedAt: input.now,
          finishedAt: undefined,
          error: undefined,
          result: undefined,
          produced: [],
        };
        this.#db
          .prepare(
            "INSERT INTO job_runs (id, workspace_id, job_id, attempt, worker_id, status, started_at, finished_at, error, result_json, produced_json) VALUES (?, ?, ?, ?, ?, 'running', ?, NULL, NULL, NULL, '[]')",
          )
          .run(run.id, run.workspaceId, run.jobId, run.attempt, run.workerId, run.startedAt);
        claimed.push({ job, run });
      }
      return claimed;
    });
  }

  /** Marks the job succeeded and closes its run with the result and produced records. */
  async succeed(input: SucceedJobRunInput): Promise<PersistedJob> {
    return withTransaction(this.#db, () => {
      this.#assertLeaseHeld(input);
      this.#db
        .prepare(
          "UPDATE jobs SET status = 'succeeded', lease_owner = NULL, lease_until = NULL, last_error = NULL, updated_at = ? WHERE workspace_id = ? AND id = ?",
        )
        .run(input.finishedAt, input.workspaceId, input.jobId);
      this.#finishRun(input, "succeeded", {
        error: undefined,
        result: input.result,
        produced: input.produced,
      });
      return this.#requireJob(input.workspaceId, input.jobId);
    });
  }

  /**
   * Records a failed attempt. With `retryAt` the job returns to `queued` for
   * that time; without it the job is dead-lettered. Either way the run row is
   * closed as `failed` with the redacted error.
   */
  async fail(input: FailJobRunInput): Promise<PersistedJob> {
    return withTransaction(this.#db, () => {
      this.#assertLeaseHeld(input);
      if (input.retryAt === undefined) {
        this.#db
          .prepare(
            "UPDATE jobs SET status = 'dead', lease_owner = NULL, lease_until = NULL, last_error = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
          )
          .run(input.error, input.finishedAt, input.workspaceId, input.jobId);
      } else {
        this.#db
          .prepare(
            "UPDATE jobs SET status = 'queued', run_after = ?, lease_owner = NULL, lease_until = NULL, last_error = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
          )
          .run(input.retryAt, input.error, input.finishedAt, input.workspaceId, input.jobId);
      }
      this.#finishRun(input, "failed", {
        error: input.error,
        result: undefined,
        produced: input.produced ?? [],
      });
      return this.#requireJob(input.workspaceId, input.jobId);
    });
  }

  async getById(workspaceId: string, id: string): Promise<PersistedJob | undefined> {
    return this.#byId(workspaceId, id);
  }

  async getByIdempotencyKey(
    workspaceId: string,
    idempotencyKey: string,
  ): Promise<PersistedJob | undefined> {
    return this.#byIdempotencyKey(workspaceId, idempotencyKey);
  }

  async list(workspaceId: string, filter: ListJobsFilter = {}): Promise<PersistedJob[]> {
    const clauses = ["workspace_id = ?"];
    const params: DbValue[] = [workspaceId];
    if (filter.kinds !== undefined) {
      if (filter.kinds.length === 0) {
        return [];
      }
      clauses.push(`kind IN ${placeholders(filter.kinds.length)}`);
      params.push(...filter.kinds);
    }
    if (filter.statuses !== undefined) {
      if (filter.statuses.length === 0) {
        return [];
      }
      clauses.push(`status IN ${placeholders(filter.statuses.length)}`);
      params.push(...filter.statuses);
    }
    let limitClause = "";
    if (filter.limit !== undefined) {
      if (!Number.isInteger(filter.limit) || filter.limit < 1) {
        throw new Error(`job list limit must be a positive integer, got ${String(filter.limit)}`);
      }
      limitClause = " LIMIT ?";
      params.push(filter.limit);
    }
    return rows(
      this.#db
        .prepare(
          `${JOB_SELECT} WHERE ${clauses.join(" AND ")} ORDER BY created_at, id${limitClause}`,
        )
        .all(...params),
    ).map(jobFromRow);
  }

  /** Every attempt of one job, oldest first. */
  async listRuns(workspaceId: string, jobId: string): Promise<PersistedJobRun[]> {
    return rows(
      this.#db
        .prepare(`${RUN_SELECT} WHERE workspace_id = ? AND job_id = ? ORDER BY attempt`)
        .all(workspaceId, jobId),
    ).map(runFromRow);
  }

  async getRun(workspaceId: string, runId: string): Promise<PersistedJobRun | undefined> {
    const result = row(
      this.#db.prepare(`${RUN_SELECT} WHERE workspace_id = ? AND id = ?`).get(workspaceId, runId),
    );
    return result === undefined ? undefined : runFromRow(result);
  }

  #byIdempotencyKey(workspaceId: string, idempotencyKey: string): PersistedJob | undefined {
    const result = row(
      this.#db
        .prepare(`${JOB_SELECT} WHERE workspace_id = ? AND idempotency_key = ?`)
        .get(workspaceId, idempotencyKey),
    );
    return result === undefined ? undefined : jobFromRow(result);
  }

  #byId(workspaceId: string, id: string): PersistedJob | undefined {
    const result = row(
      this.#db.prepare(`${JOB_SELECT} WHERE workspace_id = ? AND id = ?`).get(workspaceId, id),
    );
    return result === undefined ? undefined : jobFromRow(result);
  }

  #requireJob(workspaceId: string, id: string): PersistedJob {
    const job = this.#byId(workspaceId, id);
    if (job === undefined) {
      throw new Error(`job ${id} not found in workspace`);
    }
    return job;
  }

  #assertLeaseHeld(input: JobRunOutcomeInput): void {
    const job = this.#requireJob(input.workspaceId, input.jobId);
    if (job.status !== "running") {
      throw new JobLeaseLostError(job.id, `job is ${job.status}, not running`);
    }
    if (job.leaseOwner !== input.workerId) {
      throw new JobLeaseLostError(
        job.id,
        `lease is held by ${job.leaseOwner ?? "nobody"}, not ${input.workerId}`,
      );
    }
    const run = row(
      this.#db
        .prepare(`${RUN_SELECT} WHERE workspace_id = ? AND id = ? AND job_id = ?`)
        .get(input.workspaceId, input.runId, input.jobId),
    );
    if (run === undefined) {
      throw new JobLeaseLostError(job.id, `run ${input.runId} not found`);
    }
    if (requiredNumber(run, "attempt") !== job.attempts) {
      throw new JobLeaseLostError(job.id, `run ${input.runId} is not the current attempt`);
    }
  }

  #finishRun(
    input: JobRunOutcomeInput,
    status: Exclude<JobRunStatus, "running">,
    outcome: {
      error: string | undefined;
      result: JsonValue | undefined;
      produced: readonly RecordRef[];
    },
  ): void {
    this.#db
      .prepare(
        "UPDATE job_runs SET status = ?, finished_at = ?, error = ?, result_json = ?, produced_json = ? WHERE workspace_id = ? AND id = ? AND status = 'running'",
      )
      .run(
        status,
        input.finishedAt,
        outcome.error ?? null,
        outcome.result === undefined ? null : stringifyJson(outcome.result),
        stringifyJson(outcome.produced.map((ref) => ({ type: ref.type, id: ref.id }))),
        input.workspaceId,
        input.runId,
      );
  }

  /** Closes the run of a lease that lapsed before its worker wrote an outcome. */
  #closeOrphanedRun(job: PersistedJob, at: string): void {
    this.#db
      .prepare(
        "UPDATE job_runs SET status = 'failed', finished_at = ?, error = 'lease expired before the attempt finished' WHERE workspace_id = ? AND job_id = ? AND attempt = ? AND status = 'running'",
      )
      .run(at, job.workspaceId, job.id, job.attempts);
  }
}

function jobFromRow(source: Row): PersistedJob {
  return {
    id: requiredString(source, "id"),
    workspaceId: requiredString(source, "workspace_id"),
    kind: requiredString(source, "kind"),
    payload: parseJson(requiredString(source, "payload_json")),
    idempotencyKey: requiredString(source, "idempotency_key"),
    status: requiredLiteral(source, "status", isJobStatus),
    attempts: requiredNumber(source, "attempts"),
    maxAttempts: requiredNumber(source, "max_attempts"),
    runAfter: requiredString(source, "run_after"),
    leaseOwner: optionalString(source, "lease_owner"),
    leaseUntil: optionalString(source, "lease_until"),
    lastError: optionalString(source, "last_error"),
    createdAt: requiredString(source, "created_at"),
    updatedAt: requiredString(source, "updated_at"),
  };
}

function runFromRow(source: Row): PersistedJobRun {
  const result = optionalString(source, "result_json");
  return {
    id: requiredString(source, "id"),
    workspaceId: requiredString(source, "workspace_id"),
    jobId: requiredString(source, "job_id"),
    attempt: requiredNumber(source, "attempt"),
    workerId: requiredString(source, "worker_id"),
    status: requiredLiteral(source, "status", isJobRunStatus),
    startedAt: requiredString(source, "started_at"),
    finishedAt: optionalString(source, "finished_at"),
    error: optionalString(source, "error"),
    result: result === undefined ? undefined : parseJson(result),
    produced: parseProduced(requiredString(source, "produced_json")),
  };
}

function parseProduced(value: string): RecordRef[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    throw new Error("job run produced_json was not an array");
  }
  return parsed.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("job run produced entry was not an object");
    }
    const type = entry["type"];
    const id = entry["id"];
    if (typeof type !== "string" || typeof id !== "string") {
      throw new Error("job run produced entry was malformed");
    }
    return { type, id };
  });
}
