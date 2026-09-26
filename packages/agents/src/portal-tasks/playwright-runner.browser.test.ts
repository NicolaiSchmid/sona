import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createSecretValue, InMemoryDocumentStorage, InMemorySecretStore } from "@sona/core";
import { describe, expect, it } from "vitest";
import {
  InMemoryPortalConnectionRepository,
  InMemoryPortalDocumentRegistry,
  InMemoryPortalEvidenceRepository,
  LocalPlaywrightPortalTaskRunner,
} from "./playwright-runner.js";
import type { RunPortalTaskResult } from "./runner.js";
import { type PortalTask, type PortalTaskStep, portalTaskDigest } from "./schema.js";

/**
 * Drives the real Playwright adapter against a local fixture portal. Opt-in via
 * SONA_RUN_PLAYWRIGHT_BROWSER_TESTS=1 because it needs an installed Chromium;
 * CI runs it in a dedicated job.
 */
const runBrowserTests = process.env["SONA_RUN_PLAYWRIGHT_BROWSER_TESTS"] === "1";

const SESSION_COOKIE = "sona_fixture_session=logged-in";
const OVERSIZED_LIMIT_BYTES = 64 * 1024;

describe.skipIf(!runBrowserTests)("LocalPlaywrightPortalTaskRunner browser fixture", () => {
  it("logs in, carries the session cookie into downloads, and stores invoice PDFs", async () => {
    const result = await runFixture((origin) => makeTask(origin));

    expect(result.errors).toEqual([]);
    expect(result.status).toBe("completed");
    expect(result.documents).toHaveLength(2);
    expect(result.documents.map((document) => document.filename)).toEqual(["one.pdf", "two.pdf"]);
    expect(result.provenance.allowedNonIdempotentRequests?.[0]?.reason).toBe("login");
    expect(result.provenance.blockedRequests).toEqual([]);
  });

  it("refuses WebSockets and off-allowlist subresources but completes the run", {
    timeout: 15_000,
  }, async () => {
    const result = await runFixture((origin) =>
      makeTask(origin, [
        { kind: "navigate", url: `${origin}/login` },
        { kind: "click", selector: "button.login" },
        { kind: "waitForSelector", selector: "[data-testid='invoice-list']" },
        { kind: "click", selector: "button.open-live" },
        { kind: "waitForSelector", selector: "[data-testid='live-closed']", timeoutMs: 5_000 },
      ]),
    );

    expect(result.status).toBe("completed");
    expect(result.provenance.blockedRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resourceType: "websocket", reason: "websocket" }),
        expect.objectContaining({
          url: "https://tracking.example/pixel.gif",
          reason: "off_allowlist",
        }),
      ]),
    );
    expect(result.warnings).toContain("2 incidental request(s) blocked; see provenance");
  });

  it("drops the body and content headers when an XHR POST is redirected to a GET", async () => {
    const { result, hits, headersSeen } = await runFixtureWithServer((origin) =>
      makeTask(origin, [
        { kind: "navigate", url: `${origin}/xhr-login` },
        { kind: "waitForSelector", selector: "[data-testid='xhr-done']", timeoutMs: 5_000 },
      ]),
    );

    expect(result.status).toBe("completed");
    expect(hits.get("POST /api/login")).toBe(1);
    expect(hits.get("GET /api/after")).toBe(1);
    const after = headersSeen.get("GET /api/after");
    expect(after?.["content-type"]).not.toBe("application/x-www-form-urlencoded");
    expect(["0", undefined]).toContain(after?.["content-length"]);
    expect(after?.["cookie"]).toBeUndefined();
    expect(result.provenance.allowedNonIdempotentRequests).toEqual([
      expect.objectContaining({ url: expect.stringMatching(/\/api\/login$/), reason: "search" }),
    ]);
  });

  it("aborts a method-preserving redirect onto an unreviewed endpoint before it is sent", async () => {
    const { result, hits } = await runFixtureWithServer((origin) =>
      makeTask(origin, [
        { kind: "navigate", url: `${origin}/login` },
        { kind: "click", selector: "button.login-redirect" },
        { kind: "waitForSelector", selector: "[data-testid='invoice-list']", timeoutMs: 2_000 },
      ]),
    );

    expect(result.status).toBe("blocked");
    expect(result.provenance.blockedRequests).toEqual([
      expect.objectContaining({
        url: expect.stringMatching(/\/account\/close$/),
        method: "POST",
        reason: "non_idempotent_method",
      }),
    ]);
    expect(result.provenance.allowedNonIdempotentRequests).toHaveLength(1);
    expect(hits.get("POST /login-redirect")).toBe(1);
    expect(hits.has("POST /account/close")).toBe(false);
  });

  it("follows a method-preserving redirect onto a reviewed endpoint in place with the body intact", async () => {
    let origin = "";
    const { result, hits, headersSeen, bodiesSeen } = await runFixtureWithServer((serverOrigin) => {
      origin = serverOrigin;
      return makeTask(origin, [
        { kind: "navigate", url: `${origin}/login` },
        { kind: "click", selector: "button.login-307" },
        { kind: "waitForSelector", selector: "[data-testid='invoice-list']", timeoutMs: 5_000 },
        {
          kind: "downloadLinks",
          selector: "a.invoice-download",
          hrefAttribute: "href",
          filenameAttribute: "data-filename",
          mimeType: "application/pdf",
        },
      ]);
    });

    expect(result.errors).toEqual([]);
    expect(result.status).toBe("completed");
    expect(hits.get("POST /login-307")).toBe(1);
    expect(hits.get("POST /login-hop")).toBe(1);
    expect(headersSeen.get("POST /login-hop")?.["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(bodiesSeen.get("POST /login-hop")).toBe(
      "email=fixture-user%40example.test&password=fixture-password",
    );
    expect(result.provenance.allowedNonIdempotentRequests.map((entry) => entry.url)).toEqual([
      `${origin}/login-307`,
      `${origin}/login-hop`,
    ]);
    expect(result.provenance.blockedRequests).toEqual([]);
    // The session cookie set by the in-place hop reached the context jar.
    expect(result.documents).toHaveLength(2);
  });

  it("aborts an off-allowlist redirect hop without contacting the target", async () => {
    const { result, hits } = await runFixtureWithServer((origin) =>
      makeTask(origin, [
        { kind: "navigate", url: `${origin}/login` },
        { kind: "navigate", url: `${origin}/redirect-out` },
      ]),
    );

    expect(result.status).toBe("blocked");
    expect(result.provenance.blockedRequests).toEqual([
      expect.objectContaining({ url: "https://evil.example/x", reason: "off_allowlist" }),
    ]);
    expect(hits.get("GET /redirect-out")).toBe(1);
  });

  it("follows an allowlisted same-host GET redirect chain as routed navigations", async () => {
    const { result, hits } = await runFixtureWithServer((origin) =>
      makeTask(origin, [
        ...loginSteps(origin),
        { kind: "navigate", url: `${origin}/start` },
        { kind: "waitForSelector", selector: "[data-testid='invoice-list']", timeoutMs: 5_000 },
        {
          kind: "downloadLinks",
          selector: "a.invoice-download",
          hrefAttribute: "href",
          filenameAttribute: "data-filename",
          mimeType: "application/pdf",
        },
      ]),
    );

    expect(result.errors).toEqual([]);
    expect(result.status).toBe("completed");
    expect(result.documents).toHaveLength(2);
    expect(result.provenance.blockedRequests).toEqual([]);
    expect(hits.get("GET /start")).toBe(1);
    expect(hits.get("GET /hop")).toBe(1);
    expect(hits.get("GET /invoices")).toBe(2);
  });

  it("aborts a subresource redirect onto an off-allowlist host at the hop", async () => {
    const { result, hits } = await runFixtureWithServer((origin) =>
      makeTask(origin, [
        { kind: "navigate", url: `${origin}/gallery` },
        { kind: "waitForSelector", selector: "[data-testid='gallery']", timeoutMs: 5_000 },
      ]),
    );

    expect(result.status).toBe("completed");
    expect(result.provenance.blockedRequests).toEqual([
      expect.objectContaining({
        url: "https://tracking.example/pixel2.gif",
        resourceType: "image",
        reason: "off_allowlist",
      }),
    ]);
    expect(hits.get("GET /img-redirect")).toBe(1);
  });

  it("follows a download redirect onto an allowlisted path and stores the final document", async () => {
    let origin = "";
    const { result, hits } = await runFixtureWithServer((serverOrigin) => {
      origin = serverOrigin;
      return makeTask(origin, [
        ...loginSteps(origin),
        {
          kind: "downloadLinks",
          selector: "a.redirected-download",
          hrefAttribute: "href",
          filenameAttribute: "data-filename",
          mimeType: "application/pdf",
        },
      ]);
    });

    expect(result.errors).toEqual([]);
    expect(result.status).toBe("completed");
    expect(result.documents.map((document) => [document.filename, document.sourceUrl])).toEqual([
      ["three.pdf", `${origin}/invoices/three.pdf`],
    ]);
    expect(result.storedDocuments).toHaveLength(1);
    expect(hits.get("GET /dl/redirect-in")).toBe(1);
    expect(hits.get("GET /invoices/three.pdf")).toBe(1);
  });

  it("refuses a download redirect that leaves the allowlist without storing anything", async () => {
    const { result, hits } = await runFixtureWithServer((origin) =>
      makeTask(origin, [
        ...loginSteps(origin),
        {
          kind: "downloadLinks",
          selector: "a.leaking-download",
          hrefAttribute: "href",
          filenameAttribute: "data-filename",
          mimeType: "application/pdf",
        },
      ]),
    );

    expect(result.status).toBe("blocked");
    expect(result.errors).toEqual(["download redirect blocked by portal network policy"]);
    expect(result.storedDocuments).toEqual([]);
    expect(result.documents).toEqual([]);
    expect(result.provenance.blockedRequests).toEqual([
      expect.objectContaining({ url: "https://evil.example/leak.pdf", reason: "off_allowlist" }),
    ]);
    expect(hits.get("GET /dl/redirect-out")).toBe(1);
  });

  it("stops reading an oversized chunked download at the byte cap", async () => {
    const result = await runFixture(
      (origin) =>
        makeTask(origin, [
          { kind: "navigate", url: `${origin}/login` },
          { kind: "click", selector: "button.login" },
          { kind: "waitForSelector", selector: "[data-testid='invoice-list']" },
          {
            kind: "downloadLinks",
            selector: "a.oversized-download",
            hrefAttribute: "href",
            mimeType: "application/pdf",
          },
        ]),
      { maxDownloadBytes: OVERSIZED_LIMIT_BYTES },
    );

    expect(result.status).toBe("failed");
    expect(result.errors.join(" ")).toContain(`exceeds ${OVERSIZED_LIMIT_BYTES} byte limit`);
    expect(result.storedDocuments).toEqual([]);
  });
});

