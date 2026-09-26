import { describe, expect, it } from "vitest";
import { redactError, redactJson, redactText } from "./redact.js";
import {
  defaultIdempotencyKey,
  InvalidJobPayloadError,
  isJobKind,
  JOB_KINDS,
  narrowJob,
  parseJobPayload,
} from "./types.js";

describe("job payload schemas", () => {
  it("applies defaults and derives readable idempotency keys per kind", () => {
    const sync = parseJobPayload("source_sync", { sourceId: "src_1" });
    expect(defaultIdempotencyKey("source_sync", sync)).toBe("source_sync:src_1");
    const windowed = parseJobPayload("source_sync", {
      sourceId: "src_1",
      window: "2026-02-01T00:00:00.000Z",
    });
    expect(defaultIdempotencyKey("source_sync", windowed)).toBe(
      "source_sync:src_1:2026-02-01T00:00:00.000Z",
    );

    const ingest = parseJobPayload("document_ingest", { uploadId: "up_1" });
    expect(ingest.sourceKind).toBe("upload");
    expect(defaultIdempotencyKey("document_ingest", ingest)).toBe("document_ingest:up_1");

    expect(
      defaultIdempotencyKey("extraction", parseJobPayload("extraction", { documentId: "d" })),
    ).toBe("extraction:d");
    expect(
      defaultIdempotencyKey(
        "reconciliation",
        parseJobPayload("reconciliation", { documentId: "d" }),
      ),
    ).toBe("reconciliation:d");

    const exportPayload = parseJobPayload("export_generation", { year: 2026 });
    expect(exportPayload).toEqual({ year: 2026, mode: "draft", templateId: "private-de" });
    expect(defaultIdempotencyKey("export_generation", exportPayload)).toBe(
      "export_generation:2026:draft:private-de",
    );
  });

  it("keys portal fetches per connection and window, and reconciliation per trigger", () => {
    const fetch = parseJobPayload("portal_fetch", { connectionId: "conn_1" });
    expect(fetch).toEqual({ connectionId: "conn_1" });
    expect(defaultIdempotencyKey("portal_fetch", fetch)).toBe("portal_fetch:conn_1");
    const windowed = parseJobPayload("portal_fetch", {
      connectionId: "conn_1",
      window: "2026-02-01T00:00:00.000Z",
      cooldownMs: 0,
    });
    expect(windowed.cooldownMs).toBe(0);
    // The cooldown tunes the run; it does not identify the work.
    expect(defaultIdempotencyKey("portal_fetch", windowed)).toBe(
      "portal_fetch:conn_1:2026-02-01T00:00:00.000Z",
    );
    expect(() => parseJobPayload("portal_fetch", { connectionId: "c", cooldownMs: -1 })).toThrow(
      /cooldownMs/,
    );
    expect(() => parseJobPayload("portal_fetch", { connectionId: "c", cooldownMs: 1.5 })).toThrow(
      /cooldownMs/,
    );
    expect(() => parseJobPayload("portal_fetch", { connectionId: " " })).toThrow(/connectionId/);

    const triggered = parseJobPayload("reconciliation", { documentId: "d", trigger: "sync:run_1" });
    expect(defaultIdempotencyKey("reconciliation", triggered)).toBe("reconciliation:d:sync:run_1");
    expect(() => parseJobPayload("reconciliation", { documentId: "d", trigger: "" })).toThrow(
      /trigger/,
    );
  });

  it("rejects malformed payloads with the kind and issue paths", () => {
    expect(() => parseJobPayload("source_sync", { sourceId: "" })).toThrow(InvalidJobPayloadError);
    expect(() => parseJobPayload("source_sync", { sourceId: "s", extra: 1 })).toThrow(/extra/);
    expect(() =>
      parseJobPayload("source_sync", { sourceId: "s", transactionQuery: { dateFrom: "2026" } }),
    ).toThrow(/dateFrom/);
    expect(() => parseJobPayload("export_generation", { year: 2026.5 })).toThrow(/year/);
    expect(() => parseJobPayload("export_generation", { year: 2026, mode: "signed" })).toThrow(
      /mode/,
    );
  });

  it("narrows persisted jobs by kind and refuses mismatches", () => {
    const persisted = {
      id: "job_1",
      workspaceId: "ws_1",
      kind: "extraction",
      payload: { documentId: "doc_1" },
      idempotencyKey: "extraction:doc_1",
      status: "queued" as const,
      attempts: 0,
      maxAttempts: 3,
      runAfter: "2026-02-01T00:00:00.000Z",
      leaseOwner: undefined,
      leaseUntil: undefined,
      lastError: undefined,
      createdAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:00:00.000Z",
    };
    expect(narrowJob(persisted, "extraction").payload.documentId).toBe("doc_1");
    expect(() => narrowJob(persisted, "reconciliation")).toThrow(/not reconciliation/);
    for (const kind of JOB_KINDS) {
      expect(isJobKind(kind)).toBe(true);
    }
    expect(isJobKind("portal_fetch_v0")).toBe(false);
  });
});

