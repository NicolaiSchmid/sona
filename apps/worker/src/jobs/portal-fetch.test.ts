import type {
  PortalTask,
  PortalTaskRunner,
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

describe("portal_fetch job", () => {
  it("runs a portal task by connection ID and treats repeated job IDs as idempotent", async () => {
    const state = new InMemoryPortalFetchJobStateStore();
    const connections = new InMemoryPortalFetchConnectionRepository([
      {
        id: "conn_1",
        workspaceId: "ws_1",
        task,
      },
    ]);

    const first = await runPortalFetchJob({
      jobId: "job_1",
      context: { workspaceId: "ws_1" },
      connectionId: "conn_1",
      now: "2026-02-01T00:00:00Z",
      cooldownMs: 60_000,
      runner: new FakePortalTaskRunner(),
      connections,
      state,
      runs,
    });
    const second = await runPortalFetchJob({
      jobId: "job_1",
      context: { workspaceId: "ws_1" },
      connectionId: "conn_1",
      now: "2026-02-01T00:00:30Z",
      cooldownMs: 60_000,
      runner: new FakePortalTaskRunner(),
      connections,
      state,
      runs,
    });

    expect(first.status).toBe("completed");
    expect(first.runResult?.runId).toBe("job_1");
    expect(second.status).toBe("duplicate");
    expect(second.runResult).toBeUndefined();
  });

  it("respects per-portal cooldowns across different job IDs", async () => {
    const state = new InMemoryPortalFetchJobStateStore();
    const connections = new InMemoryPortalFetchConnectionRepository([
      {
        id: "conn_1",
        workspaceId: "ws_1",
        task,
      },
    ]);

    await runPortalFetchJob({
      jobId: "job_1",
      context: { workspaceId: "ws_1" },
      connectionId: "conn_1",
      now: "2026-02-01T00:00:00Z",
      cooldownMs: 60_000,
      runner: new FakePortalTaskRunner(),
      connections,
      state,
      runs,
    });
    const blocked = await runPortalFetchJob({
      jobId: "job_2",
      context: { workspaceId: "ws_1" },
      connectionId: "conn_1",
      now: "2026-02-01T00:00:30Z",
      cooldownMs: 60_000,
      runner: new FakePortalTaskRunner(),
      connections,
      state,
      runs,
    });

    expect(blocked.status).toBe("cooldown");
    expect(blocked.cooldownUntil).toBe("2026-02-01T00:01:00.000Z");
  });

  it("reserves the per-portal cooldown before the browser runner finishes", async () => {
    const state = new InMemoryPortalFetchJobStateStore();
    const connections = new InMemoryPortalFetchConnectionRepository([
      {
        id: "conn_1",
        workspaceId: "ws_1",
        task,
      },
    ]);
    const runner = new BlockingPortalTaskRunner();

    const first = runPortalFetchJob({
      jobId: "job_1",
      context: { workspaceId: "ws_1" },
      connectionId: "conn_1",
      now: "2026-02-01T00:00:00Z",
      cooldownMs: 60_000,
      runner,
      connections,
      state,
      runs,
    });
    await runner.started;
    const second = await runPortalFetchJob({
      jobId: "job_2",
      context: { workspaceId: "ws_1" },
      connectionId: "conn_1",
      now: "2026-02-01T00:00:01Z",
      cooldownMs: 60_000,
      runner: new FakePortalTaskRunner(),
      connections,
      state,
      runs,
    });
    runner.resolve();
    const firstResult = await first;

    expect(second.status).toBe("cooldown");
    expect(second.cooldownUntil).toBe("2026-02-01T00:01:00.000Z");
    expect(firstResult.status).toBe("completed");
  });

  it("releases the job lease after a failed run so a retry can run after the cooldown", async () => {
    const state = new InMemoryPortalFetchJobStateStore();
    const connections = new InMemoryPortalFetchConnectionRepository([
      { id: "conn_1", workspaceId: "ws_1", task },
    ]);
    const base = {
      jobId: "job_1",
      context: { workspaceId: "ws_1" },
      connectionId: "conn_1",
      cooldownMs: 60_000,
      connections,
      state,
      runs,
    };

    const failed = await runPortalFetchJob({
      ...base,
      now: "2026-02-01T00:00:00Z",
      runner: new StatusPortalTaskRunner("failed"),
    });
    const duringCooldown = await runPortalFetchJob({
      ...base,
      now: "2026-02-01T00:00:30Z",
      runner: new FakePortalTaskRunner(),
    });
    const retried = await runPortalFetchJob({
      ...base,
      now: "2026-02-01T00:01:00Z",
      runner: new FakePortalTaskRunner(),
    });
    const afterSuccess = await runPortalFetchJob({
      ...base,
      now: "2026-02-01T00:03:00Z",
      runner: new FakePortalTaskRunner(),
    });

    expect(failed.status).toBe("failed");
    expect(duringCooldown.status).toBe("cooldown");
    expect(retried.status).toBe("completed");
    expect(afterSuccess.status).toBe("duplicate");
  });

  it("releases the job lease when the runner throws", async () => {
    const state = new InMemoryPortalFetchJobStateStore();
    const connections = new InMemoryPortalFetchConnectionRepository([
      { id: "conn_1", workspaceId: "ws_1", task },
    ]);
    const base = {
      jobId: "job_1",
      context: { workspaceId: "ws_1" },
      connectionId: "conn_1",
      cooldownMs: 60_000,
      connections,
      state,
      runs,
    };

    const thrown = await runPortalFetchJob({
      ...base,
      now: "2026-02-01T00:00:00Z",
      runner: new ThrowingPortalTaskRunner(),
    });
    const retried = await runPortalFetchJob({
      ...base,
      now: "2026-02-01T00:01:00Z",
      runner: new FakePortalTaskRunner(),
    });

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
    const connections = new InMemoryPortalFetchConnectionRepository([
      { id: "conn_1", workspaceId: "ws_1", task },
    ]);
    const base = {
      jobId: "job_1",
      context: { workspaceId: "ws_1" },
      connectionId: "conn_1",
      cooldownMs: 60_000,
      connections,
      state,
      runs,
    };

    const result = await runPortalFetchJob({
      ...base,
      now: "2026-02-01T00:00:00Z",
      runner: new StatusPortalTaskRunner(status),
    });
    const retry = await runPortalFetchJob({
      ...base,
      now: "2026-02-01T00:05:00Z",
      runner: new FakePortalTaskRunner(),
    });

    expect(result.status).toBe("rejected");
    expect(result.runResult?.status).toBe(status);
    expect(retry.status).toBe("duplicate");
  });

  it("records every run that produced a result before settling the lease", async () => {
    const state = new InMemoryPortalFetchJobStateStore();
    const recorder = new InMemoryPortalFetchRunRecorder();
    const connections = new InMemoryPortalFetchConnectionRepository([
      { id: "conn_1", workspaceId: "ws_1", task },
    ]);
    const base = {
      context: { workspaceId: "ws_1" },
      connectionId: "conn_1",
      cooldownMs: 1,
      connections,
      state,
      runs: recorder,
    };

    await runPortalFetchJob({
      ...base,
      jobId: "job_1",
      now: "2026-02-01T00:00:00Z",
      runner: new FakePortalTaskRunner(),
    });
    await runPortalFetchJob({
      ...base,
      jobId: "job_2",
      now: "2026-02-01T00:01:00Z",
      runner: new StatusPortalTaskRunner("blocked"),
    });
    await runPortalFetchJob({
      ...base,
      jobId: "job_3",
      now: "2026-02-01T00:02:00Z",
      runner: new ThrowingPortalTaskRunner(),
    });

    expect(
      recorder.listRuns({ workspaceId: "ws_1" }).map((run) => [run.runId, run.status]),
    ).toEqual([
      ["job_1", "completed"],
      ["job_2", "blocked"],
    ]);
    expect(recorder.listRuns({ workspaceId: "ws_other" })).toEqual([]);
  });

  it("hands the job back to the queue when the run cannot be recorded", async () => {
    const state = new InMemoryPortalFetchJobStateStore();
    const connections = new InMemoryPortalFetchConnectionRepository([
      { id: "conn_1", workspaceId: "ws_1", task },
    ]);
    const failingRecorder = {
      async recordRun(): Promise<void> {
        throw new Error("run history unavailable");
      },
    };
    const base = {
      jobId: "job_1",
      context: { workspaceId: "ws_1" },
      connectionId: "conn_1",
      cooldownMs: 60_000,
      connections,
      state,
    };

    await expect(
      runPortalFetchJob({
        ...base,
        now: "2026-02-01T00:00:00Z",
        runner: new FakePortalTaskRunner(),
        runs: failingRecorder,
      }),
    ).rejects.toThrow("run history unavailable");
    const retried = await runPortalFetchJob({
      ...base,
      now: "2026-02-01T00:01:00Z",
      runner: new FakePortalTaskRunner(),
      runs,
    });

    expect(retried.status).toBe("completed");
  });

  it("gives each delivery attempt of a job id its own run id", async () => {
    const state = new InMemoryPortalFetchJobStateStore();
    const connections = new InMemoryPortalFetchConnectionRepository([
      { id: "conn_1", workspaceId: "ws_1", task },
    ]);
    const base = {
      jobId: "job_1",
      context: { workspaceId: "ws_1" },
      connectionId: "conn_1",
      cooldownMs: 1,
      connections,
      state,
      runs,
    };

    const first = await runPortalFetchJob({
      ...base,
      now: "2026-02-01T00:00:00Z",
      runner: new StatusPortalTaskRunner("failed"),
    });
    const second = await runPortalFetchJob({
      ...base,
      attempt: 2,
      now: "2026-02-01T00:01:00Z",
      runner: new FakePortalTaskRunner(),
    });

    expect(first.runId).toBe("job_1");
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
    const connections = new InMemoryPortalFetchConnectionRepository([
      { id: "conn_1", workspaceId: "ws_1", task },
    ]);

    const result = await runPortalFetchJob({
      jobId: "job_1",
      context: { workspaceId: "ws_1" },
      connectionId: "conn_1",
      now: "2026-02-01T00:00:00Z",
      cooldownMs: 60_000,
      runner: new ThrowingPortalTaskRunner(),
      connections,
      state: brokenRelease,
      runs,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toBe("browser crashed; lease release failed: lease store offline");
  });

  it("never invokes the runner for duplicate or cooling-down reservations", async () => {
    const state = new InMemoryPortalFetchJobStateStore();
    const connections = new InMemoryPortalFetchConnectionRepository([
      { id: "conn_1", workspaceId: "ws_1", task },
    ]);
    const counting = new CountingPortalTaskRunner();
    const base = {
      context: { workspaceId: "ws_1" },
      connectionId: "conn_1",
      cooldownMs: 60_000,
      connections,
      state,
      runs,
    };

    await runPortalFetchJob({
      ...base,
      jobId: "job_1",
      now: "2026-02-01T00:00:00Z",
      runner: new FakePortalTaskRunner(),
    });
    const duplicate = await runPortalFetchJob({
      ...base,
      jobId: "job_1",
      now: "2026-02-01T00:05:00Z",
      runner: counting,
    });
    const cooling = await runPortalFetchJob({
      ...base,
      jobId: "job_2",
      now: "2026-02-01T00:00:30Z",
      runner: counting,
    });

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

    const result = await runPortalFetchJob({
      jobId: "job_1",
      context: { workspaceId: "ws_1" },
      connectionId: "conn_1",
      now: "2026-02-01T00:00:00Z",
      cooldownMs: 60_000,
      runner: counting,
      connections: leaky,
      state,
      runs,
    });

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
    const connections = new InMemoryPortalFetchConnectionRepository([
      { id: "conn_1", workspaceId: "ws_1", task },
    ]);

    await expect(
      runPortalFetchJob({
        jobId: "job_1",
        context: { workspaceId: "ws_2" },
        connectionId: "conn_1",
        now: "2026-02-01T00:00:00Z",
        cooldownMs: 60_000,
        runner: counting,
        connections,
        state,
        runs,
      }),
    ).rejects.toThrow("Portal fetch connection not found: conn_1");
    expect(counting.runCount).toBe(0);
    expect(state.acquireCount).toBe(0);
  });

  it("rejects an invalid workspace context before any lookup", async () => {
    const counting = new CountingPortalTaskRunner();
    const state = new CountingJobStateStore();
    const connections = new InMemoryPortalFetchConnectionRepository([
      { id: "conn_1", workspaceId: "ws_1", task },
    ]);

    await expect(
      runPortalFetchJob({
        jobId: "job_1",
        context: { workspaceId: "" },
        connectionId: "conn_1",
        now: "2026-02-01T00:00:00Z",
        cooldownMs: 60_000,
        runner: counting,
        connections,
        state,
        runs,
      }),
    ).rejects.toThrow(/workspace context/i);
    expect(counting.runCount).toBe(0);
    expect(state.acquireCount).toBe(0);
  });

  it("keeps the portal cooldown even when the run fails", async () => {
    const state = new InMemoryPortalFetchJobStateStore();
    const connections = new InMemoryPortalFetchConnectionRepository([
      { id: "conn_1", workspaceId: "ws_1", task },
    ]);

    const failed = await runPortalFetchJob({
      jobId: "job_1",
      context: { workspaceId: "ws_1" },
      connectionId: "conn_1",
      now: "2026-02-01T00:00:00Z",
      cooldownMs: 60_000,
      runner: new ThrowingPortalTaskRunner(),
      connections,
      state,
      runs,
    });
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
