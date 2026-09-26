import { describe, expect, it } from "vitest";
import { createNetworkGuard } from "./network-guard.js";
import type { PortalTask } from "./schema.js";

const task: PortalTask = {
  id: "synthetic-reference-portal",
  name: "Synthetic reference portal",
  version: 1,
  risk: "read_only_document_fetch",
  domains: ["portal.test"],
  requires: ["credentials"],
  allowedActions: ["navigate", "login", "search_invoices", "download_invoice_pdf"],
  forbiddenActions: ["purchase", "cancel_order"],
  outputs: ["document_file", "provenance_json"],
  httpMethodExceptions: [
    {
      method: "POST",
      urlPattern: "https://portal.test/login",
      reason: "login",
      justification: "Portal login form requires a POST before read-only invoice access.",
    },
  ],
  steps: [],
};

describe("createNetworkGuard", () => {
  it("aborts off-allowlist navigation and records the blocked request", () => {
    const guard = createNetworkGuard({ task });

    const decision = guard.evaluateRequest({
      url: "https://tracking.example/pixel.gif",
      method: "GET",
      resourceType: "image",
    });

    expect(decision.action).toBe("abort");
    if (decision.action !== "abort") {
      throw new Error("expected request to be aborted");
    }
    expect(decision.reason).toBe("off_allowlist");
    expect(guard.snapshot().blockedRequests).toEqual([
      {
        url: "https://tracking.example/pixel.gif",
        method: "GET",
        resourceType: "image",
        reason: "off_allowlist",
      },
    ]);
  });

  it("blocks POST to a non-justified endpoint", () => {
    const guard = createNetworkGuard({ task });

    const decision = guard.evaluateRequest({
      url: "https://portal.test/settings/profile",
      method: "POST",
      resourceType: "xhr",
    });

    expect(decision.action).toBe("abort");
    if (decision.action !== "abort") {
      throw new Error("expected request to be aborted");
    }
    expect(decision.reason).toBe("non_idempotent_method");
    expect(guard.snapshot().blockedRequests[0]).toMatchObject({
      url: "https://portal.test/settings/profile",
      method: "POST",
      reason: "non_idempotent_method",
    });
  });

  it("allows justified login POSTs and records the justification", () => {
    const guard = createNetworkGuard({ task });

    const decision = guard.evaluateRequest({
      url: "https://portal.test/login",
      method: "POST",
      resourceType: "document",
    });

    expect(decision.action).toBe("allow");
    expect(guard.snapshot().allowedNonIdempotentRequests).toEqual([
      {
        url: "https://portal.test/login",
        method: "POST",
        reason: "login",
        justification: "Portal login form requires a POST before read-only invoice access.",
      },
    ]);
  });

  it("blocks plaintext non-local allowlisted requests", () => {
    const guard = createNetworkGuard({ task });

    const decision = guard.evaluateRequest({
      url: "http://portal.test/login",
      method: "GET",
      resourceType: "document",
    });

    expect(decision.action).toBe("abort");
    expect(guard.snapshot().blockedRequests[0]).toMatchObject({
      url: "http://portal.test/login",
      reason: "off_allowlist",
    });
  });

  it("keeps the query string when matching non-idempotent exceptions", () => {
    const searchTask: PortalTask = {
      ...task,
      httpMethodExceptions: [
        {
          method: "POST",
          urlPattern: "https://portal.test/api?action=search",
          reason: "search",
          justification: "Invoice search form posts its filter before listing results.",
        },
      ],
    };
    const guard = createNetworkGuard({ task: searchTask });

    const allowed = guard.evaluateRequest({
      url: "https://portal.test/api?action=search#top",
      method: "POST",
      resourceType: "xhr",
    });
    const otherAction = guard.evaluateRequest({
      url: "https://portal.test/api?action=delete",
      method: "POST",
      resourceType: "xhr",
    });
    const noQuery = guard.evaluateRequest({
      url: "https://portal.test/api",
      method: "POST",
      resourceType: "xhr",
    });

    expect(allowed.action).toBe("allow");
    expect(otherAction.action).toBe("abort");
    expect(noQuery.action).toBe("abort");
    expect(guard.snapshot().blockedRequests).toHaveLength(2);
  });

  it("refuses WebSocket handshakes even to allowlisted hosts", () => {
    const guard = createNetworkGuard({ task });

    const decision = guard.evaluateRequest({
      url: "wss://portal.test/live",
      method: "GET",
      resourceType: "websocket",
    });

    expect(decision.action).toBe("abort");
    expect(guard.snapshot().blockedRequests[0]).toMatchObject({
      url: "wss://portal.test/live",
      resourceType: "websocket",
      reason: "websocket",
    });
  });

  it("matches non-idempotent exceptions only to the exact sanitized endpoint", () => {
    const guard = createNetworkGuard({ task });

    const decision = guard.evaluateRequest({
      url: "https://portal.test/login/delete-account",
      method: "POST",
      resourceType: "xhr",
    });

    expect(decision.action).toBe("abort");
    expect(guard.snapshot().blockedRequests[0]).toMatchObject({
      url: "https://portal.test/login/delete-account",
      reason: "non_idempotent_method",
    });
  });
});
