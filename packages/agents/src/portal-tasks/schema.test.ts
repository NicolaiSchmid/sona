import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { syntheticReferencePortalTask } from "./definitions/synthetic-reference-portal.js";
import {
  PORTAL_EXCEPTION_HTTP_METHODS,
  parsePortalTask,
  portalTaskDigest,
  portalTaskStepSchema,
  safeParsePortalTask,
} from "./schema.js";

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
            allowedBodyFields: ["email", "password"],
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
            allowedBodyFields: ["email", "password"],
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

  it("requires every POST exception to declare its reviewed body fields", () => {
    const raw = loadFixture() as Record<string, unknown>;
    const exception = (allowedBodyFields: unknown) =>
      safeParsePortalTask({
        ...raw,
        httpMethodExceptions: [
          {
            method: "POST",
            urlPattern: "https://amazon.de/login",
            reason: "login",
            justification: "Portal login requires POST before read-only invoice access.",
            ...(allowedBodyFields === undefined ? {} : { allowedBodyFields }),
          },
        ],
      }).success;

    expect(exception(["email", "password"])).toBe(true);
    expect(exception(undefined)).toBe(false);
    expect(exception([])).toBe(false);
    expect(exception([""])).toBe(false);
  });

  it("digests a task independently of key order and changes when the definition changes", () => {
    const task = parsePortalTask(syntheticReferencePortalTask);
    const reordered = parsePortalTask(
      Object.fromEntries(Object.entries(syntheticReferencePortalTask).reverse()),
    );

    expect(portalTaskDigest(task)).toMatch(/^[0-9a-f]{64}$/);
    expect(portalTaskDigest(reordered)).toBe(portalTaskDigest(task));
    expect(portalTaskDigest({ ...task, domains: ["attacker.test"] })).not.toBe(
      portalTaskDigest(task),
    );
    expect(portalTaskDigest({ ...task, version: 2 })).not.toBe(portalTaskDigest(task));
  });

  it("digests a YAML round-trip of a definition identically to the object literal", () => {
    const task = parsePortalTask(syntheticReferencePortalTask);
    const roundTripped = parsePortalTask(parse(stringify(syntheticReferencePortalTask)));

    expect(portalTaskDigest(roundTripped)).toBe(portalTaskDigest(task));
  });

  it("digests nested step and exception key order independently", () => {
    const task = parsePortalTask(syntheticReferencePortalTask);
    const reorderedNested = parsePortalTask({
      ...syntheticReferencePortalTask,
      steps: syntheticReferencePortalTask.steps.map((step) =>
        Object.fromEntries(Object.entries(step).reverse()),
      ),
      httpMethodExceptions: syntheticReferencePortalTask.httpMethodExceptions.map((exception) =>
        Object.fromEntries(Object.entries(exception).reverse()),
      ),
    });

    expect(portalTaskDigest(reorderedNested)).toBe(portalTaskDigest(task));
  });

  it("changes the digest when the order of steps or domains changes", () => {
    const task = parsePortalTask(syntheticReferencePortalTask);
    const twoDomains = parsePortalTask({
      ...syntheticReferencePortalTask,
      domains: ["portal.test", "invoices.portal.test"],
    });
    const flippedDomains = parsePortalTask({
      ...syntheticReferencePortalTask,
      domains: ["invoices.portal.test", "portal.test"],
    });

    expect(portalTaskDigest({ ...task, steps: [...task.steps].reverse() })).not.toBe(
      portalTaskDigest(task),
    );
    expect(portalTaskDigest(flippedDomains)).not.toBe(portalTaskDigest(twoDomains));
  });

  it("distinguishes an explicit sensitive: false from an absent flag", () => {
    // Documents current behavior: only undefined values are dropped from the
    // canonical form, so spelling out `sensitive: false` is a different
    // revision than omitting it and requires a fresh connection approval.
    const task = parsePortalTask(syntheticReferencePortalTask);
    const explicit = {
      ...task,
      steps: task.steps.map((step) => ({ ...step, sensitive: step.sensitive ?? false })),
    };
    const explicitUndefined = {
      ...task,
      steps: task.steps.map((step) => ({ ...step, sensitive: step.sensitive })),
    };

    expect(portalTaskDigest(explicit)).not.toBe(portalTaskDigest(task));
    expect(portalTaskDigest(explicitUndefined)).toBe(portalTaskDigest(task));
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
          allowedBodyFields: ["email", "password"],
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

  it("only ever justifies POST as a non-idempotent method", () => {
    expect(PORTAL_EXCEPTION_HTTP_METHODS).toEqual(["POST"]);
  });

  it("rejects every userinfo form in navigation URLs", () => {
    const raw = loadFixture() as Record<string, unknown>;
    const navigate = (url: string) =>
      safeParsePortalTask({ ...raw, steps: [{ kind: "navigate", url }] }).success;

    expect(navigate("https://:pw@amazon.de/login")).toBe(false);
    expect(navigate("https://user@amazon.de/login")).toBe(false);
    expect(navigate("https://user:@amazon.de/login")).toBe(false);
    expect(navigate("https://amazon.de/login?next=user@example.test")).toBe(true);
  });

  it("rejects exception endpoints with destructive intent in path or query", () => {
    const raw = loadFixture() as Record<string, unknown>;
    const exception = (urlPattern: string) =>
      safeParsePortalTask({
        ...raw,
        httpMethodExceptions: [
          {
            method: "POST",
            urlPattern,
            reason: "search",
            justification: "Invoice search form posts its filter before listing results.",
            allowedBodyFields: ["email", "password"],
          },
        ],
      });

    expect(exception("https://amazon.de/orders/cancel").success).toBe(false);
    expect(exception("https://amazon.de/api?do=refund").success).toBe(false);
    expect(exception("https://amazon.de/account/payment-method").success).toBe(false);
    expect(exception("https://amazon.de/Orders/DELETE").success).toBe(false);
    // Only the path and query are inspected; the host is bound by the allowlist.
    expect(exception("https://pay.amazon.de/invoices/search").success).toBe(true);
    // "payments" is not the forbidden token "pay".
    expect(exception("https://amazon.de/payments/invoices/search").success).toBe(true);

    const failure = exception("https://amazon.de/api?do=refund");
    if (failure.success) {
      throw new Error("expected refund endpoint to be rejected");
    }
    expect(failure.error.issues[0]?.path).toEqual(["httpMethodExceptions", 0, "urlPattern"]);
  });

  it("requires a strict exception shape with a meaningful justification", () => {
    const raw = loadFixture() as Record<string, unknown>;
    const exception = (overrides: Record<string, unknown>) =>
      safeParsePortalTask({
        ...raw,
        httpMethodExceptions: [
          {
            method: "POST",
            urlPattern: "https://amazon.de/login",
            reason: "login",
            justification: "Portal login requires POST before read-only invoice access.",
            allowedBodyFields: ["email", "password"],
            ...overrides,
          },
        ],
      }).success;

    expect(exception({})).toBe(true);
    expect(exception({ justification: "short" })).toBe(false);
    expect(exception({ justification: "           x           " })).toBe(false);
    expect(exception({ reason: "checkout" })).toBe(false);
    expect(exception({ extra: true })).toBe(false);
  });

  it("accepts an optional boolean sensitive flag on every step kind", () => {
    const raw = loadFixture() as Record<string, unknown>;
    const withSteps = (steps: unknown[]) => safeParsePortalTask({ ...raw, steps });

    const accepted = withSteps([
      { kind: "navigate", url: "https://amazon.de/login", sensitive: true },
      { kind: "fill", selector: "#pw", credentialKey: "password", sensitive: true },
      { kind: "click", selector: "button.login", sensitive: false },
      { kind: "waitForSelector", selector: "#list" },
      { kind: "downloadLinks", selector: "a.pdf" },
    ]);
    if (!accepted.success) {
      throw new Error(accepted.error.message);
    }
    expect(accepted.data.steps.map((step) => step.sensitive)).toEqual([
      true,
      true,
      false,
      undefined,
      undefined,
    ]);
    expect(
      withSteps([{ kind: "navigate", url: "https://amazon.de/login", sensitive: "yes" }]).success,
    ).toBe(false);
  });

  it("applies downloadLinks defaults and rejects empty attribute names", () => {
    const parsed = portalTaskStepSchema.parse({ kind: "downloadLinks", selector: "a.pdf" });
    if (parsed.kind !== "downloadLinks") {
      throw new Error("expected a downloadLinks step");
    }

    expect(parsed.hrefAttribute).toBe("href");
    expect(parsed.mimeType).toBe("application/pdf");
    expect(parsed.filenameAttribute).toBeUndefined();
    expect(
      portalTaskStepSchema.safeParse({
        kind: "downloadLinks",
        selector: "a.pdf",
        hrefAttribute: "",
      }).success,
    ).toBe(false);
    expect(
      portalTaskStepSchema.safeParse({ kind: "downloadLinks", selector: "a.pdf", mimeType: "" })
        .success,
    ).toBe(false);
    expect(portalTaskStepSchema.safeParse({ kind: "downloadLinks", selector: "" }).success).toBe(
      false,
    );
  });

  it("requires waitForSelector.timeoutMs to be a positive integer when present", () => {
    const wait = (timeoutMs: unknown) =>
      portalTaskStepSchema.safeParse({ kind: "waitForSelector", selector: "#list", timeoutMs })
        .success;

    expect(wait(undefined)).toBe(true);
    expect(wait(1)).toBe(true);
    expect(wait(30_000)).toBe(true);
    expect(wait(0)).toBe(false);
    expect(wait(-1)).toBe(false);
    expect(wait(1.5)).toBe(false);
    expect(wait("1000")).toBe(false);
  });

  it("rejects fill steps without a credential key and unknown step kinds", () => {
    expect(portalTaskStepSchema.safeParse({ kind: "fill", selector: "#pw" }).success).toBe(false);
    expect(
      portalTaskStepSchema.safeParse({ kind: "fill", selector: "#pw", credentialKey: "" }).success,
    ).toBe(false);
    expect(portalTaskStepSchema.safeParse({ kind: "evaluate", script: "1" }).success).toBe(false);
  });

  it("preserves the synthetic reference task's sensitive flags and login exception", () => {
    const parsed = parsePortalTask(syntheticReferencePortalTask);

    expect(parsed.steps.map((step) => step.sensitive ?? false)).toEqual([
      true,
      false,
      true,
      false,
      false,
      false,
    ]);
    expect(parsed.httpMethodExceptions).toEqual([
      expect.objectContaining({
        method: "POST",
        urlPattern: "https://portal.test/login",
        reason: "login",
      }),
    ]);
    const download = parsed.steps.at(-1);
    expect(download).toMatchObject({
      kind: "downloadLinks",
      hrefAttribute: "href",
      filenameAttribute: "data-filename",
      mimeType: "application/pdf",
    });
  });
});
