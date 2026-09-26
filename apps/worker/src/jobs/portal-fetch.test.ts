import type {
  PortalTask,
  PortalTaskRunner,
  PortalTaskRunStatus,
  RunPortalTaskInput,
  RunPortalTaskResult,
} from "@sona/agents";
import { FakePortalTaskRunner } from "@sona/agents";
import { describe, expect, it } from "vitest";
import {
  InMemoryPortalFetchConnectionRepository,
  InMemoryPortalFetchJobStateStore,
  InMemoryPortalFetchRunRecorder,
  type PortalFetchConnection,
  type PortalFetchConnectionRepository,
  type PortalFetchJobStateStore,
  type PortalFetchJobStatus,
  type RecordPortalFetchRunInput,
  type RunPortalFetchJobInput,
  runPortalFetchJob,
} from "./portal-fetch.js";

const task: PortalTask = {
  id: "synthetic-reference-portal",
  name: "Synthetic reference portal",
  version: 1,
  risk: "read_only_document_fetch",
  domains: ["portal.test"],
  requires: ["credentials"],
  allowedActions: ["navigate", "search_invoices", "download_invoice_pdf"],
  forbiddenActions: ["purchase", "cancel_order"],
  outputs: ["document_file", "provenance_json"],
  httpMethodExceptions: [],
  steps: [],
};

const runs = new InMemoryPortalFetchRunRecorder();

function singleConnection(): InMemoryPortalFetchConnectionRepository {
  return new InMemoryPortalFetchConnectionRepository([{ id: "conn_1", workspaceId: "ws_1", task }]);
}

/** A well-formed job for `conn_1` in `ws_1`; tests override only what they exercise. */
function jobInput(
  overrides: Partial<RunPortalFetchJobInput> &
    Pick<RunPortalFetchJobInput, "state" | "connections">,
): RunPortalFetchJobInput {
  return {
    jobId: "job_1",
    attempt: 1,
    context: { workspaceId: "ws_1" },
    connectionId: "conn_1",
    now: "2026-02-01T00:00:00Z",
    cooldownMs: 60_000,
    runner: new FakePortalTaskRunner(),
    runs,
    ...overrides,
  };
}