describe("error redaction", () => {
  it("masks tokens, IBAN-shaped strings, key=value secrets, and PEM blocks", () => {
    const text = [
      "GET https://api.example/x failed: Authorization: Bearer abc.def-ghi",
      "iban DE89370400440532013000 rejected",
      "session_id=sess_123&api_key=AKIA1234",
      "-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----",
    ].join(" ");
    const redacted = redactText(text);
    expect(redacted).not.toContain("abc.def-ghi");
    expect(redacted).not.toContain("DE89370400440532013000");
    expect(redacted).not.toContain("sess_123");
    expect(redacted).not.toContain("AKIA1234");
    expect(redacted).not.toContain("MIIabc");
    expect(redacted).toContain("[iban redacted]");
    expect(redacted).toContain("[pem redacted]");
  });

  it("masks JWTs and quoted key/value secrets while keeping the key name", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c2lnbmF0dXJlX3N5bnRoZXRpY18xMjM0NTY";
    expect(redactText(`refresh failed for ${jwt} at 12:00`)).toBe(
      "refresh failed for [jwt redacted] at 12:00",
    );
    // An `eyJ` prefix alone (no dot-separated segments) is not a JWT.
    expect(redactText("eyJabc")).toBe("eyJabc");

    const redacted = redactText(
      `password="hunter2-synthetic" token: 'tok_synthetic_1' api-key=ak_synthetic Secret = s3cr3t`,
    );
    // The opening quote is swallowed with the value; a dangling closing quote is harmless.
    expect(redacted).toBe(
      `password=[redacted]" token=[redacted]' api-key=[redacted] Secret=[redacted]`,
    );
    expect(redacted).not.toMatch(/synthetic|s3cr3t/);
  });

  it("keeps a message of exactly the limit and only truncates beyond it", () => {
    const exact = "y".repeat(500);
    expect(redactText(exact)).toBe(exact);
    const over = "y".repeat(501);
    expect(redactText(over)).toBe(`${"y".repeat(500)}…`);
    expect(redactError(Object.assign(new Error("anon"), { name: "" }))).toBe("Error: anon");
    expect(redactError(undefined)).toBe("undefined");
    expect(redactError({ toString: () => "Bearer abc123" })).toBe("Bearer [redacted]");
  });

  it("masks space-grouped IBANs and redacts JSON metadata by key and value", () => {
    expect(redactText("refused DE89 3704 0044 0532 0130 00 by bank")).toBe(
      "refused [iban redacted] by bank",
    );
    expect(
      redactJson({
        Password: "hunter2",
        privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
        list: [{ cookie: "c=1" }, "Bearer tok.en", 42, null, true],
        keep: { label: "fine" },
      }),
    ).toEqual({
      Password: "[redacted]",
      privateKey: "[redacted]",
      list: [{ cookie: "[redacted]" }, "Bearer [redacted]", 42, null, true],
      keep: { label: "fine" },
    });
  });

  it("truncates long messages and formats errors as name: message", () => {
    const long = "x".repeat(2000);
    expect(redactText(long)).toHaveLength(501);
    expect(redactError(new RangeError("bad range"))).toBe("RangeError: bad range");
    expect(redactError("plain")).toBe("plain");
  });
});
