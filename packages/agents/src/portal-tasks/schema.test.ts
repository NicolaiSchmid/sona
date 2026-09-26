import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { syntheticReferencePortalTask } from "./definitions/synthetic-reference-portal.js";
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

  it("rejects domain entries that are not bare hostnames", () => {
    const raw = loadFixture() as Record<string, unknown>;
    expect(safeParsePortalTask({ ...raw, domains: ["*"] }).success).toBe(false);
    expect(safeParsePortalTask({ ...raw, domains: ["https://amazon.de"] }).success).toBe(false);
    expect(safeParsePortalTask({ ...raw, domains: ["amazon.de/orders"] }).success).toBe(false);
    expect(safeParsePortalTask({ ...raw, domains: ["user@amazon.de"] }).success).toBe(false);
  });

  it("accepts the synthetic executable reference task definition", () => {
    expect(parsePortalTask(syntheticReferencePortalTask).steps).toHaveLength(6);
  });

  it("rejects selectors with destructive intent", () => {
    const raw = loadFixture() as Record<string, unknown>;
    const result = safeParsePortalTask({
      ...raw,
      steps: [
        {
          kind: "click",
          selector: "button[aria-label='Cancel order']",
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rejects credentials embedded in navigation and exception URLs", () => {
    const raw = loadFixture() as Record<string, unknown>;

    expect(
      safeParsePortalTask({
        ...raw,
        steps: [{ kind: "navigate", url: "https://user:password@amazon.de/login" }],
      }).success,
    ).toBe(false);
    expect(
      safeParsePortalTask({
        ...raw,
        httpMethodExceptions: [
          {
            method: "POST",
            urlPattern: "https://token@amazon.de/login",
            reason: "login",
            justification: "Portal login requires POST before read-only invoice access.",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("only allows POST exceptions to endpoints without destructive intent", () => {
    const raw = loadFixture() as Record<string, unknown>;
    const exception = (method: string, urlPattern: string) =>
      safeParsePortalTask({
        ...raw,
        httpMethodExceptions: [
          {
            method,
            urlPattern,
            reason: "login",
            justification: "Portal login requires POST before read-only invoice access.",
          },
        ],
      }).success;

    expect(exception("POST", "https://amazon.de/login")).toBe(true);
    expect(exception("DELETE", "https://amazon.de/login")).toBe(false);
    expect(exception("PUT", "https://amazon.de/login")).toBe(false);
    expect(exception("PATCH", "https://amazon.de/login")).toBe(false);
    expect(exception("POST", "https://amazon.de/delete-account")).toBe(false);
    expect(exception("POST", "https://amazon.de/api?action=cancel")).toBe(false);
  });

  it("rejects plaintext non-local navigation and exception URLs", () => {
    const raw = loadFixture() as Record<string, unknown>;
    const plaintextNavigate = safeParsePortalTask({
      ...raw,
      steps: [{ kind: "navigate", url: "http://amazon.de/login" }],
    });
    const plaintextException = safeParsePortalTask({
      ...raw,
      httpMethodExceptions: [
        {
          method: "POST",
          urlPattern: "http://amazon.de/login",
          reason: "login",
          justification: "Portal login requires POST before read-only invoice access.",
        },
      ],
    });

    expect(plaintextNavigate.success).toBe(false);
    expect(plaintextException.success).toBe(false);
    expect(
      safeParsePortalTask({
        ...raw,
        domains: ["localhost"],
        steps: [{ kind: "navigate", url: "http://localhost:3000/login" }],
      }).success,
    ).toBe(true);
  });
});