describe("portal_fetch job", () => {
  it("runs a portal task by connection ID and treats repeated job IDs as idempotent", async () => {
    const state = new InMemoryPortalFetchJobStateStore();
    const connections = singleConnection();

    const first = await runPortalFetchJob(jobInput({ state, connections }));
    const second = await runPortalFetchJob(
      jobInput({ state, connections, now: "2026-02-01T00:00:30Z" }),
    );

    expect(first.status).toBe("completed");
    expect(first.runResult?.runId).toBe("job_1:1");
    expect(second.status).toBe("duplicate");
    expect(second.runResult).toBeUndefined();
  });

  it("respects per-portal cooldowns across different job IDs", async () => {
    const state = new InMemoryPortalFetchJobStateStore();
    const connections = singleConnection();

    await runPortalFetchJob(jobInput({ state, connections }));
    const blocked = await runPortalFetchJob(
      jobInput({ state, connections, jobId: "job_2", now: "2026-02-01T00:00:30Z" }),
    );

    expect(blocked.status).toBe("cooldown");
    expect(blocked.cooldownUntil).toBe("2026-02-01T00:01:00.000Z");
  });

  it("reserves the per-portal cooldown before the browser runner finishes", async () => {
    const state = new InMemoryPortalFetchJobStateStore();
    const connections = singleConnection();
    const runner = new BlockingPortalTaskRunner();

    const first = runPortalFetchJob(jobInput({ state, connections, runner }));
    await runner.started;
    const second = await runPortalFetchJob(
      jobInput({ state, connections, jobId: "job_2", now: "2026-02-01T00:00:01Z" }),
    );
    runner.resolve();
    const firstResult = await first;

    expect(second.status).toBe("cooldown");
    expect(second.cooldownUntil).toBe("2026-02-01T00:01:00.000Z");
    expect(firstResult.status).toBe("completed");
  });

  it("releases the job lease after a failed run so a retry can run after the cooldown", async () => {
    const state = new InMemoryPortalFetchJobStateStore();
    const connections = singleConnection();

    const failed = await runPortalFetchJob(
      jobInput({ state, connections, runner: new StatusPortalTaskRunner("failed") }),
    );
    const duringCooldown = await runPortalFetchJob(
      jobInput({ state, connections, now: "2026-02-01T00:00:30Z" }),
    );
    const retried = await runPortalFetchJob(
      jobInput({ state, connections, now: "2026-02-01T00:01:00Z" }),
    );
    const afterSuccess = await runPortalFetchJob(
      jobInput({ state, connections, now: "2026-02-01T00:03:00Z" }),
    );

    expect(failed.status).toBe("failed");
    expect(duringCooldown.status).toBe("cooldown");
    expect(retried.status).toBe("completed");
    expect(afterSuccess.status).toBe("duplicate");
  });

  it("releases the job lease when the runner throws", async () => {
    const state = new InMemoryPortalFetchJobStateStore();
    const connections = singleConnection();

    const thrown = await runPortalFetchJob(
      jobInput({ state, connections, runner: new ThrowingPortalTaskRunner() }),
    );
    const retried = await runPortalFetchJob(
      jobInput({ state, connections, now: "2026-02-01T00:01:00Z" }),
    );

    expect(thrown.status).toBe("failed");
    expect(thrown.runResult).toBeUndefined();
    expect(retried.status).toBe("completed");
  });

  it.each([
    "blocked",
    "policy_refused",
    "selector_missing",
  ] as const)("consumes the job id for the terminal runner status %s instead of retrying", async (status) => {
    const state = new InMemoryPortalFetchJobStateStore();
    const connections = singleConnection();

    const result = await runPortalFetchJob(
      jobInput({ state, connections, runner: new StatusPortalTaskRunner(status) }),
    );
    const retry = await runPortalFetchJob(
      jobInput({ state, connections, now: "2026-02-01T00:05:00Z" }),
    );

    expect(result.status).toBe("rejected");
    expect(result.runResult?.status).toBe(status);
    expect(retry.status).toBe("duplicate");
  });

  it("settles every runner status explicitly: only failed leaves the job id retryable", async () => {
    const expected = {
      completed: "completed",
      policy_refused: "rejected",
      selector_missing: "rejected",
      blocked: "rejected",
      failed: "failed",
    } as const satisfies Record<PortalTaskRunStatus, PortalFetchJobStatus>;
    const connections = singleConnection();

    for (const status of Object.keys(expected) as readonly PortalTaskRunStatus[]) {
      const state = new InMemoryPortalFetchJobStateStore();
      const result = await runPortalFetchJob(
        jobInput({ state, connections, runner: new StatusPortalTaskRunner(status) }),
      );
      const again = await runPortalFetchJob(
        jobInput({ state, connections, now: "2026-02-01T00:05:00Z" }),
      );

      expect(result.status, status).toBe(expected[status]);
      expect(again.status, status).toBe(status === "failed" ? "completed" : "duplicate");
    }
  });

  it("records every run that produced a result before settling the lease", async () => {
    const state = new InMemoryPortalFetchJobStateStore();
    const recorder = new InMemoryPortalFetchRunRecorder();
    const connections = singleConnection();
    const base = { state, connections, cooldownMs: 1, runs: recorder };

    await runPortalFetchJob(jobInput({ ...base, jobId: "job_1" }));
    await runPortalFetchJob(
      jobInput({
        ...base,
        jobId: "job_2",
        now: "2026-02-01T00:01:00Z",
        runner: new StatusPortalTaskRunner("blocked"),
      }),
    );
    await runPortalFetchJob(
      jobInput({
        ...base,
        jobId: "job_3",
        now: "2026-02-01T00:02:00Z",
        runner: new ThrowingPortalTaskRunner(),
      }),
    );

    expect(
      recorder.listRuns({ workspaceId: "ws_1" }).map((run) => [run.runId, run.status]),
    ).toEqual([
      ["job_1:1", "completed"],
      ["job_2:1", "blocked"],
    ]);
    expect(recorder.listRuns({ workspaceId: "ws_other" })).toEqual([]);
  });

  it("keeps the lease instead of rerunning the browser when the run cannot be recorded", async () => {
    const state = new InMemoryPortalFetchJobStateStore();
    const connections = singleConnection();
    let attempts = 0;
    const failingRecorder = {
      async recordRun(): Promise<void> {
        attempts += 1;
        throw new Error("run history unavailable");
      },
    };
    const counting = new CountingPortalTaskRunner();

    await expect(
      runPortalFetchJob(jobInput({ state, connections, runs: failingRecorder })),
    ).rejects.toThrow(
      /could not be recorded after 3 attempts; lease kept: run history unavailable/,
    );
    const retried = await runPortalFetchJob(
      jobInput({ state, connections, runner: counting, now: "2026-02-01T00:01:00Z" }),
    );

    expect(attempts).toBe(3);
    expect(retried.status).toBe("duplicate");
    expect(counting.runCount).toBe(0);
  });

  it("retries recording transiently and records the connection id", async () => {
    const state = new InMemoryPortalFetchJobStateStore();
    const connections = singleConnection();
    const recorded: RecordPortalFetchRunInput[] = [];
    let failures = 2;
    const flakyRecorder = {
      async recordRun(input: RecordPortalFetchRunInput): Promise<void> {
        if (failures > 0) {
          failures -= 1;
          throw new Error("transient");
        }
        recorded.push(input);
      },
    };

    const result = await runPortalFetchJob(jobInput({ state, connections, runs: flakyRecorder }));

    expect(result.status).toBe("completed");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ context: { workspaceId: "ws_1" } });
    expect(recorded[0]?.result.provenance.connectionId).toBe("conn_1");
  });

  it("gives each delivery attempt of a job id its own run id", async () => {
    const state = new InMemoryPortalFetchJobStateStore();
    const connections = singleConnection();
    const base = { state, connections, cooldownMs: 1 };

    const first = await runPortalFetchJob(
      jobInput({ ...base, runner: new StatusPortalTaskRunner("failed") }),
    );
    const second = await runPortalFetchJob(
      jobInput({ ...base, attempt: 2, now: "2026-02-01T00:01:00Z" }),
    );

    expect(first.runId).toBe("job_1:1");
    expect(second.runId).toBe("job_1:2");
    expect(second.runResult?.provenance.runId).toBe("job_1:2");
  });

  it("reports a release failure alongside the run error without throwing", async () => {
    const state = new InMemoryPortalFetchJobStateStore();
    const brokenRelease = {
      acquire: state.acquire.bind(state),
      complete: state.complete.bind(state),
      async release(): Promise<void> {
        throw new Error("lease store offline");
      },
    };

    const result = await runPortalFetchJob(
      jobInput({
        state: brokenRelease,
        connections: singleConnection(),
        runner: new ThrowingPortalTaskRunner(),
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.error).toBe("browser crashed; lease release failed: lease store offline");
  });

  it("propagates a failing complete after a recorded run and leaves the job id leased", async () => {
    // Documents current behavior: the run is already in the audit history, the
    // error surfaces to the queue, and the lease is not released, so a retry
    // of the same job id is refused until a durable store expires the lease.
    const state = new InMemoryPortalFetchJobStateStore();
    const recorder = new InMemoryPortalFetchRunRecorder();
    const connections = singleConnection();
    const brokenComplete: PortalFetchJobStateStore = {
      acquire: state.acquire.bind(state),
      release: state.release.bind(state),
      async complete(): Promise<void> {
        throw new Error("lease store offline");
      },
    };

    await expect(
      runPortalFetchJob(jobInput({ state: brokenComplete, connections, runs: recorder })),
    ).rejects.toThrow("lease store offline");
    const retry = await runPortalFetchJob(
      jobInput({ state, connections, now: "2026-02-01T00:05:00Z", runs: recorder }),
    );

    expect(recorder.listRuns({ workspaceId: "ws_1" }).map((run) => run.runId)).toEqual(["job_1:1"]);
    expect(retry.status).toBe("duplicate");
  });

  it("leaves error undefined for a failed run result whose lease was released cleanly", async () => {
    const result = await runPortalFetchJob(
      jobInput({
        state: new InMemoryPortalFetchJobStateStore(),
        connections: singleConnection(),
        runner: new StatusPortalTaskRunner("failed"),
      }),
    );

    expect(result).toMatchObject({
      status: "failed",
      runId: "job_1:1",
      cooldownUntil: "2026-02-01T00:01:00.000Z",
      error: undefined,
    });
    expect(result.runResult?.status).toBe("failed");
  });

  it("reports only the release failure when the runner returned a failed result", async () => {
    const state = new InMemoryPortalFetchJobStateStore();
    const brokenRelease: PortalFetchJobStateStore = {
      acquire: state.acquire.bind(state),
      complete: state.complete.bind(state),
      async release(): Promise<void> {
        throw new Error("lease store offline");
      },
    };

    const result = await runPortalFetchJob(
      jobInput({
        state: brokenRelease,
        connections: singleConnection(),
        runner: new StatusPortalTaskRunner("failed"),
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.error).toBe("lease release failed: lease store offline");
    expect(result.runResult?.status).toBe("failed");
  });

  it("never invokes the runner for duplicate or cooling-down reservations", async () => {
    const state = new InMemoryPortalFetchJobStateStore();
    const connections = singleConnection();
    const counting = new CountingPortalTaskRunner();

    await runPortalFetchJob(jobInput({ state, connections }));
    const duplicate = await runPortalFetchJob(
      jobInput({ state, connections, now: "2026-02-01T00:05:00Z", runner: counting }),
    );
    const cooling = await runPortalFetchJob(
      jobInput({
        state,
        connections,
        jobId: "job_2",
        now: "2026-02-01T00:00:30Z",
        runner: counting,
      }),
    );

    expect(duplicate.status).toBe("duplicate");
    expect(duplicate.cooldownUntil).toBeUndefined();
    expect(cooling.status).toBe("cooldown");
    expect(counting.runCount).toBe(0);
  });

  it("refuses a connection that belongs to another workspace before contacting the portal", async () => {
    const counting = new CountingPortalTaskRunner();
    const state = new CountingJobStateStore();
    const leaky: PortalFetchConnectionRepository = {
      async getConnection(input): Promise<PortalFetchConnection> {
        return { id: input.connectionId, workspaceId: "ws_other", task };
      },
    };

    const result = await runPortalFetchJob(
      jobInput({ state, connections: leaky, runner: counting }),
    );

    expect(result).toEqual({
      status: "failed",
      connectionId: "conn_1",
      runId: undefined,
      cooldownUntil: undefined,
      runResult: undefined,
      error: "portal connection belongs to another workspace",
    });
    expect(counting.runCount).toBe(0);
    expect(state.acquireCount).toBe(0);
  });

  it("does not resolve connections across workspaces in the in-memory repository", async () => {
    const counting = new CountingPortalTaskRunner();
    const state = new CountingJobStateStore();

    await expect(
      runPortalFetchJob(
        jobInput({
          state,
          connections: singleConnection(),
          context: { workspaceId: "ws_2" },
          runner: counting,
        }),
      ),
    ).rejects.toThrow("Portal fetch connection not found: conn_1");
    expect(counting.runCount).toBe(0);
    expect(state.acquireCount).toBe(0);
  });

  it("rejects an invalid workspace context before any lookup", async () => {
    const counting = new CountingPortalTaskRunner();
    const state = new CountingJobStateStore();

    await expect(
      runPortalFetchJob(
        jobInput({
          state,
          connections: singleConnection(),
          context: { workspaceId: "" },
          runner: counting,
        }),
      ),
    ).rejects.toThrow(/workspace context/i);
    expect(counting.runCount).toBe(0);
    expect(state.acquireCount).toBe(0);
  });

  it("keeps the portal cooldown even when the run fails", async () => {
    const state = new InMemoryPortalFetchJobStateStore();

    const failed = await runPortalFetchJob(
      jobInput({
        state,
        connections: singleConnection(),
        runner: new ThrowingPortalTaskRunner(),
      }),
    );
    const reservation = await state.acquire({
      jobId: "job_2",
      workspaceId: "ws_1",
      connectionId: "conn_1",
      now: "2026-02-01T00:00:59Z",
      cooldownUntil: "2026-02-01T00:02:00.000Z",
    });

    expect(failed.status).toBe("failed");
    expect(failed.cooldownUntil).toBe("2026-02-01T00:01:00.000Z");
    expect(reservation).toEqual({ status: "cooldown", cooldownUntil: "2026-02-01T00:01:00.000Z" });
  });
});

describe("InMemoryPortalFetchJobStateStore", () => {
  const lease = (workspaceId: string, jobId = "job_1", connectionId = "conn_1") => ({
    jobId,
    workspaceId,
    connectionId,
  });
  const acquire = (
    state: PortalFetchJobStateStore,
    workspaceId: string,
    now: string,
    jobId = "job_1",
    connectionId = "conn_1",
  ) =>
    state.acquire({
      ...lease(workspaceId, jobId, connectionId),
      now,
      cooldownUntil: new Date(Date.parse(now) + 60_000).toISOString(),
    });

  it("treats the same job id in two workspaces as independent leases", async () => {
    const state = new InMemoryPortalFetchJobStateStore();

    const first = await acquire(state, "ws_1", "2026-02-01T00:00:00Z");
    const second = await acquire(state, "ws_2", "2026-02-01T00:00:00Z");
    await state.complete(lease("ws_1"));
    const retryOther = await acquire(state, "ws_2", "2026-02-01T00:05:00Z", "job_9");

    expect(first.status).toBe("acquired");
    expect(second.status).toBe("acquired");
    expect(retryOther.status).toBe("acquired");
  });

  it("scopes connection cooldowns to the workspace", async () => {
    const state = new InMemoryPortalFetchJobStateStore();

    await acquire(state, "ws_1", "2026-02-01T00:00:00Z");
    const otherWorkspace = await acquire(state, "ws_2", "2026-02-01T00:00:10Z", "job_2");
    const sameWorkspace = await acquire(state, "ws_1", "2026-02-01T00:00:10Z", "job_3");

    expect(otherWorkspace.status).toBe("acquired");
    expect(sameWorkspace.status).toBe("cooldown");
  });

  it("keeps a completed job idempotent even if release is called afterwards", async () => {
    const state = new InMemoryPortalFetchJobStateStore();

    await acquire(state, "ws_1", "2026-02-01T00:00:00Z");
    await state.complete(lease("ws_1"));
    await state.release(lease("ws_1"));
    const again = await acquire(state, "ws_1", "2026-02-01T01:00:00Z");

    expect(again).toEqual({ status: "duplicate", cooldownUntil: undefined });
  });

  it("refuses a leased job id while it is in flight and frees it on release", async () => {
    const state = new InMemoryPortalFetchJobStateStore();

    await acquire(state, "ws_1", "2026-02-01T00:00:00Z");
    const inFlight = await acquire(state, "ws_1", "2026-02-01T00:00:01Z");
    await state.release(lease("ws_1"));
    const afterRelease = await acquire(state, "ws_1", "2026-02-01T00:01:00Z");

    expect(inFlight.status).toBe("duplicate");
    expect(afterRelease.status).toBe("acquired");
  });

  it("ignores release and complete for unknown job ids", async () => {
    const state = new InMemoryPortalFetchJobStateStore();

    await state.release(lease("ws_1"));
    const acquired = await acquire(state, "ws_1", "2026-02-01T00:00:00Z");

    expect(acquired.status).toBe("acquired");
  });

  it("lets a job through once the cooldown boundary has been reached", async () => {
    const state = new InMemoryPortalFetchJobStateStore();

    await acquire(state, "ws_1", "2026-02-01T00:00:00Z");
    const before = await acquire(state, "ws_1", "2026-02-01T00:00:59.999Z", "job_2");
    const atBoundary = await acquire(state, "ws_1", "2026-02-01T00:01:00Z", "job_3");

    expect(before.status).toBe("cooldown");
    expect(atBoundary.status).toBe("acquired");
  });
});

class CountingPortalTaskRunner implements PortalTaskRunner {
  runCount = 0;

  async runTask(input: RunPortalTaskInput): Promise<RunPortalTaskResult> {
    this.runCount += 1;
    return await new FakePortalTaskRunner().runTask(input);
  }
}

class CountingJobStateStore extends InMemoryPortalFetchJobStateStore {
  acquireCount = 0;

  override async acquire(
    input: Parameters<InMemoryPortalFetchJobStateStore["acquire"]>[0],
  ): ReturnType<InMemoryPortalFetchJobStateStore["acquire"]> {
    this.acquireCount += 1;
    return await super.acquire(input);
  }
}

class BlockingPortalTaskRunner implements PortalTaskRunner {
  readonly started: Promise<void>;
  #resolveStarted: (() => void) | undefined;
  #resolveRun: (() => void) | undefined;

  constructor() {
    this.started = new Promise((resolve) => {
      this.#resolveStarted = resolve;
    });
  }

  async runTask(input: RunPortalTaskInput): Promise<RunPortalTaskResult> {
    this.#resolveStarted?.();
    await new Promise<void>((resolve) => {
      this.#resolveRun = resolve;
    });
    return new FakePortalTaskRunner().runTask(input);
  }

  resolve(): void {
    this.#resolveRun?.();
  }
}

class ThrowingPortalTaskRunner implements PortalTaskRunner {
  async runTask(): Promise<RunPortalTaskResult> {
    throw new Error("browser crashed");
  }
}

class StatusPortalTaskRunner implements PortalTaskRunner {
  readonly #status: RunPortalTaskResult["status"];

  constructor(status: RunPortalTaskResult["status"]) {
    this.#status = status;
  }

  async runTask(input: RunPortalTaskInput): Promise<RunPortalTaskResult> {
    const result = await new FakePortalTaskRunner().runTask(input);
    return {
      ...result,
      status: this.#status,
    };
  }
}
