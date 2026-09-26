import { FakePortalTaskRunner, type PortalTask, type PortalTaskRunner } from "@sona/agents";
import { describe, expect, it } from "vitest";
import { createTestHarness, WS_1, WS_2 } from "../test-support.js";
import {
  InMemoryPortalFetchConnectionRepository,
  InMemoryPortalFetchJobStateStore,
  InMemoryPortalFetchRunRecorder,
} from "./portal-fetch.js";
import type { PortalFetchDependencies } from "./portal-fetch-handler.js";

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

function portalFetch(
  connections: InMemoryPortalFetchConnectionRepository,
): PortalFetchDependencies & { runs: InMemoryPortalFetchRunRecorder } {
  return {
    taskRunner: new FakePortalTaskRunner(),
    connections,
    state: new InMemoryPortalFetchJobStateStore(),
    runs: new InMemoryPortalFetchRunRecorder(),
    cooldownMs: 60_000,
  };
}

describe("portal_fetch job kind", () => {
  it("dead-letters when the worker has no portal runner configured", async () => {
    const h = await createTestHarness({ seedSources: false });
    try {
      await h.worker.queue.enqueue(h.context, "portal_fetch", { connectionId: "conn_1" });
      const [outcome] = await h.worker.runOnce();
      expect(outcome).toMatchObject({ kind: "portal_fetch", state: "dead" });
      expect(outcome?.error).toMatch(/not configured/);
    } finally {
      h.close();
    }
  });

  it("runs the read-only task once per connection and cooldown, with run provenance", async () => {
    const deps = portalFetch(
      new InMemoryPortalFetchConnectionRepository([{ id: "conn_1", workspaceId: WS_1, task }]),
    );
    const h = await createTestHarness({ seedSources: false, worker: { portalFetch: deps } });
    try {
      const first = await h.worker.queue.enqueue(h.context, "portal_fetch", {
        connectionId: "conn_1",
        window: "w1",
      });
      // Same connection and window: coalesced into the same job.
      const dup = await h.worker.queue.enqueue(h.context, "portal_fetch", {
        connectionId: "conn_1",
        window: "w1",
      });
      expect(dup.created).toBe(false);
      const [outcome] = await h.worker.runOnce();
      expect(outcome?.state).toBe("succeeded");
      expect(outcome?.produced).toEqual([{ type: "portal_task_run", id: `${first.job.id}:1` }]);
      const run = (await h.worker.queue.listRuns(h.context, first.job.id))[0];
      expect(run?.result).toMatchObject({
        status: "completed",
        connectionId: "conn_1",
        runId: `${first.job.id}:1`,
        documentsFetched: 1,
      });
      expect(deps.runs.listRuns(h.context)).toHaveLength(1);

      // A second window inside the cooldown does not launch another browser run.
      h.clock.advance(1_000);
      const second = await h.worker.queue.enqueue(h.context, "portal_fetch", {
        connectionId: "conn_1",
        window: "w2",
      });
      const [again] = await h.worker.runOnce();
      expect(again?.state).toBe("succeeded");
      expect((await h.worker.queue.listRuns(h.context, second.job.id))[0]?.result).toMatchObject({
        status: "cooldown",
        runId: null,
      });
      expect(deps.runs.listRuns(h.context)).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("lets a payload lengthen the connection cooldown but never shorten it", async () => {
    const deps = portalFetch(
      new InMemoryPortalFetchConnectionRepository([{ id: "conn_1", workspaceId: WS_1, task }]),
    );
    const h = await createTestHarness({ seedSources: false, worker: { portalFetch: deps } });
    try {
      // A zero cooldown in the payload is floored to the worker's 60s guardrail.
      await h.worker.queue.enqueue(h.context, "portal_fetch", {
        connectionId: "conn_1",
        window: "w1",
        cooldownMs: 0,
      });
      const [first] = await h.worker.runOnce();
      expect(first?.state).toBe("succeeded");
      expect(
        (await h.worker.queue.listRuns(h.context, first?.jobId ?? ""))[0]?.result,
      ).toMatchObject({ status: "completed", cooldownUntil: "2026-02-01T00:01:00.000Z" });

      // Past the guardrail, a longer payload cooldown is honoured.
      h.clock.advance(61_000);
      const second = await h.worker.queue.enqueue(h.context, "portal_fetch", {
        connectionId: "conn_1",
        window: "w2",
        cooldownMs: 10 * 60_000,
      });
      await h.worker.runOnce();
      expect((await h.worker.queue.listRuns(h.context, second.job.id))[0]?.result).toMatchObject({
        status: "completed",
        cooldownUntil: "2026-02-01T00:11:01.000Z",
      });
      expect(deps.runs.listRuns(h.context)).toHaveLength(2);
    } finally {
      h.close();
    }
  });

  it("defers a retried job that lands in its own cooldown instead of settling it as done", async () => {
    let calls = 0;
    const flaky: PortalTaskRunner = {
      runTask: async (input) => {
        calls += 1;
        if (calls === 1) {
          throw new Error("browser crashed with session_id=leaky");
        }
        return new FakePortalTaskRunner().runTask(input);
      },
    };
    const deps = {
      ...portalFetch(
        new InMemoryPortalFetchConnectionRepository([{ id: "conn_1", workspaceId: WS_1, task }]),
      ),
      taskRunner: flaky,
    };
    const h = await createTestHarness({ seedSources: false, worker: { portalFetch: deps } });
    try {
      const { job } = await h.worker.queue.enqueue(h.context, "portal_fetch", {
        connectionId: "conn_1",
      });
      const [attempt1] = await h.worker.runOnce();
      expect(attempt1).toMatchObject({ state: "retry_scheduled", attempt: 1 });
      expect(attempt1?.error).not.toContain("leaky");

      // The retry finds the connection cooling down from its own failed start.
      h.clock.advance(1_000);
      const [attempt2] = await h.worker.runOnce();
      expect(attempt2).toMatchObject({ jobId: job.id, state: "succeeded", attempt: 2 });
      const run = (await h.worker.queue.listRuns(h.context, job.id))[1];
      expect(run?.result).toMatchObject({
        status: "deferred",
        runId: null,
        cooldownUntil: "2026-02-01T00:01:00.000Z",
      });
      const followUpId = (run?.result as { followUpJobId: string }).followUpJobId;
      const followUp = await h.worker.queue.get(h.context, followUpId);
      expect(followUp).toMatchObject({
        kind: "portal_fetch",
        status: "queued",
        runAfter: "2026-02-01T00:01:00.000Z",
        payload: { connectionId: "conn_1", window: "2026-02-01T00:01:00.000Z" },
      });
      expect(deps.runs.listRuns(h.context)).toHaveLength(0);

      // Not before the cooldown ends...
      expect(await h.worker.runOnce()).toEqual([]);
      // ...then the follow-up performs the fetch.
      h.clock.advance(60_000);
      const [deferred] = await h.worker.runOnce();
      expect(deferred).toMatchObject({ jobId: followUpId, state: "succeeded" });
      expect((await h.worker.queue.listRuns(h.context, followUpId))[0]?.result).toMatchObject({
        status: "completed",
      });
      expect(deps.runs.listRuns(h.context)).toHaveLength(1);
      expect(calls).toBe(2);
    } finally {
      h.close();
    }
  });

  it("dead-letters a task the read-only policy refuses and keeps the run on record", async () => {
    const forbidden: PortalTask = { ...task, id: "buys-things", allowedActions: ["purchase"] };
    const deps = portalFetch(
      new InMemoryPortalFetchConnectionRepository([
        { id: "conn_bad", workspaceId: WS_1, task: forbidden },
      ]),
    );
    const h = await createTestHarness({ seedSources: false, worker: { portalFetch: deps } });
    try {
      await h.worker.queue.enqueue(h.context, "portal_fetch", { connectionId: "conn_bad" });
      const [outcome] = await h.worker.runOnce();
      expect(outcome?.state).toBe("dead");
      expect(outcome?.error).toMatch(/rejected/);
      expect(outcome?.error).toMatch(/purchase/);
      expect(deps.runs.listRuns(h.context)).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("retries a connection that is unknown in the job's workspace as a failure, never crossing workspaces", async () => {
    const deps = portalFetch(
      new InMemoryPortalFetchConnectionRepository([{ id: "conn_1", workspaceId: WS_2, task }]),
    );
    const h = await createTestHarness({ seedSources: false, worker: { portalFetch: deps } });
    try {
      await h.worker.queue.enqueue(h.context, "portal_fetch", { connectionId: "conn_1" });
      const [outcome] = await h.worker.runOnce();
      // The connection repository refuses the lookup for ws_1; the queue retries.
      expect(outcome?.state).toBe("retry_scheduled");
      expect(outcome?.error).toMatch(/not found/);
      expect(deps.runs.listRuns(h.context)).toHaveLength(0);
      expect(deps.runs.listRuns(h.otherContext)).toHaveLength(0);
    } finally {
      h.close();
    }
  });
});
