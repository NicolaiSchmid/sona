/**
 * `portal_fetch` as a queue job: hosts the read-only portal task job from
 * `./portal-fetch.ts` behind the shared job model. The queue provides
 * idempotency, retries, leases, and run provenance; the portal job keeps its
 * own per-connection cooldown and terminal/rejected semantics.
 */
import type { PortalTaskRunner } from "@sona/agents";
import { RECORD_TYPES } from "@sona/db";
import {
  type PortalFetchConnectionRepository,
  type PortalFetchJobStateStore,
  type PortalFetchRunRecorder,
  runPortalFetchJob,
} from "./portal-fetch.js";
import { redactText } from "./redact.js";
import { type JobHandler, NonRetryableJobError } from "./runner.js";

export interface PortalFetchDependencies {
  taskRunner: PortalTaskRunner;
  connections: PortalFetchConnectionRepository;
  state: PortalFetchJobStateStore;
  runs: PortalFetchRunRecorder;
  /** Minimum time between two fetches of the same connection. Default 6 hours. */
  cooldownMs?: number;
}

export const DEFAULT_PORTAL_FETCH_COOLDOWN_MS = 6 * 60 * 60_000;

/**
 * Builds the handler. Without dependencies (no browser runner configured) a
 * `portal_fetch` job is dead-lettered with a clear reason instead of retried.
 */
export function createPortalFetchHandler(
  deps: PortalFetchDependencies | undefined,
): JobHandler<"portal_fetch"> {
  return async ({ job, run, context, now, enqueue, produced }) => {
    if (deps === undefined) {
      throw new NonRetryableJobError("portal fetching is not configured for this worker");
    }
    // A payload may lengthen the worker's cooldown but never shorten it: the
    // per-connection pause is a guardrail, not a per-job preference.
    const cooldownMs = Math.max(
      job.payload.cooldownMs ?? 0,
      deps.cooldownMs ?? DEFAULT_PORTAL_FETCH_COOLDOWN_MS,
    );
    const result = await runPortalFetchJob({
      jobId: job.id,
      attempt: run.attempt,
      context,
      connectionId: job.payload.connectionId,
      now,
      cooldownMs,
      runner: deps.taskRunner,
      connections: deps.connections,
      state: deps.state,
      runs: deps.runs,
    });
    if (result.runId !== undefined) {
      produced({ type: RECORD_TYPES.portalTaskRun, id: result.runId });
    }
    const detail = redactText(
      result.error ?? result.runResult?.errors.join("; ") ?? "no details recorded",
    );
    const summary = {
      connectionId: result.connectionId,
      runId: result.runId ?? null,
      cooldownUntil: result.cooldownUntil ?? null,
      documentsFetched: result.runResult?.documents.length ?? 0,
      warnings: (result.runResult?.warnings ?? []).map(redactText),
    };
    switch (result.status) {
      case "completed":
        return { status: result.status, ...summary };
      case "cooldown": {
        if (run.attempt === 1 || result.cooldownUntil === undefined) {
          // Another job fetched this connection recently: nothing to do.
          return { status: result.status, ...summary };
        }
        // This job's earlier attempt failed after starting the cooldown; the
        // retry must not count as done. Hand the work to a job that runs once
        // the cooldown has passed instead of burning attempts against it.
        const followUp = await enqueue(
          "portal_fetch",
          { ...job.payload, window: result.cooldownUntil },
          { runAfter: result.cooldownUntil },
        );
        return { status: "deferred", ...summary, followUpJobId: followUp.job.id };
      }
      case "duplicate":
        if (run.attempt === 1) {
          return { status: result.status, ...summary };
        }
        throw new NonRetryableJobError(
          "portal job id was consumed by an earlier attempt whose run could not be recorded",
        );
      case "rejected":
        // The task definition or portal changed; retrying cannot help.
        throw new NonRetryableJobError(`portal task rejected: ${detail}`);
      case "failed":
        throw new Error(`portal fetch failed: ${detail}`);
    }
  };
}
