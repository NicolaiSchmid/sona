import type {
  PortalTask,
  PortalTaskRunner,
  PortalTaskRunStatus,
  RunPortalTaskInput,
  RunPortalTaskResult,
} from "@sona/agents";
import { requireWorkspaceContext, type WorkspaceContext } from "@sona/core";

export interface PortalFetchConnection {
  id: string;
  workspaceId: string;
  task: PortalTask;
}

export interface GetPortalFetchConnectionInput {
  context: WorkspaceContext;
  connectionId: string;
}

export interface PortalFetchConnectionRepository {
  getConnection(input: GetPortalFetchConnectionInput): Promise<PortalFetchConnection>;
}

export interface PortalFetchJobLeaseKey {
  jobId: string;
  workspaceId: string;
  connectionId: string;
}

export interface AcquirePortalFetchJobInput extends PortalFetchJobLeaseKey {
  now: string;
  cooldownUntil: string;
}

/**
 * Idempotency and cooldown state for portal fetch jobs.
 *
 * `acquire` must atomically refuse a job id that is leased or completed and a
 * connection that is still cooling down, then record both the lease and the
 * cooldown before any browser launches. `complete` makes the job id permanently
 * idempotent; `release` drops the lease after a retryable failure so a queue
 * retry with the same id can run again once the cooldown has passed. A durable
 * implementation should expire stale leases so a crashed worker cannot pin a
 * job id forever.
 */
export interface PortalFetchJobStateStore {
  acquire(input: AcquirePortalFetchJobInput): Promise<PortalFetchJobReservation>;
  complete(input: PortalFetchJobLeaseKey): Promise<void>;
  release(input: PortalFetchJobLeaseKey): Promise<void>;
}

export type PortalFetchJobReservation =
  | { status: "acquired"; cooldownUntil: string }
  | { status: "duplicate"; cooldownUntil: undefined }
  | { status: "cooldown"; cooldownUntil: string };

export interface RecordPortalFetchRunInput {
  context: WorkspaceContext;
  result: RunPortalTaskResult;
}

/**
 * Durable run history. Every run that produced a result is recorded before the
 * lease is settled, so blocked requests, allowed exceptions, and outcomes stay
 * auditable after the queue has forgotten the job.
 */
export interface PortalFetchRunRecorder {
  recordRun(input: RecordPortalFetchRunInput): Promise<void>;
}

export interface RunPortalFetchJobInput {
  jobId: string;
  /** Delivery attempt of this job id, starting at 1; each attempt gets its own run id. */
  attempt?: number;
  context: WorkspaceContext;
  connectionId: string;
  now: string;
  cooldownMs: number;
  runner: PortalTaskRunner;
  connections: PortalFetchConnectionRepository;
  state: PortalFetchJobStateStore;
  runs: PortalFetchRunRecorder;
}

/**
 * `failed` is retryable (the lease was released); `rejected` is terminal: the
 * task definition or portal layout must change before this connection can run
 * again, so the job id is consumed and a queue must not retry it.
 */
export type PortalFetchJobStatus = "completed" | "duplicate" | "cooldown" | "failed" | "rejected";

export interface RunPortalFetchJobResult {
  status: PortalFetchJobStatus;
  connectionId: string;
  runId: string | undefined;
  cooldownUntil: string | undefined;
  runResult: RunPortalTaskResult | undefined;
  error: string | undefined;
}

const TERMINAL_RUN_STATUSES: ReadonlySet<PortalTaskRunStatus> = new Set<PortalTaskRunStatus>([
  "policy_refused",
  "selector_missing",
  "blocked",
]);

export async function runPortalFetchJob(
  input: RunPortalFetchJobInput,
): Promise<RunPortalFetchJobResult> {
  const context = requireWorkspaceContext(input.context);
  const base = {
    connectionId: input.connectionId,
    runId: undefined,
    cooldownUntil: undefined,
    runResult: undefined,
    error: undefined,
  } satisfies Partial<RunPortalFetchJobResult>;

  const connection = await input.connections.getConnection({
    context,
    connectionId: input.connectionId,
  });
  if (connection.workspaceId !== context.workspaceId) {
    return { ...base, status: "failed", error: "portal connection belongs to another workspace" };
  }

  const cooldownUntil = new Date(Date.parse(input.now) + input.cooldownMs).toISOString();
  const leaseKey: PortalFetchJobLeaseKey = {
    jobId: input.jobId,
    workspaceId: context.workspaceId,
    connectionId: input.connectionId,
  };
  const reservation = await input.state.acquire({ ...leaseKey, now: input.now, cooldownUntil });
  if (reservation.status !== "acquired") {
    return { ...base, status: reservation.status, cooldownUntil: reservation.cooldownUntil };
  }

  const runId = runIdFor(input.jobId, input.attempt ?? 1);
  const runInput: RunPortalTaskInput = {
    task: connection.task,
    connectionId: input.connectionId,
    runId,
    workspaceId: context.workspaceId,
    now: input.now,
  };
  let runResult: RunPortalTaskResult | undefined;
  let error: string | undefined;
  try {
    runResult = await input.runner.runTask(runInput);
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown);
  }

  if (runResult !== undefined) {
    try {
      await input.runs.recordRun({ context, result: runResult });
    } catch (thrown) {
      // Without a durable record the run is not auditable; hand the job back
      // to the queue (dedup by content hash makes the rerun safe).
      await releaseQuietly(input.state, leaseKey);
      throw thrown;
    }
  }

  if (runResult?.status === "completed") {
    await input.state.complete(leaseKey);
    return { ...base, status: "completed", runId, cooldownUntil, runResult };
  }
  if (runResult !== undefined && TERMINAL_RUN_STATUSES.has(runResult.status)) {
    await input.state.complete(leaseKey);
    return { ...base, status: "rejected", runId, cooldownUntil, runResult };
  }
  const releaseError = await releaseQuietly(input.state, leaseKey);
  return {
    ...base,
    status: "failed",
    runId,
    cooldownUntil,
    runResult,
    error: [error, releaseError].filter((part) => part !== undefined).join("; ") || undefined,
  };
}

