/**
 * Interval scheduler: each tick enqueues one `source_sync` per active syncable
 * source for the current window, then processes a batch of jobs. There is no
 * cron infrastructure; the window key makes repeated ticks within the same
 * interval a no-op, and a missed tick simply runs on the next one.
 */
import { createWorkspaceContext } from "@sona/core";
import type { SqliteSourceRepository } from "@sona/db";
import { redactError } from "./jobs/redact.js";
import type { JobRunOutcome } from "./jobs/runner.js";
import { SYNCABLE_SOURCE_KINDS } from "./jobs/source-sync.js";
import type { WorkerRuntime } from "./worker.js";

/** Cadence for one scheduler pass; also accepted by {@link tick} for a manual pass. */
export interface TickOptions {
  /** Time between ticks. */
  intervalMs: number;
  /** Width of the sync window bucket; defaults to `intervalMs`. */
  syncWindowMs?: number;
  /** Jobs processed per tick. */
  batchSize?: number;
  now?: () => string;
}

export interface SchedulerOptions extends TickOptions {
  /** Injectable sleep for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Stops the loop after the current tick. */
  signal?: AbortSignal;
  onTick?: (result: TickResult) => void;
  /** Called for a failed tick and for each source whose sync could not be enqueued. */
  onError?: (error: unknown) => void;
}

/** What one pass did: which syncs it queued and which jobs it processed. */
export interface TickResult {
  at: string;
  window: string;
  /** Sync jobs newly enqueued this tick (existing ones for the window are skipped). */
  enqueuedSyncJobIds: string[];
  /** Sources whose sync could not be enqueued this tick. */
  enqueueFailures: ScheduledSyncFailure[];
  outcomes: JobRunOutcome[];
}

/** The runtime to drive plus the one cross-workspace read the scheduler needs. */
export interface SchedulerDependencies {
  worker: WorkerRuntime;
  sources: Pick<SqliteSourceRepository, "listActiveForScheduler">;
}

/** ISO timestamp of the start of the bucket `nowIso` falls into; the source_sync window key. */
export function syncWindowFor(nowIso: string, windowMs: number): string {
  if (!Number.isInteger(windowMs) || windowMs < 1) {
    throw new Error(`sync window must be a positive integer of milliseconds, got ${windowMs}`);
  }
  const time = Date.parse(nowIso);
  if (Number.isNaN(time)) {
    throw new Error(`invalid timestamp ${JSON.stringify(nowIso)}`);
  }
  return new Date(Math.floor(time / windowMs) * windowMs).toISOString();
}

export interface ScheduledSyncs {
  /** Sync jobs newly enqueued (existing ones for the window are skipped). */
  enqueuedJobIds: string[];
  /** Sources whose enqueue failed; the rest of the tick still runs. */
  failures: ScheduledSyncFailure[];
}

export interface ScheduledSyncFailure {
  workspaceId: string;
  sourceId: string;
  /** Redacted error summary. */
  error: string;
}

export async function enqueueScheduledSyncs(
  deps: SchedulerDependencies,
  window: string,
): Promise<ScheduledSyncs> {
  const sources = await deps.sources.listActiveForScheduler(SYNCABLE_SOURCE_KINDS);
  const result: ScheduledSyncs = { enqueuedJobIds: [], failures: [] };
  for (const source of sources) {
    try {
      const enqueued = await deps.worker.queue.enqueue(
        createWorkspaceContext({ workspaceId: source.workspaceId }),
        "source_sync",
        { sourceId: source.sourceId, window },
      );
      if (enqueued.created) {
        result.enqueuedJobIds.push(enqueued.job.id);
      }
    } catch (error) {
      // One broken source must not starve every other source and job.
      result.failures.push({
        workspaceId: source.workspaceId,
        sourceId: source.sourceId,
        error: redactError(error),
      });
    }
  }
  return result;
}

/** One scheduler pass: enqueue due syncs, then run a batch of jobs. */
export async function tick(deps: SchedulerDependencies, options: TickOptions): Promise<TickResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const at = now();
  const window = syncWindowFor(at, options.syncWindowMs ?? options.intervalMs);
  const scheduled = await enqueueScheduledSyncs(deps, window);
  const outcomes = await deps.worker.runOnce({ limit: options.batchSize });
  return {
    at,
    window,
    enqueuedSyncJobIds: scheduled.enqueuedJobIds,
    enqueueFailures: scheduled.failures,
    outcomes,
  };
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Runs ticks every `intervalMs` until the signal aborts. Errors are reported, not fatal. */
export async function runScheduler(
  deps: SchedulerDependencies,
  options: SchedulerOptions,
): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  while (!options.signal?.aborted) {
    try {
      const result = await tick(deps, options);
      for (const failure of result.enqueueFailures) {
        options.onError?.(
          new Error(
            `could not enqueue sync for source ${failure.sourceId} in workspace ${failure.workspaceId}: ${failure.error}`,
          ),
        );
      }
      options.onTick?.(result);
    } catch (error) {
      options.onError?.(error);
    }
    await sleep(options.intervalMs, options.signal);
  }
}
