import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createSecretValue, InMemoryDocumentStorage, InMemorySecretStore } from "@sona/core";
import { describe, expect, it } from "vitest";
import {
  InMemoryPortalConnectionRepository,
  InMemoryPortalDocumentRegistry,
  LocalPlaywrightPortalTaskRunner,
} from "./playwright-runner.js";
import type { PortalTask } from "./schema.js";

const runBrowserTests = process.env["SONA_RUN_PLAYWRIGHT_BROWSER_TESTS"] === "1";

describe.skipIf(!runBrowserTests)("LocalPlaywrightPortalTaskRunner browser fixture", () => {
  it("logs in to a local fixture portal and stores invoice PDFs", async () => {
    const server = await startFixtureServer();
    try {
      const task = makeTask(server.origin);
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
            credentialRefs: {
              username: usernameRef,
              password: passwordRef,
            },
          },
        ]),
      });

      const result = await runner.runTask({
        task,
        connectionId: "conn_browser",
        runId: "run_browser",
        workspaceId: context.workspaceId,
        now: "2026-02-01T00:00:00Z",
      });

      expect(result.status).toBe("completed");
      expect(result.documents).toHaveLength(2);
      expect(result.provenance.allowedNonIdempotentRequests?.[0]?.reason).toBe("login");
    } finally {
      await server.close();
    }
  });
});

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
  if (request.url === "/login" && request.method === "GET") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html>
      <form method="post" action="/login">
        <input id="email" name="email">
        <input id="password" name="password" type="password">
        <button class="login" type="submit">Sign in</button>
      </form>`);
    return;
  }
  if (request.url === "/login" && request.method === "POST") {
    response.writeHead(303, { location: "/invoices" });
    response.end();
    return;
  }
  if (request.url === "/invoices" && request.method === "GET") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html>
      <main data-testid="invoice-list">
        <a class="invoice-download" href="/invoices/one.pdf" data-filename="one.pdf">One</a>
        <a class="invoice-download" href="/invoices/two.pdf" data-filename="two.pdf">Two</a>
      </main>`);
    return;
  }
  if (request.url?.startsWith("/invoices/") === true && request.method === "GET") {
    response.writeHead(200, { "content-type": "application/pdf" });
    response.end(`%PDF-1.4 fixture ${request.url}`);
    return;
  }
  response.writeHead(404);
  response.end();
}

function makeTask(origin: string): PortalTask {
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
      },
    ],
    steps: [
      {
        kind: "navigate",
        url: `${origin}/login`,
        sensitive: true,
      },
      {
        kind: "fill",
        selector: "#email",
        credentialKey: "username",
      },
      {
        kind: "fill",
        selector: "#password",
        credentialKey: "password",
        sensitive: true,
      },
      {
        kind: "click",
        selector: "button.login",
      },
      {
        kind: "waitForSelector",
        selector: "[data-testid='invoice-list']",
      },
      {
        kind: "downloadLinks",
        selector: "a.invoice-download",
        hrefAttribute: "href",
        filenameAttribute: "data-filename",
        mimeType: "application/pdf",
      },
    ],
  };
}
