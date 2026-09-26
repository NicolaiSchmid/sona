import { describe, expect, it } from "vitest";
import { createNetworkGuard, isMaterialBlock, type PortalRequest } from "./network-guard.js";
import type { BlockedPortalRequest } from "./provenance.js";
import type { PortalHttpMethodException, PortalTask } from "./schema.js";

/** A reviewed POST exception; the login form fields are the default body review. */
function postException(
  overrides: Pick<PortalHttpMethodException, "urlPattern" | "reason" | "justification"> &
    Partial<PortalHttpMethodException>,
): PortalHttpMethodException {
  return {
    method: "POST",
    allowedBodyFields: ["email", "password", "action", "q"],
    credentialBodyFields: ["email", "password"],
    pinnedBodyValues: {},
    ...overrides,
  };
}

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
    postException({
      urlPattern: "https://portal.test/login",
      reason: "login",
      justification: "Portal login form requires a POST before read-only invoice access.",
    }),
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
        postException({
          urlPattern: "https://portal.test/api?action=search",
          reason: "search",
          justification: "Invoice search form posts its filter before listing results.",
        }),
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
        postException({
          urlPattern: "https://portal.test/api",
          reason: "search",
          justification: "Invoice search form posts its filter before listing results.",
          allowedBodyFields: ["action", "q"],
          credentialBodyFields: [],
        }),
      ],
    };
    const post = (postData: string | undefined) =>
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

  it("requires pinned control-field values and never screens credential values", () => {
    const loginTask: PortalTask = {
      ...task,
      httpMethodExceptions: [
        postException({
          urlPattern: "https://portal.test/api",
          reason: "login",
          justification: "Multiplexed login endpoint dispatches on the action field.",
          allowedBodyFields: ["action", "email", "password", "remember"],
          pinnedBodyValues: { action: ["login"] },
        }),
      ],
    };
    const post = (postData: string) =>
      createNetworkGuard({ task: loginTask }).evaluateRequest({
        url: "https://portal.test/api",
        method: "POST",
        resourceType: "xhr",
        postData,
      });

    expect(post("action=login&email=a%40b.test&password=Delete-Me-2024&remember=1")).toEqual({
      action: "allow",
    });
    expect(post("action=delete&email=a%40b.test&password=x")).toEqual({
      action: "abort",
      reason: "unreviewed_body",
    });
    expect(post("action=login&remember=delete")).toEqual({
      action: "abort",
      reason: "unreviewed_body",
    });
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
      reason: "streaming_channel",
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
      reason: "destructive_url",
    });
  });

  it("refuses URLs that name a forbidden operation even over GET", () => {
    const guard = createNetworkGuard({ task });
    const request = (url: string, resourceType: PortalRequest["resourceType"]) =>
      guard.evaluateRequest({ url, method: "GET", resourceType });

    expect(request("https://portal.test/cancel-subscription", "document")).toEqual({
      action: "abort",
      reason: "destructive_url",
    });
    expect(request("https://portal.test/api/cart/remove?id=1", "xhr")).toEqual({
      action: "abort",
      reason: "destructive_url",
    });
    expect(request("https://portal.test/api/orders?action=refund", "fetch")).toEqual({
      action: "abort",
      reason: "destructive_url",
    });
    expect(request("https://portal.test/invoices/2026-01.pdf", "document")).toEqual({
      action: "allow",
    });
    expect(request("https://portal.test/img/add.svg", "image")).toEqual({ action: "allow" });
    expect(request("https://portal.test/js/confirm-dialog.js", "script")).toEqual({
      action: "allow",
    });
  });

  it("redacts identifier-like path segments in recorded request URLs", () => {
    const guard = createNetworkGuard({ task });

    guard.evaluateRequest({
      url: "https://tracking.example/u/user%40example.test/t/AbCdEfGhIjKlMnOpQrStUvWxYz0123?sig=x",
      method: "GET",
      resourceType: "image",
    });

    expect(guard.snapshot().blockedRequests[0]?.url).toBe(
      "https://tracking.example/u/[REDACTED_SEGMENT]/t/[REDACTED_SEGMENT]",
    );
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
    expect(local).toEqual({ action: "abort", reason: "streaming_channel" });
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
        postException({
          urlPattern: "https://portal.test/invoices/search",
          reason: "search",
          justification: "Invoice search form posts its filter before listing results.",
        }),
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
        postException({
          urlPattern: "https://sso.other.test/login",
          reason: "login",
          justification: "Third-party SSO login is not on the task allowlist.",
        }),
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

describe("NetworkGuard destructive URLs and reviewed bodies", () => {
  const searchTask: PortalTask = {
    ...task,
    httpMethodExceptions: [
      postException({
        urlPattern: "https://portal.test/api",
        reason: "search",
        justification: "Invoice search form posts its filter before listing results.",
        allowedBodyFields: ["action", "q"],
        credentialBodyFields: [],
      }),
    ],
  };
  const get = (url: string, resourceType: PortalRequest["resourceType"]) =>
    createNetworkGuard({ task }).evaluateRequest({ url, method: "GET", resourceType });
  const post = (postData: string | undefined) =>
    createNetworkGuard({ task: searchTask }).evaluateRequest({
      url: "https://portal.test/api",
      method: "POST",
      resourceType: "xhr",
      postData,
    });

  it("screens every resource type and exempts only static asset paths", () => {
    for (const resourceType of [
      "document",
      "xhr",
      "fetch",
      "other",
      "image",
      "script",
      "stylesheet",
    ] as const) {
      expect(get("https://portal.test/remove-item", resourceType), resourceType).toEqual({
        action: "abort",
        reason: "destructive_url",
      });
      expect(get("https://portal.test/remove-item.css", resourceType), resourceType).toEqual({
        action: "allow",
      });
    }
    // A query string turns an asset-looking path back into an operation.
    expect(get("https://portal.test/remove-item.css?id=1", "stylesheet")).toEqual({
      action: "abort",
      reason: "destructive_url",
    });
  });

  it("matches forbidden operations case-insensitively, through encoded separators, and in the query alone", () => {
    expect(get("https://portal.test/Cancel-Subscription", "document")).toEqual({
      action: "abort",
      reason: "destructive_url",
    });
    expect(get("https://portal.test/cancel%2Dsubscription", "document")).toEqual({
      action: "abort",
      reason: "destructive_url",
    });
    expect(get("https://portal.test/api?op=delete", "other")).toEqual({
      action: "abort",
      reason: "destructive_url",
    });
    expect(get("https://portal.test/api?Op=DELETE", "xhr")).toEqual({
      action: "abort",
      reason: "destructive_url",
    });
    expect(get("https://portal.test/api?op=list", "xhr")).toEqual({ action: "allow" });
  });

  it("recognizes forbidden operations spelled with percent-encoded letters", () => {
    expect(get("https://portal.test/%63ancel-subscription", "document")).toEqual({
      action: "abort",
      reason: "destructive_url",
    });
    expect(get("https://portal.test/api?op=%64elete", "xhr")).toEqual({
      action: "abort",
      reason: "destructive_url",
    });
  });

  it("records a destructive_url block with the normalized method and a redacted path", () => {
    const guard = createNetworkGuard({ task });

    guard.evaluateRequest({
      url: "https://portal.test/orders/12345678/refund?token=t0k3n",
      method: "get",
      resourceType: "fetch",
    });

    expect(guard.snapshot().blockedRequests).toEqual([
      {
        url: "https://portal.test/orders/[REDACTED_SEGMENT]/refund",
        method: "GET",
        resourceType: "fetch",
        reason: "destructive_url",
      },
    ]);
  });

  it("decodes plus-encoded spaces before screening body values", () => {
    expect(post("q=hello+world")).toEqual({ action: "allow" });
    expect(post("q=cancel+order")).toEqual({ action: "abort", reason: "unreviewed_body" });
  });

  it("screens nested JSON values as serialized text and tolerates surrounding whitespace", () => {
    expect(post('{"action":{"op":"delete"}}')).toEqual({
      action: "abort",
      reason: "unreviewed_body",
    });
    expect(post('{"action":["search",{"then":"refund"}]}')).toEqual({
      action: "abort",
      reason: "unreviewed_body",
    });
    expect(post('{"q":2026,"action":true}')).toEqual({ action: "allow" });
    expect(post('  {"action":"search"}  ')).toEqual({ action: "allow" });
  });

  it("treats an empty or whitespace-only body as a body without fields", () => {
    expect(post("")).toEqual({ action: "allow" });
    expect(post("  \n\t ")).toEqual({ action: "allow" });
    expect(post(undefined)).toEqual({ action: "allow" });
  });

  it("refuses JSON bodies that are not objects and bodies it cannot parse", () => {
    expect(post("null")).toEqual({ action: "abort", reason: "unreviewed_body" });
    expect(post("[]")).toEqual({ action: "abort", reason: "unreviewed_body" });
    expect(post('"search"')).toEqual({ action: "abort", reason: "unreviewed_body" });
    expect(post("{not json")).toEqual({ action: "abort", reason: "unreviewed_body" });
  });

  it("refuses multipart bodies even when the only part name is reviewed", () => {
    expect(
      post(
        '------WebKitFormBoundary\r\nContent-Disposition: form-data; name="q"\r\n\r\n2026\r\n------WebKitFormBoundary--',
      ),
    ).toEqual({ action: "abort", reason: "unreviewed_body" });
  });

  it("allows a repeated reviewed key whose values are all safe", () => {
    expect(post("q=2026&q=2025")).toEqual({ action: "allow" });
  });

  it("screens every value of a repeated form key", () => {
    expect(post("action=delete&action=search")).toEqual({
      action: "abort",
      reason: "unreviewed_body",
    });
  });

  it("redacts identifier-like path segments in allowed exception records too", () => {
    const accountTask: PortalTask = {
      ...task,
      httpMethodExceptions: [
        postException({
          urlPattern: "https://portal.test/accounts/12345678/search",
          reason: "search",
          justification: "Account-scoped invoice search posts its filter before listing.",
          allowedBodyFields: ["q"],
          credentialBodyFields: [],
        }),
      ],
    };
    const guard = createNetworkGuard({ task: accountTask });

    const decision = guard.evaluateRequest({
      url: "https://portal.test/accounts/12345678/search",
      method: "post",
      resourceType: "xhr",
      postData: "q=2026",
    });

    expect(decision).toEqual({ action: "allow" });
    expect(guard.snapshot().allowedNonIdempotentRequests).toEqual([
      {
        url: "https://portal.test/accounts/[REDACTED_SEGMENT]/search",
        method: "POST",
        reason: "search",
        justification: "Account-scoped invoice search posts its filter before listing.",
      },
    ]);
    expect(JSON.stringify(guard.snapshot())).not.toContain("12345678");
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

describe("isMaterialBlock", () => {
  const blocked = (
    resourceType: BlockedPortalRequest["resourceType"],
    reason: BlockedPortalRequest["reason"],
  ): BlockedPortalRequest => ({ url: "https://x.test/", method: "GET", resourceType, reason });

  it("treats a refused navigation or download as material even when only off the allowlist", () => {
    expect(isMaterialBlock(blocked("document", "off_allowlist"))).toBe(true);
  });

  it("treats an off-allowlist write as material even though the allowlist check came first", () => {
    expect(isMaterialBlock({ ...blocked("xhr", "off_allowlist"), method: "POST" })).toBe(true);
    expect(isMaterialBlock({ ...blocked("fetch", "off_allowlist"), method: "DELETE" })).toBe(true);
  });

  it("refuses account-closure style operations over GET", () => {
    const guard = createNetworkGuard({ task });
    for (const path of [
      "/account/close",
      "/subscription/terminate",
      "/consent/revoke",
      "/card/deactivate",
    ]) {
      expect(
        guard.evaluateRequest({
          url: `https://portal.test${path}`,
          method: "GET",
          resourceType: "document",
        }),
        path,
      ).toEqual({ action: "abort", reason: "destructive_url" });
    }
  });

  it("treats off-allowlist subresources and refused WebSockets as incidental", () => {
    expect(isMaterialBlock(blocked("image", "off_allowlist"))).toBe(false);
    expect(isMaterialBlock(blocked("font", "off_allowlist"))).toBe(false);
    expect(isMaterialBlock(blocked("xhr", "off_allowlist"))).toBe(false);
    expect(isMaterialBlock(blocked("websocket", "streaming_channel"))).toBe(false);
    expect(isMaterialBlock(blocked("eventsource", "streaming_channel"))).toBe(false);
    expect(isMaterialBlock(blocked("websocket", "off_allowlist"))).toBe(false);
  });

  it("treats every mutation attempt as material whatever the resource type", () => {
    for (const resourceType of ["image", "xhr", "fetch", "script", "other"] as const) {
      for (const reason of [
        "destructive_url",
        "non_idempotent_method",
        "unreviewed_body",
      ] as const) {
        expect(isMaterialBlock(blocked(resourceType, reason)), `${resourceType} ${reason}`).toBe(
          true,
        );
      }
    }
  });
});

describe("NetworkGuard static asset exemption edges", () => {
  const get = (url: string) =>
    createNetworkGuard({ task }).evaluateRequest({ url, method: "GET", resourceType: "other" });

  it("matches asset extensions case-insensitively and ignores the fragment", () => {
    expect(get("https://portal.test/js/remove.JS")).toEqual({ action: "allow" });
    expect(get("https://portal.test/img/remove.svg#top")).toEqual({ action: "allow" });
  });

  it("does not exempt an asset name followed by a query, a directory slash, or an unknown suffix", () => {
    expect(get("https://portal.test/img/remove.svg?v=1")).toEqual({
      action: "abort",
      reason: "destructive_url",
    });
    expect(get("https://portal.test/remove/")).toEqual({
      action: "abort",
      reason: "destructive_url",
    });
    expect(get("https://portal.test/remove.svg.bak")).toEqual({
      action: "abort",
      reason: "destructive_url",
    });
  });
});

describe("NetworkGuard pinned and credential body values", () => {
  const pinnedTask: PortalTask = {
    ...task,
    httpMethodExceptions: [
      postException({
        urlPattern: "https://portal.test/api",
        reason: "login",
        justification: "Multiplexed login endpoint dispatches on the action field.",
        allowedBodyFields: ["action", "email", "password"],
        pinnedBodyValues: { action: ["login"] },
      }),
    ],
  };
  const post = (
    postData: string,
    guardTask: PortalTask = pinnedTask,
    url = "https://portal.test/api",
  ) =>
    createNetworkGuard({ task: guardTask }).evaluateRequest({
      url,
      method: "POST",
      resourceType: "xhr",
      postData,
    });

  it("requires a pinned value to match exactly, including case and whitespace", () => {
    expect(post("action=login")).toEqual({ action: "allow" });
    expect(post("action=Login")).toEqual({ action: "abort", reason: "unreviewed_body" });
    expect(post("action=login%20")).toEqual({ action: "abort", reason: "unreviewed_body" });
    expect(post("action=%20login")).toEqual({ action: "abort", reason: "unreviewed_body" });
  });

  it("refuses a repeated pinned key when any occurrence is off the reviewed list", () => {
    expect(post("action=login&action=login")).toEqual({ action: "allow" });
    expect(post("action=login&action=delete")).toEqual({
      action: "abort",
      reason: "unreviewed_body",
    });
    expect(post("action=delete&action=login")).toEqual({
      action: "abort",
      reason: "unreviewed_body",
    });
  });

  it("never screens a credential value, even one that names a forbidden operation", () => {
    expect(post("action=login&email=a%40b.test&password=cancel-refund-delete")).toEqual({
      action: "allow",
    });
    expect(post("action=login&password=%7B%22op%22%3A%22delete%22%7D")).toEqual({
      action: "allow",
    });
  });

  it("skips a credential field whose JSON value is an object but screens the same value elsewhere", () => {
    const login = "https://portal.test/login";

    expect(post('{"email":"a@b.test","password":{"op":"delete"}}', task, login)).toEqual({
      action: "allow",
    });
    expect(
      post('{"email":"a@b.test","password":"x","action":{"op":"delete"}}', task, login),
    ).toEqual({
      action: "abort",
      reason: "unreviewed_body",
    });
  });
});
