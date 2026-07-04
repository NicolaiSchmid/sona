import type { PortalTask } from "@sona/agents";
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
});
