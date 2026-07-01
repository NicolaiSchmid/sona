import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parsePortalTask, safeParsePortalTask } from "./schema.js";

function loadFixture(): unknown {
  const path = fileURLToPath(
    new URL("./fixtures/amazon-de-invoices.example.yaml", import.meta.url),
  );
  return parse(readFileSync(path, "utf8"));
}

describe("portalTaskSchema", () => {
  it("accepts the example Amazon task fixture", () => {
    const task = parsePortalTask(loadFixture());
    expect(task.id).toBe("amazon-de-invoices");
    expect(task.domains).toContain("amazon.de");
    expect(task.risk).toBe("read_only_document_fetch");
  });

  it("rejects a task without a domain allowlist", () => {
    const raw = loadFixture() as Record<string, unknown>;
    expect(safeParsePortalTask({ ...raw, domains: [] }).success).toBe(false);
  });

  it("rejects a task whose allowed actions imply a mutation", () => {
    const raw = loadFixture() as Record<string, unknown>;
    const result = safeParsePortalTask({
      ...raw,
      allowedActions: ["navigate", "cancel_order"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown output type", () => {
    const raw = loadFixture() as Record<string, unknown>;
    expect(safeParsePortalTask({ ...raw, outputs: ["screenshot"] }).success).toBe(false);
  });
});
