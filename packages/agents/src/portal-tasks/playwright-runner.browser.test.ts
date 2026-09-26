import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createSecretValue, InMemoryDocumentStorage, InMemorySecretStore } from "@sona/core";
import { describe, expect, it } from "vitest";
import {
  InMemoryPortalConnectionRepository,
  InMemoryPortalDocumentRegistry,
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

  it("refuses WebSockets and off-allowlist subresources opened by the portal page", {
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

    expect(result.status).toBe("blocked");
    expect(result.provenance.blockedRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resourceType: "websocket", reason: "websocket" }),
        expect.objectContaining({
          url: "https://tracking.example/pixel.gif",
          reason: "off_allowlist",
        }),
      ]),
    );
  });

  it("records a navigation redirect that leaves the allowlist and stops the run as blocked", async () => {
    const result = await runFixture((origin) =>
      makeTask(origin, [
        { kind: "navigate", url: `${origin}/login` },
        { kind: "navigate", url: `${origin}/redirect-out` },
        { kind: "waitForSelector", selector: "[data-testid='invoice-list']", timeoutMs: 2_000 },
      ]),
    );

    expect(result.status).toBe("blocked");
    expect(result.provenance.blockedRequests).toEqual([
      expect.objectContaining({ url: "https://evil.example/x", reason: "off_allowlist" }),
    ]);
  });

  it("records a method-preserving redirect onto an unreviewed endpoint and fails closed", async () => {
    const result = await runFixture((origin) =>
      makeTask(origin, [
        { kind: "navigate", url: `${origin}/login` },
        { kind: "click", selector: "button.login-redirect" },
        { kind: "waitForSelector", selector: "[data-testid='invoice-list']", timeoutMs: 2_000 },
      ]),
    );

    expect(result.status).toBe("blocked");
    expect(result.provenance.blockedRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: expect.stringMatching(/\/account\/close$/),
          method: "POST",
          reason: "non_idempotent_method",
        }),
      ]),
    );
    // Once a hop escaped, even allowlisted follow-up requests are aborted.
    expect(result.provenance.allowedNonIdempotentRequests).toHaveLength(1);
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

async function runFixture(
  taskFor: (origin: string) => PortalTask,
  options: RunFixtureOptions = {},
): Promise<RunPortalTaskResult> {
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
      secretStore,
      connections: new InMemoryPortalConnectionRepository([
        {
          id: "conn_browser",
          workspaceId: context.workspaceId,
          taskId: task.id,
          taskDigest: portalTaskDigest(task),
          credentialRefs: { username: usernameRef, password: passwordRef },
        },
      ]),
      ...(options.maxDownloadBytes === undefined
        ? {}
        : { maxDownloadBytes: options.maxDownloadBytes }),
    });

    return await runner.runTask({
      task,
      connectionId: "conn_browser",
      runId: "run_browser",
      workspaceId: context.workspaceId,
      now: "2026-02-01T00:00:00Z",
    });
  } finally {
    await server.close();
  }
}

interface FixtureServer {
  origin: string;
  close(): Promise<void>;
}

async function startFixtureServer(): Promise<FixtureServer> {
  const server = createServer(handleFixtureRequest);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fixture server did not bind to a TCP port");
  }
  return {
    origin: `http://localhost:${address.port}`,
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

function handleFixtureRequest(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? "/", "http://localhost");
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
      </form>`);
    return;
  }
  if (url.pathname === "/redirect-out" && request.method === "GET") {
    response.writeHead(302, { location: "https://evil.example/x" });
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
      },
      {
        method: "POST",
        urlPattern: `${origin}/login-redirect`,
        reason: "login",
        justification: "Fixture variant whose login endpoint redirects with the method preserved.",
        allowedBodyFields: ["email", "password"],
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