function runIdFor(jobId: string, attempt: number): string {
  return attempt <= 1 ? jobId : `${jobId}:${attempt}`;
}

async function releaseQuietly(
  state: PortalFetchJobStateStore,
  leaseKey: PortalFetchJobLeaseKey,
): Promise<string | undefined> {
  try {
    await state.release(leaseKey);
    return undefined;
  } catch (thrown) {
    return `lease release failed: ${thrown instanceof Error ? thrown.message : String(thrown)}`;
  }
}

export class InMemoryPortalFetchConnectionRepository implements PortalFetchConnectionRepository {
  readonly #connections = new Map<string, PortalFetchConnection>();

  constructor(connections: readonly PortalFetchConnection[] = []) {
    for (const connection of connections) {
      this.#connections.set(
        connectionKey(connection.workspaceId, connection.id),
        freezeConnection(connection),
      );
    }
  }

  async getConnection(input: GetPortalFetchConnectionInput): Promise<PortalFetchConnection> {
    const connection = this.#connections.get(
      connectionKey(input.context.workspaceId, input.connectionId),
    );
    if (connection === undefined) {
      throw new Error(`Portal fetch connection not found: ${input.connectionId}`);
    }
    return freezeConnection(connection);
  }
}

type PortalFetchJobLeaseState = "leased" | "completed";

export class InMemoryPortalFetchJobStateStore implements PortalFetchJobStateStore {
  readonly #jobs = new Map<string, PortalFetchJobLeaseState>();
  readonly #cooldowns = new Map<string, string>();

  async acquire(input: AcquirePortalFetchJobInput): Promise<PortalFetchJobReservation> {
    if (this.#jobs.has(jobKey(input))) {
      return { status: "duplicate", cooldownUntil: undefined };
    }
    const key = connectionKey(input.workspaceId, input.connectionId);
    const existingCooldown = this.#cooldowns.get(key);
    if (existingCooldown !== undefined && Date.parse(existingCooldown) > Date.parse(input.now)) {
      return { status: "cooldown", cooldownUntil: existingCooldown };
    }
    this.#jobs.set(jobKey(input), "leased");
    this.#cooldowns.set(key, input.cooldownUntil);
    return { status: "acquired", cooldownUntil: input.cooldownUntil };
  }

  async complete(input: PortalFetchJobLeaseKey): Promise<void> {
    this.#jobs.set(jobKey(input), "completed");
  }

  async release(input: PortalFetchJobLeaseKey): Promise<void> {
    if (this.#jobs.get(jobKey(input)) === "leased") {
      this.#jobs.delete(jobKey(input));
    }
  }
}

export class InMemoryPortalFetchRunRecorder implements PortalFetchRunRecorder {
  readonly #runs: RunPortalTaskResult[] = [];

  async recordRun(input: RecordPortalFetchRunInput): Promise<void> {
    this.#runs.push(input.result);
  }

  listRuns(context: WorkspaceContext): RunPortalTaskResult[] {
    return this.#runs.filter((run) => run.provenance.workspaceId === context.workspaceId);
  }
}

function jobKey(input: PortalFetchJobLeaseKey): string {
  return `${input.workspaceId}:${input.jobId}`;
}

function connectionKey(workspaceId: string, connectionId: string): string {
  return `${workspaceId}:${connectionId}`;
}

function freezeConnection(connection: PortalFetchConnection): PortalFetchConnection {
  const task = connection.task;
  return Object.freeze({
    ...connection,
    task: Object.freeze({
      ...task,
      domains: Object.freeze([...task.domains]),
      requires: Object.freeze([...task.requires]),
      allowedActions: Object.freeze([...task.allowedActions]),
      forbiddenActions: Object.freeze([...task.forbiddenActions]),
      outputs: Object.freeze([...task.outputs]),
      httpMethodExceptions: Object.freeze([...task.httpMethodExceptions]),
      steps: Object.freeze([...task.steps]),
    }),
  }) as PortalFetchConnection;
}