interface RunFixtureOptions {
  maxDownloadBytes?: number;
}

/** Signs in with the fixture form so later downloads carry the session cookie. */
function loginSteps(origin: string): PortalTaskStep[] {
  return [
    { kind: "navigate", url: `${origin}/login` },
    { kind: "click", selector: "button.login" },
    { kind: "waitForSelector", selector: "[data-testid='invoice-list']", timeoutMs: 5_000 },
  ];
}

async function runFixture(
  taskFor: (origin: string) => PortalTask,
  options: RunFixtureOptions = {},
): Promise<RunPortalTaskResult> {
  return (await runFixtureWithServer(taskFor, options)).result;
}

interface FixtureRun {
  result: RunPortalTaskResult;
  /** `METHOD /path` request counts the fixture server actually received. */
  hits: ReadonlyMap<string, number>;
  /** Selected request headers of the last request per `METHOD /path`. */
  headersSeen: ReadonlyMap<string, Record<string, string | undefined>>;
  /** Raw body of the last non-empty request per `METHOD /path`. */
  bodiesSeen: ReadonlyMap<string, string>;
}

async function runFixtureWithServer(
  taskFor: (origin: string) => PortalTask,
  options: RunFixtureOptions = {},
): Promise<FixtureRun> {
  const server = await startFixtureServer();
  try {
    const task = taskFor(server.origin);
    const context = { workspaceId: "ws_browser" };
    const secretStore = new InMemorySecretStore();
    const usernameRef = await secretStore.putSecret({
      context,
      label: "Fixture username",
      value: createSecretValue("fixture-user@example.test"),
    });
    const passwordRef = await secretStore.putSecret({
      context,
      label: "Fixture password",
      value: createSecretValue("fixture-password"),
    });
    const runner = new LocalPlaywrightPortalTaskRunner({
      documentStorage: new InMemoryDocumentStorage(),
      documentRegistry: new InMemoryPortalDocumentRegistry(),
      evidence: new InMemoryPortalEvidenceRepository(),
      secretStore,
      connections: new InMemoryPortalConnectionRepository([
        {
          id: "conn_browser",
          workspaceId: context.workspaceId,
          taskId: task.id,
          taskDigest: portalTaskDigest(task),
          approvedBrowserProvider: "local-playwright",
          credentialRefs: { username: usernameRef, password: passwordRef },
        },
      ]),
      ...(options.maxDownloadBytes === undefined
        ? {}
        : { maxDownloadBytes: options.maxDownloadBytes }),
    });

    const result = await runner.runTask({
      task,
      connectionId: "conn_browser",
      runId: "run_browser",
      workspaceId: context.workspaceId,
      now: "2026-02-01T00:00:00Z",
    });
    return {
      result,
      hits: server.hits,
      headersSeen: server.headersSeen,
      bodiesSeen: server.bodiesSeen,
    };
  } finally {
    await server.close();
  }
}

