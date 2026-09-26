import { FakePortalTaskRunner, type PortalTask } from "@sona/agents";
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
    runner: new FakePortalTaskRunner(),
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
