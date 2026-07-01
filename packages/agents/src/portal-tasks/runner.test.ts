import { describe, expect, it } from "vitest";
import { FakePortalTaskRunner, type RunPortalTaskInput } from "./runner.js";
import type { PortalTask } from "./schema.js";

const safeTask: PortalTask = {
  id: "amazon-de-invoices",
  name: "Amazon Germany invoice fetcher",
  version: 1,
  risk: "read_only_document_fetch",
  domains: ["amazon.de"],
  requires: ["authenticated_session_or_credentials"],
  allowedActions: ["navigate", "search_orders", "download_invoice_pdf"],
  forbiddenActions: ["purchase"],
  outputs: ["document_file", "provenance_json"],
};

function input(task: PortalTask): RunPortalTaskInput {
  return {
    task,
    connectionId: "conn_1",
    runId: "run_1",
    workspaceId: "ws_1",
    now: "2026-02-01T00:00:00Z",
  };
}

describe("FakePortalTaskRunner", () => {
  it("returns a fetched PDF with provenance for a safe task", async () => {
    const result = await new FakePortalTaskRunner().runTask(input(safeTask));

    expect(result.errors).toEqual([]);
    expect(result.documents).toHaveLength(1);
    const doc = result.documents[0];
    expect(doc?.mimeType).toBe("application/pdf");
    expect(doc?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(doc?.provenance.taskId).toBe("amazon-de-invoices");
    expect(doc?.provenance.browserProvider).toBe("fake");
    expect(result.provenance.portalDomain).toBe("amazon.de");
    // The payload bytes are carried so storage can persist the original file.
    expect(doc?.content.kind).toBe("bytes");
  });

  it("refuses to run a task that declares a mutating action", async () => {
    // Bypasses the schema to exercise the runner's execution-time guard.
    const unsafe: PortalTask = { ...safeTask, allowedActions: ["navigate", "cancel_order"] };
    const result = await new FakePortalTaskRunner().runTask(input(unsafe));

    expect(result.documents).toEqual([]);
    expect(result.errors.join(" ")).toContain("cancel");
  });
});