interface FixtureServer {
  origin: string;
  hits: ReadonlyMap<string, number>;
  headersSeen: ReadonlyMap<string, Record<string, string | undefined>>;
  bodiesSeen: ReadonlyMap<string, string>;
  close(): Promise<void>;
}

async function startFixtureServer(): Promise<FixtureServer> {
  const hits = new Map<string, number>();
  const headersSeen = new Map<string, Record<string, string | undefined>>();
  const bodiesSeen = new Map<string, string>();
  const server = createServer((request, response) => {
    const key = `${request.method} ${new URL(request.url ?? "/", "http://localhost").pathname}`;
    hits.set(key, (hits.get(key) ?? 0) + 1);
    headersSeen.set(key, {
      "content-type": headerValue(request.headers["content-type"]),
      "content-length": headerValue(request.headers["content-length"]),
      cookie: headerValue(request.headers.cookie),
    });
    void readRequestBody(request).then((body) => {
      if (body.length > 0) {
        bodiesSeen.set(key, body);
      }
      handleFixtureRequest(request, response, body);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fixture server did not bind to a TCP port");
  }
  return {
    origin: `http://localhost:${address.port}`,
    hits,
    headersSeen,
    bodiesSeen,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(", ") : value;
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function handleFixtureRequest(
  request: IncomingMessage,
  response: ServerResponse,
  body: string,
): void {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/xhr-login" && request.method === "GET") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><main id="xhr">pending</main>
      <script>
        fetch("/api/login", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "q=hello",
        }).then(() => {
          const marker = document.createElement("div");
          marker.dataset.testid = "xhr-done";
          marker.textContent = "xhr done";
          document.body.append(marker);
        });
      </script>`);
    return;
  }
  if (url.pathname === "/api/login" && request.method === "POST") {
    response.writeHead(303, { location: "/api/after" });
    response.end();
    return;
  }
  if (url.pathname === "/api/after" && request.method === "GET") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
    return;
  }
  if (url.pathname === "/login" && request.method === "GET") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html>
      <form method="post" action="/login">
        <input id="email" name="email">
        <input id="password" name="password" type="password">
        <button class="login" type="submit">Sign in</button>
      </form>
      <form method="post" action="/login-redirect">
        <input name="email" value="fixture-user@example.test">
        <input name="password" value="fixture-password">
        <button class="login-redirect" type="submit">Sign in (redirecting)</button>
      </form>
      <form method="post" action="/login-307">
        <input name="email" value="fixture-user@example.test">
        <input name="password" value="fixture-password">
        <button class="login-307" type="submit">Sign in (307 to reviewed hop)</button>
      </form>`);
    return;
  }
  if (url.pathname === "/login-307" && request.method === "POST") {
    // A method-preserving redirect onto a second reviewed login endpoint.
    response.writeHead(307, { location: "/login-hop" });
    response.end();
    return;
  }
  if (url.pathname === "/login-hop" && request.method === "POST") {
    const fields = new URLSearchParams(body);
    if (fields.get("email") === null || fields.get("password") === null) {
      response.writeHead(400, { "content-type": "text/plain" });
      response.end("login hop received no credentials");
      return;
    }
    response.writeHead(303, { location: "/invoices", "set-cookie": `${SESSION_COOKIE}; Path=/` });
    response.end();
    return;
  }
  if (url.pathname === "/redirect-out" && request.method === "GET") {
    response.writeHead(302, { location: "https://evil.example/x" });
    response.end();
    return;
  }
  if (url.pathname === "/start" && request.method === "GET") {
    response.writeHead(302, { location: "/hop" });
    response.end();
    return;
  }
  if (url.pathname === "/hop" && request.method === "GET") {
    response.writeHead(302, { location: "/invoices" });
    response.end();
    return;
  }
  if (url.pathname === "/gallery" && request.method === "GET") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><main data-testid="gallery"><img src="/img-redirect"></main>`);
    return;
  }
  if (url.pathname === "/img-redirect" && request.method === "GET") {
    response.writeHead(302, { location: "https://tracking.example/pixel2.gif" });
    response.end();
    return;
  }
  if (url.pathname === "/dl/redirect-in" && request.method === "GET") {
    response.writeHead(302, { location: "/invoices/three.pdf" });
    response.end();
    return;
  }
  if (url.pathname === "/dl/redirect-out" && request.method === "GET") {
    response.writeHead(302, { location: "https://evil.example/leak.pdf" });
    response.end();
    return;
  }
  if (url.pathname === "/login-redirect" && request.method === "POST") {
    // A method-preserving redirect the guard can only observe, not abort.
    response.writeHead(307, { location: "/account/close" });
    response.end();
    return;
  }
  if (url.pathname === "/account/close") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><main data-testid="closed">closed via ${request.method}</main>`);
    return;
  }
  if (url.pathname === "/login" && request.method === "POST") {
    response.writeHead(303, { location: "/invoices", "set-cookie": `${SESSION_COOKIE}; Path=/` });
    response.end();
    return;
  }
  if (url.pathname === "/invoices" && request.method === "GET") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html>
      <main data-testid="invoice-list">
        <a class="invoice-download" href="/invoices/one.pdf" data-filename="one.pdf">One</a>
        <a class="invoice-download" href="/invoices/two.pdf" data-filename="two.pdf">Two</a>
        <a class="oversized-download" href="/oversized.pdf">Oversized</a>
        <a class="redirected-download" href="/dl/redirect-in" data-filename="three.pdf">Three</a>
        <a class="leaking-download" href="/dl/redirect-out" data-filename="leak.pdf">Leak</a>
        <button class="open-live" type="button">Live</button>
        <script>
          document.querySelector("button.open-live").addEventListener("click", () => {
            const socket = new WebSocket("ws://" + location.host + "/live");
            const done = () => {
              const marker = document.createElement("div");
              marker.dataset.testid = "live-closed";
              marker.textContent = "live channel closed";
              document.body.append(marker);
            };
            socket.addEventListener("close", done);
            socket.addEventListener("error", done);
            new Image().src = "https://tracking.example/pixel.gif";
          });
        </script>
      </main>`);
    return;
  }
  if (url.pathname.startsWith("/invoices/") && request.method === "GET") {
    if (request.headers.cookie?.includes(SESSION_COOKIE) !== true) {
      response.writeHead(401, { "content-type": "text/html" });
      response.end("<html>session expired</html>");
      return;
    }
    response.writeHead(200, { "content-type": "application/pdf" });
    response.end(`%PDF-1.4 fixture ${url.pathname}`);
    return;
  }
  if (url.pathname === "/oversized.pdf" && request.method === "GET") {
    // Chunked (no Content-Length) so only the streaming cap can stop it.
    response.writeHead(200, { "content-type": "application/pdf" });
    const chunk = Buffer.alloc(16 * 1024, 0x41);
    let remaining = 8;
    const write = () => {
      if (remaining === 0 || response.destroyed) {
        response.end();
        return;
      }
      remaining -= 1;
      if (response.write(chunk)) {
        setImmediate(write);
      } else {
        response.once("drain", write);
      }
    };
    write();
    return;
  }
  response.writeHead(404);
  response.end();
}

function makeTask(origin: string, steps?: readonly PortalTaskStep[]): PortalTask {
  return {
    id: "local-fixture-portal",
    name: "Local fixture portal invoice fetcher",
    version: 1,
    risk: "read_only_document_fetch",
    domains: ["localhost"],
    requires: ["credentials"],
    allowedActions: ["navigate", "login", "download_invoice_pdf"],
    forbiddenActions: ["purchase", "cancel_order"],
    outputs: ["document_file", "provenance_json"],
    httpMethodExceptions: [
      {
        method: "POST",
        urlPattern: `${origin}/login`,
        reason: "login",
        justification: "Fixture login form requires POST before read-only invoice access.",
        allowedBodyFields: ["email", "password"],
        credentialBodyFields: ["email", "password"],
        pinnedBodyValues: {},
      },
      {
        method: "POST",
        urlPattern: `${origin}/api/login`,
        reason: "search",
        justification: "Fixture XHR search endpoint answers with a redirect to a GET resource.",
        allowedBodyFields: ["q"],
        credentialBodyFields: [],
        pinnedBodyValues: {},
      },
      {
        method: "POST",
        urlPattern: `${origin}/login-redirect`,
        reason: "login",
        justification: "Fixture variant whose login endpoint redirects with the method preserved.",
        allowedBodyFields: ["email", "password"],
        credentialBodyFields: ["email", "password"],
        pinnedBodyValues: {},
      },
      {
        method: "POST",
        urlPattern: `${origin}/login-307`,
        reason: "login",
        justification: "Fixture login endpoint that 307-redirects onto the reviewed login hop.",
        allowedBodyFields: ["email", "password"],
        credentialBodyFields: ["email", "password"],
        pinnedBodyValues: {},
      },
      {
        method: "POST",
        urlPattern: `${origin}/login-hop`,
        reason: "login",
        justification: "Second hop of the fixture 307 login chain; same reviewed form fields.",
        allowedBodyFields: ["email", "password"],
        credentialBodyFields: ["email", "password"],
        pinnedBodyValues: {},
      },
    ],
    steps: [
      ...(steps ?? [
        { kind: "navigate", url: `${origin}/login`, sensitive: true },
        { kind: "fill", selector: "#email", credentialKey: "username" },
        { kind: "fill", selector: "#password", credentialKey: "password", sensitive: true },
        { kind: "click", selector: "button.login" },
        { kind: "waitForSelector", selector: "[data-testid='invoice-list']" },
        {
          kind: "downloadLinks",
          selector: "a.invoice-download",
          hrefAttribute: "href",
          filenameAttribute: "data-filename",
          mimeType: "application/pdf",
        },
      ]),
    ],
  };
}
