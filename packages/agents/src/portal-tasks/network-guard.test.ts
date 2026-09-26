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
      allowedBodyFields: ["email", "password", "action", "q"],
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
          allowedBodyFields: ["email", "password", "action", "q"],
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

  it("constrains an allowed POST to the reviewed body fields and values", () => {
    const searchTask: PortalTask = {
      ...task,
      httpMethodExceptions: [
        {
          method: "POST",
          urlPattern: "https://portal.test/api",
          reason: "search",
          justification: "Invoice search form posts its filter before listing results.",
          allowedBodyFields: ["action", "q"],
        },
      ],
    };
    const post = (postData: string | null | undefined) =>
      createNetworkGuard({ task: searchTask }).evaluateRequest({
        url: "https://portal.test/api",
        method: "POST",
        resourceType: "xhr",
        postData,
      });

    expect(post("action=search&q=2026")).toEqual({ action: "allow" });
    expect(post('{"action":"search","q":"2026"}')).toEqual({ action: "allow" });
    expect(post(undefined)).toEqual({ action: "allow" });
    expect(post("action=delete")).toEqual({ action: "abort", reason: "unreviewed_body" });
    expect(post("q=x&other=1")).toEqual({ action: "abort", reason: "unreviewed_body" });
    expect(post('{"action":["search"]}')).toEqual({ action: "allow" });
    expect(post('["action"]')).toEqual({ action: "abort", reason: "unreviewed_body" });
    expect(post("--boundary\r\nContent-Disposition: form-data; name=action")).toEqual({
      action: "abort",
      reason: "unreviewed_body",
    });
  });

  it("does not screen login credential values but still restricts login fields", () => {
    const guard = createNetworkGuard({ task });

    const login = guard.evaluateRequest({
      url: "https://portal.test/login",
      method: "POST",
      resourceType: "document",
      postData: "email=a%40b.test&password=Buy2024!delete",
    });
    const extraField = guard.evaluateRequest({
      url: "https://portal.test/login",
      method: "POST",
      resourceType: "document",
      postData: "email=a%40b.test&password=x&remember=1",
    });

    expect(login).toEqual({ action: "allow" });
    expect(extraField).toEqual({ action: "abort", reason: "unreviewed_body" });
    expect(guard.snapshot().blockedRequests).toHaveLength(1);
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

describe("NetworkGuard host matching", () => {
  function decide(url: string, guardTask: PortalTask = task) {
    return createNetworkGuard({ task: guardTask }).evaluateRequest({
      url,
      method: "GET",
      resourceType: "document",
    });
  }

  it("allows subdomains of an allowlisted host", () => {
    expect(decide("https://invoices.portal.test/list").action).toBe("allow");
    expect(decide("https://a.b.portal.test/list").action).toBe("allow");
  });

  it("blocks hosts that merely end with the allowlisted name", () => {
    expect(decide("https://evilportal.test/login")).toEqual({
      action: "abort",
      reason: "off_allowlist",
    });
    expect(decide("https://portal.test.evil.example/login").action).toBe("abort");
  });

  it("matches hosts case-insensitively in both the request and the allowlist", () => {
    expect(decide("HTTPS://PORTAL.TEST/Login").action).toBe("allow");
    expect(decide("https://portal.test/login", { ...task, domains: ["Portal.TEST"] }).action).toBe(
      "allow",
    );
  });

  it("blocks IP literals that are not on the allowlist", () => {
    expect(decide("https://127.0.0.1/login").action).toBe("abort");
    expect(decide("https://[::1]/login").action).toBe("abort");
    expect(decide("https://192.168.0.1/login").action).toBe("abort");
  });

  it("treats only the literal localhost hostname as a cleartext fixture host", () => {
    const localTask: PortalTask = { ...task, domains: ["localhost"] };

    expect(decide("http://localhost:3000/login", localTask).action).toBe("allow");
    expect(decide("http://127.0.0.1:3000/login", localTask)).toEqual({
      action: "abort",
      reason: "off_allowlist",
    });
    expect(decide("http://[::1]:3000/login", localTask).action).toBe("abort");
  });

  it("rejects malformed URLs and records them verbatim", () => {
    const guard = createNetworkGuard({ task });

    const decision = guard.evaluateRequest({
      url: "not a url",
      method: "GET",
      resourceType: "document",
    });

    expect(decision).toEqual({ action: "abort", reason: "off_allowlist" });
    expect(guard.snapshot().blockedRequests).toEqual([
      { url: "not a url", method: "GET", resourceType: "document", reason: "off_allowlist" },
    ]);
  });

  it("blocks non-http(s) schemes such as javascript:, mailto:, data:, and file:", () => {
    for (const url of [
      "javascript:alert(1)",
      "mailto:billing@portal.test",
      "data:application/pdf;base64,JVBERi0=",
      "file:///etc/passwd",
    ]) {
      expect(decide(url), url).toEqual({ action: "abort", reason: "off_allowlist" });
    }
  });

  it("reports an off-allowlist WebSocket as off_allowlist before the websocket rule", () => {
    const guard = createNetworkGuard({ task });

    const decision = guard.evaluateRequest({
      url: "wss://evil.test/live",
      method: "GET",
      resourceType: "websocket",
    });

    expect(decision).toEqual({ action: "abort", reason: "off_allowlist" });
  });

  it("blocks cleartext ws: to a non-local host and websocket ws: even on localhost", () => {
    const localTask: PortalTask = { ...task, domains: ["localhost", "portal.test"] };
    const guard = createNetworkGuard({ task: localTask });

    const remote = guard.evaluateRequest({
      url: "ws://portal.test/live",
      method: "GET",
      resourceType: "websocket",
    });
    const local = guard.evaluateRequest({
      url: "ws://localhost:3000/live",
      method: "GET",
      resourceType: "websocket",
    });

    expect(remote).toEqual({ action: "abort", reason: "off_allowlist" });
    expect(local).toEqual({ action: "abort", reason: "websocket" });
  });
});

describe("NetworkGuard methods and exceptions", () => {
  it("normalizes method case when classifying and recording requests", () => {
    const guard = createNetworkGuard({ task });

    const get = guard.evaluateRequest({
      url: "https://portal.test/invoices",
      method: "get",
      resourceType: "document",
    });
    const login = guard.evaluateRequest({
      url: "https://portal.test/login",
      method: "post",
      resourceType: "document",
    });
    const remove = guard.evaluateRequest({
      url: "https://portal.test/invoices/1",
      method: "delete",
      resourceType: "xhr",
    });

    expect(get.action).toBe("allow");
    expect(login.action).toBe("allow");
    expect(remove).toEqual({ action: "abort", reason: "non_idempotent_method" });
    expect(guard.snapshot().allowedNonIdempotentRequests[0]?.method).toBe("POST");
    expect(guard.snapshot().blockedRequests[0]?.method).toBe("DELETE");
  });

  it("allows HEAD and OPTIONS without an exception but blocks PUT and PATCH", () => {
    const guard = createNetworkGuard({ task });
    const request = (method: string) =>
      guard.evaluateRequest({ url: "https://portal.test/invoices", method, resourceType: "xhr" });

    expect(request("HEAD").action).toBe("allow");
    expect(request("OPTIONS").action).toBe("allow");
    expect(request("PUT")).toEqual({ action: "abort", reason: "non_idempotent_method" });
    expect(request("PATCH")).toEqual({ action: "abort", reason: "non_idempotent_method" });
    expect(guard.snapshot().allowedNonIdempotentRequests).toEqual([]);
  });

  it("does not let a POST exception admit other methods on the same endpoint", () => {
    const guard = createNetworkGuard({ task });

    const put = guard.evaluateRequest({
      url: "https://portal.test/login",
      method: "PUT",
      resourceType: "xhr",
    });
    const remove = guard.evaluateRequest({
      url: "https://portal.test/login",
      method: "DELETE",
      resourceType: "xhr",
    });

    expect(put).toEqual({ action: "abort", reason: "non_idempotent_method" });
    expect(remove).toEqual({ action: "abort", reason: "non_idempotent_method" });
    expect(guard.snapshot().allowedNonIdempotentRequests).toEqual([]);
  });

  it("matches exceptions case-insensitively on host and ignores only the fragment", () => {
    const guard = createNetworkGuard({ task });

    const upperHost = guard.evaluateRequest({
      url: "https://PORTAL.test/login#step-2",
      method: "POST",
      resourceType: "document",
    });
    const trailingSlash = guard.evaluateRequest({
      url: "https://portal.test/login/",
      method: "POST",
      resourceType: "document",
    });
    const otherPort = guard.evaluateRequest({
      url: "https://portal.test:8443/login",
      method: "POST",
      resourceType: "document",
    });

    expect(upperHost.action).toBe("allow");
    expect(trailingSlash).toEqual({ action: "abort", reason: "non_idempotent_method" });
    expect(otherPort).toEqual({ action: "abort", reason: "non_idempotent_method" });
    expect(guard.snapshot().allowedNonIdempotentRequests).toEqual([
      expect.objectContaining({ url: "https://portal.test/login", method: "POST" }),
    ]);
  });

  it("records each matched exception with its own reason when several are declared", () => {
    const multiTask: PortalTask = {
      ...task,
      httpMethodExceptions: [
        ...task.httpMethodExceptions,
        {
          method: "POST",
          urlPattern: "https://portal.test/invoices/search",
          reason: "search",
          justification: "Invoice search form posts its filter before listing results.",
          allowedBodyFields: ["email", "password", "action", "q"],
        },
      ],
    };
    const guard = createNetworkGuard({ task: multiTask });

    guard.evaluateRequest({
      url: "https://portal.test/invoices/search",
      method: "POST",
      resourceType: "xhr",
    });
    guard.evaluateRequest({
      url: "https://portal.test/login",
      method: "POST",
      resourceType: "document",
    });

    expect(guard.snapshot().allowedNonIdempotentRequests.map((entry) => entry.reason)).toEqual([
      "search",
      "login",
    ]);
  });

  it("does not apply an exception whose host is off the allowlist", () => {
    const leakyTask: PortalTask = {
      ...task,
      httpMethodExceptions: [
        {
          method: "POST",
          urlPattern: "https://sso.other.test/login",
          reason: "login",
          justification: "Third-party SSO login is not on the task allowlist.",
          allowedBodyFields: ["email", "password", "action", "q"],
        },
      ],
    };
    const guard = createNetworkGuard({ task: leakyTask });

    const decision = guard.evaluateRequest({
      url: "https://sso.other.test/login",
      method: "POST",
      resourceType: "document",
    });

    expect(decision).toEqual({ action: "abort", reason: "off_allowlist" });
    expect(guard.snapshot().allowedNonIdempotentRequests).toEqual([]);
  });
});

describe("NetworkGuard snapshot", () => {
  it("returns copies so callers cannot mutate the guard's records", () => {
    const guard = createNetworkGuard({ task });
    guard.evaluateRequest({
      url: "https://tracking.example/pixel.gif",
      method: "GET",
      resourceType: "image",
    });
    guard.evaluateRequest({
      url: "https://portal.test/login",
      method: "POST",
      resourceType: "document",
    });

    const first = guard.snapshot();
    first.blockedRequests.length = 0;
    const firstAllowed = first.allowedNonIdempotentRequests[0];
    if (firstAllowed === undefined) {
      throw new Error("expected the login POST to be recorded");
    }
    firstAllowed.justification = "tampered";
    first.allowedNonIdempotentRequests.push({
      url: "https://portal.test/forged",
      method: "POST",
      reason: "search",
      justification: "forged entry",
    });

    const second = guard.snapshot();
    expect(second.blockedRequests).toHaveLength(1);
    expect(second.allowedNonIdempotentRequests).toHaveLength(1);
    expect(second.allowedNonIdempotentRequests[0]?.justification).toBe(
      "Portal login form requires a POST before read-only invoice access.",
    );
  });

  it("drops query strings and fragments from recorded URLs but keeps the port", () => {
    const guard = createNetworkGuard({ task });

    guard.evaluateRequest({
      url: "https://evil.test:8443/steal?session=abc123#frag",
      method: "GET",
      resourceType: "xhr",
    });
    guard.evaluateRequest({
      url: "https://portal.test/login?redirect=%2Finvoices&token=t0k3n",
      method: "POST",
      resourceType: "document",
    });

    const snapshot = guard.snapshot();
    expect(snapshot.blockedRequests[0]?.url).toBe("https://evil.test:8443/steal");
    // The exception requires an exact query match, so this POST is blocked,
    // and its recorded URL must not carry the token.
    expect(snapshot.blockedRequests[1]).toMatchObject({
      url: "https://portal.test/login",
      reason: "non_idempotent_method",
    });
    expect(JSON.stringify(snapshot)).not.toContain("t0k3n");
    expect(JSON.stringify(snapshot)).not.toContain("abc123");
  });
});
