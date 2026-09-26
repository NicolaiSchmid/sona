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

describe("portal_fetch job", () => {
  it("runs a portal task by connection ID and treats repeated job IDs as idempotent", async () => {
    const state = new InMemoryPortalFetchJobStateStore();
    const connections = new InMemoryPortalFetchConnectionRepository([
      {
        connectionId: "conn_1",
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
        connectionId: "conn_1",
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
    });

    expect(blocked.status).toBe("cooldown");
    expect(blocked.cooldownUntil).toBe("2026-02-01T00:01:00.000Z");
  });

  it("reserves the per-portal cooldown before the browser runner finishes", async () => {
    const state = new InMemoryPortalFetchJobStateStore();
    const connections = new InMemoryPortalFetchConnectionRepository([
      {
        connectionId: "conn_1",
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
      { connectionId: "conn_1", workspaceId: "ws_1", task },
    ]);
    const base = {
      jobId: "job_1",
      context: { workspaceId: "ws_1" },
      connectionId: "conn_1",
      cooldownMs: 60_000,
      connections,
      state,
    };

    const failed = await runPortalFetchJob({
      ...base,
      now: "2026-02-01T00:00:00Z",
      runner: new StatusPortalTaskRunner("blocked"),
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
      { connectionId: "conn_1", workspaceId: "ws_1", task },
    ]);
    const base = {
      jobId: "job_1",
      context: { workspaceId: "ws_1" },
      connectionId: "conn_1",
      cooldownMs: 60_000,
      connections,
      state,
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

  it("propagates non-success runner statuses as failed jobs", async () => {
    const state = new InMemoryPortalFetchJobStateStore();
    const connections = new InMemoryPortalFetchConnectionRepository([
      {
        connectionId: "conn_1",
        workspaceId: "ws_1",
        task,
      },
    ]);

    const result = await runPortalFetchJob({
      jobId: "job_1",
      context: { workspaceId: "ws_1" },
      connectionId: "conn_1",
      now: "2026-02-01T00:00:00Z",
      cooldownMs: 60_000,
      runner: new StatusPortalTaskRunner("blocked"),
      connections,
      state,
    });

    expect(result.status).toBe("failed");
    expect(result.runResult?.status).toBe("blocked");
  });
});

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
