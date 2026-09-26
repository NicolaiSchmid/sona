import {
  createSecretValue,
  type GetSecretInput,
  InMemoryDocumentStorage,
  InMemorySecretStore,
  type SecretValue,
} from "@sona/core";
import { describe, expect, it } from "vitest";
import type {
  PortalBrowserPage,
  PortalBrowserProvider,
  PortalBrowserSession,
  PortalDownloadRequestOptions,
  PortalDownloadResponse,
  PortalElementHandle,
  PortalRequestGuard,
} from "./browser.js";
import { syntheticReferencePortalTask } from "./definitions/synthetic-reference-portal.js";
import type { PortalRequest } from "./network-guard.js";
import { createCdpPlaywrightBrowserProvider } from "./playwright-adapter.js";
import {
  type GetPortalConnectionInput,
  InMemoryPortalConnectionRepository,
  InMemoryPortalDocumentRegistry,
  InMemoryPortalEvidenceRepository,
  LocalPlaywrightPortalTaskRunner,
  type PortalConnection,
  type PortalConnectionRepository,
  type SavePortalEvidenceInput,
} from "./playwright-runner.js";
import { STORED_DOCUMENT_URI_SCHEME } from "./provenance.js";
import type { RunPortalTaskInput } from "./runner.js";
import { type PortalTask, parsePortalTask, portalTaskDigest } from "./schema.js";

const now = "2026-02-01T00:00:00Z";
const context = { workspaceId: "ws_1", userId: "user_1" };

const task: PortalTask = parsePortalTask(syntheticReferencePortalTask);

function input(overrides: Partial<RunPortalTaskInput> = {}): RunPortalTaskInput {
  return {
    task,
    connectionId: "conn_1",
    runId: "run_1",
    workspaceId: context.workspaceId,
    now,
    ...overrides,
  };
}

describe("LocalPlaywrightPortalTaskRunner", () => {
  it("stores fixture portal PDFs with run provenance and dedups repeat downloads", async () => {
    const storage = new CountingDocumentStorage();
    const registry = new InMemoryPortalDocumentRegistry();
    const evidence = new InMemoryPortalEvidenceRepository();
    const runner = await makeRunner({
      storage,
      registry,
      evidence,
      page: new FixturePortalPage(),
    });

    const first = await runner.runTask(input());
    const second = await runner.runTask(input({ runId: "run_2" }));

    const records = evidence.listDocuments(context);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      workspaceId: "ws_1",
      sourceKind: "portal",
      contentHash: first.documents[0]?.contentHash,
      storageUri: `stored-document:${first.storedDocuments[0]?.id}`,
      retentionState: "active",
    });
    expect(records[0]?.sourceMetadata).toMatchObject({
      runId: "run_1",
      browserProvider: "local-playwright",
    });
    expect(evidence.listDocuments({ workspaceId: "ws_other" })).toEqual([]);

    expect(first.status).toBe("completed");
    expect(first.documents).toHaveLength(2);
    expect(first.documents[0]?.content.kind).toBe("objectRef");
    expect(first.storedDocuments).toHaveLength(2);
    expect(first.storedDocuments[0]?.metadata["portal.runId"]).toBe("run_1");
    expect(first.storedDocuments[0]?.metadata["portal.taskId"]).toBe("synthetic-reference-portal");
    expect(second.status).toBe("completed");
    expect(second.documents).toEqual([]);
    expect(second.storedDocuments).toEqual([]);
    expect(storage.putCount).toBe(2);
  });

  it("redacts injected credentials from errors, provenance, and stored metadata", async () => {
    const secretMarker = "S3CRET-MARKER-14";
    const storage = new CountingDocumentStorage();
    const page = new FixturePortalPage({
      download: (url) => {
        throw new Error(`portal rejected ${url} for ${secretMarker}`);
      },
    });
    const runner = await makeRunner({
      storage,
      page,
      password: secretMarker,
    });

    const result = await runner.runTask(input());
    const serialized = JSON.stringify({ result, stored: storage.serializedDocuments() });

    expect(result.status).toBe("failed");
    expect(result.errors.join(" ")).toContain("[REDACTED_SECRET]");
    expect(serialized).not.toContain(secretMarker);
    expect(page.screenshotCount).toBe(0);
  });

  it("redacts the browser provider's own sensitive values from setup failures", async () => {
    const endpoint = "wss://connect.browserbase.test?apiKey=bb_live_1234567890";
    const provider = createCdpPlaywrightBrowserProvider("browserbase", endpoint);
    const runner = await makeRunner({
      page: new FixturePortalPage(),
      providerFailure: new Error(`connect failed: ${endpoint} (key bb_live_1234567890)`),
      providerSensitiveValues: provider.sensitiveValues,
    });

    const result = await runner.runTask(input());

    expect(provider.sensitiveValues).toEqual(
      expect.arrayContaining([endpoint, "bb_live_1234567890"]),
    );
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("bb_live_1234567890");
    expect(JSON.stringify(result)).not.toContain("connect.browserbase.test");
  });

  it("returns policy_refused for a malformed task instead of throwing", async () => {
    const runner = await makeRunner({ page: new FixturePortalPage() });
    const malformed = { id: "broken", version: 1 } as unknown as PortalTask;

    const result = await runner.runTask(input({ task: malformed }));

    expect(result.status).toBe("policy_refused");
    expect(result.taskId).toBe("broken");
    expect(result.provenance.portalDomain).toBe("unknown");
    expect(result.errors[0]).toContain("failed validation");
  });

  it("reports a route-aborted navigation as blocked rather than failed", async () => {
    const page = new FixturePortalPage({ abortBlockedRequests: true });
    const offAllowlist: PortalTask = {
      ...task,
      steps: [{ kind: "navigate", url: "https://portal.test/login" }],
      domains: ["other.test"],
    };
    const runner = await makeRunner({ page, connectionTask: offAllowlist });

    const result = await runner.runTask(input({ task: offAllowlist }));

    expect(result.status).toBe("blocked");
    expect(result.provenance.blockedRequests).toHaveLength(1);
    expect(result.errors.join(" ")).toContain("blocked request");
  });

  it("returns selector_missing when download matches carry no usable link", async () => {
    const page = new FixturePortalPage({ hrefAttribute: "data-missing" });
    const buttonLinks: PortalTask = {
      ...task,
      steps: task.steps.map((step) =>
        step.kind === "downloadLinks" ? { ...step, hrefAttribute: "data-missing" } : step,
      ),
    };
    const runner = await makeRunner({ page, connectionTask: buttonLinks });

    const result = await runner.runTask(input({ task: buttonLinks }));

    expect(result.status).toBe("selector_missing");
    expect(result.errors.join(" ")).toContain('no usable "data-missing"');
    expect(result.storedDocuments).toEqual([]);
  });

  it("returns selector_missing after a single missing-selector wait", async () => {
    const page = new FixturePortalPage({
      missingSelectors: new Set(["[data-testid='invoice-list']"]),
    });
    const runner = await makeRunner({ page });

    const result = await runner.runTask(input());

    expect(result.status).toBe("selector_missing");
    expect(result.documents).toEqual([]);
    expect(page.waitCounts.get("[data-testid='invoice-list']")).toBe(1);
  });

  it("converts selector timeout errors to selector_missing", async () => {
    const page = new FixturePortalPage({
      waitTimeoutSelectors: new Set(["[data-testid='invoice-list']"]),
    });
    const runner = await makeRunner({ page });

    const result = await runner.runTask(input());

    expect(result.status).toBe("selector_missing");
    expect(result.errors).toContain("selector_missing: [data-testid='invoice-list']");
  });

  it("re-checks the read-only policy at execution time", async () => {
    const runner = await makeRunner({ page: new FixturePortalPage() });
    const unsafe: PortalTask = {
      ...task,
      allowedActions: ["navigate", "cancel_order"],
    };

    const result = await runner.runTask(input({ task: unsafe }));

    expect(result.status).toBe("policy_refused");
    expect(result.errors.join(" ")).toContain("cancel");
  });

  it("executes the parsed task so schema defaults are applied", async () => {
    const rawTask = {
      ...task,
      steps: task.steps.map((step) =>
        step.kind === "downloadLinks"
          ? { kind: "downloadLinks", selector: step.selector, filenameAttribute: "data-filename" }
          : step,
      ),
    } as unknown as PortalTask;
    const runner = await makeRunner({ page: new FixturePortalPage() });

    const result = await runner.runTask(input({ task: rawTask }));

    expect(result.status).toBe("completed");
    expect(result.documents).toHaveLength(2);
    expect(result.documents[0]?.mimeType).toBe("application/pdf");
  });

  it("refuses a task that defines no executable steps instead of reporting an empty success", async () => {
    const provider = new FixtureBrowserProvider({ page: new FixturePortalPage() });
    const runner = await makeRunner({ page: new FixturePortalPage(), provider });

    const result = await runner.runTask(input({ task: { ...task, steps: [] } }));

    expect(result.status).toBe("policy_refused");
    expect(result.errors).toEqual(["refused: portal task defines no executable steps"]);
    expect(provider.sessionCount).toBe(0);
  });

  it("refuses to fill credentials into a task revision the connection was not approved for", async () => {
    const secretStore = new CountingSecretStore();
    const provider = new FixtureBrowserProvider({ page: new FixturePortalPage() });
    const runner = await makeRunner({ page: new FixturePortalPage(), provider, secretStore });
    const retargeted: PortalTask = { ...task, domains: ["attacker.test"] };

    const result = await runner.runTask(input({ task: retargeted }));

    expect(result.status).toBe("policy_refused");
    expect(result.errors[0]).toContain("reviewed task revision");
    expect(secretStore.getCount).toBe(0);
    expect(provider.sessionCount).toBe(0);
  });

  it("reports a fill target that never appears as selector_missing", async () => {
    const page = new FixturePortalPage({ missingSelectors: new Set(["#email"]) });
    const runner = await makeRunner({ page });

    const result = await runner.runTask(input());

    expect(result.status).toBe("selector_missing");
    expect(result.errors).toEqual(["selector_missing: #email"]);
    expect(page.waitCounts.get("#email")).toBe(1);
    expect(page.waitCounts.has("[data-testid='invoice-list']")).toBe(false);
  });

  it("keeps an action that times out on a present element as a retryable failure", async () => {
    const page = new FixturePortalPage({ timeoutSelectors: new Set(["#email"]) });
    const runner = await makeRunner({ page });

    const result = await runner.runTask(input());

    expect(result.status).toBe("failed");
    expect(result.errors).toEqual(["Timeout 15000ms exceeded"]);
  });

  it("refuses to load credentials for a browser provider the connection was not approved for", async () => {
    const secretStore = new CountingSecretStore();
    const provider = new FixtureBrowserProvider({ page: new FixturePortalPage() });
    const runner = await makeRunner({
      page: new FixturePortalPage(),
      provider,
      secretStore,
      approvedBrowserProvider: "browserbase",
    });

    const result = await runner.runTask(input());

    expect(result.status).toBe("policy_refused");
    expect(result.errors).toEqual([
      'refused: portal connection is approved for browser provider "browserbase", not "local-playwright"',
    ]);
    expect(secretStore.getCount).toBe(0);
    expect(provider.sessionCount).toBe(0);
  });

  it("stops as blocked when a click triggers a request the guard refuses", async () => {
    const page = new FixturePortalPage();
    const noException: PortalTask = { ...task, httpMethodExceptions: [] };
    const runner = await makeRunner({ page, connectionTask: noException });

    const result = await runner.runTask(input({ task: noException }));

    expect(result.status).toBe("blocked");
    expect(result.provenance.blockedRequests).toEqual([
      {
        url: "https://portal.test/login",
        method: "POST",
        resourceType: "document",
        reason: "non_idempotent_method",
      },
    ]);
    expect(page.waitCounts.has("[data-testid='invoice-list']")).toBe(false);
    expect(page.clickCount).toBe(1);
    expect(page.queryAllCount).toBe(0);
    expect(page.requestCount).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("reports a click target that never appears as selector_missing with one screenshot", async () => {
    const page = new FixturePortalPage({ missingSelectors: new Set(["button.login"]) });
    const nonSensitive: PortalTask = {
      ...task,
      steps: task.steps.map((step) => ({ ...step, sensitive: false })),
    };
    const runner = await makeRunner({ page, connectionTask: nonSensitive });

    const result = await runner.runTask(input({ task: nonSensitive }));

    expect(result.status).toBe("selector_missing");
    expect(result.errors).toEqual(["selector_missing: button.login"]);
    expect(page.waitCounts.get("button.login")).toBe(1);
    expect(page.clickCount).toBe(0);
    expect(page.screenshotCount).toBe(1);
    expect(page.waitCounts.has("[data-testid='invoice-list']")).toBe(false);
    expect(result.provenance.allowedNonIdempotentRequests).toEqual([]);
  });

  it("keeps a click that times out on a present element as a retryable failure", async () => {
    const page = new FixturePortalPage({ timeoutSelectors: new Set(["button.login"]) });
    const runner = await makeRunner({ page });

    const result = await runner.runTask(input());

    expect(result.status).toBe("failed");
    expect(result.errors).toEqual(["Timeout 15000ms exceeded"]);
    expect(page.waitCounts.get("button.login")).toBe(1);
    expect(page.screenshotCount).toBe(0);
  });

  it("reports an off-allowlist final URL as blocked before judging status or content type", async () => {
    const storage = new CountingDocumentStorage();
    const page = new FixturePortalPage({
      download: () => ({
        bytes: new Uint8Array(0),
        mimeType: "text/html",
        finalUrl: "https://evil.test/invoice.pdf",
        status: 500,
      }),
    });
    const runner = await makeRunner({ page, storage });

    const result = await runner.runTask(input());

    expect(result.status).toBe("blocked");
    expect(result.errors).toEqual(["download blocked: redirect left the portal policy"]);
    expect(storage.putCount).toBe(0);
  });

  it("reports a non-2xx download as failed once its final URL is on the allowlist", async () => {
    const page = new FixturePortalPage({
      download: (url) => ({
        bytes: new TextEncoder().encode("%PDF-1.4 error page"),
        mimeType: "application/pdf",
        finalUrl: url,
        status: 500,
      }),
    });
    const runner = await makeRunner({ page });

    const result = await runner.runTask(input());

    expect(result.status).toBe("failed");
    expect(result.errors).toEqual(["download failed with status 500"]);
  });

  it("follows download redirects the guard allows and retains the final URL", async () => {
    const page = new FixturePortalPage({
      download: (url, options) => {
        const redirected = url.replace("/invoices/", "/files/");
        if (!options.onRedirect(redirected)) {
          throw new Error("download redirect blocked by portal network policy");
        }
        return {
          bytes: new TextEncoder().encode(`%PDF-1.4 ${redirected}`),
          mimeType: "application/pdf",
          finalUrl: redirected,
          status: 200,
        };
      },
    });
    const runner = await makeRunner({ page });

    const result = await runner.runTask(input());

    expect(result.status).toBe("completed");
    expect(result.documents.map((document) => document.sourceUrl)).toEqual([
      "https://portal.test/files/2026-01.pdf",
      "https://portal.test/files/2026-02.pdf",
    ]);
    expect(result.provenance.blockedRequests).toEqual([]);
  });

  it("refuses a download redirect that leaves the allowlist and reports the run as blocked", async () => {
    const storage = new CountingDocumentStorage();
    let redirectAllowed: boolean | undefined;
    const page = new FixturePortalPage({
      download: (url, options) => {
        redirectAllowed = options.onRedirect("https://evil.test/leak.pdf?sid=abc123");
        if (!redirectAllowed) {
          throw new Error("download redirect blocked by portal network policy");
        }
        return {
          bytes: new TextEncoder().encode("%PDF-1.4 leaked"),
          mimeType: "application/pdf",
          finalUrl: url,
          status: 200,
        };
      },
    });
    const runner = await makeRunner({ page, storage });

    const result = await runner.runTask(input());

    expect(redirectAllowed).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.errors).toEqual(["download redirect blocked by portal network policy"]);
    expect(page.requestCount).toBe(1);
    expect(storage.putCount).toBe(0);
    expect(result.provenance.blockedRequests).toEqual([
      {
        url: "https://evil.test/leak.pdf",
        method: "GET",
        resourceType: "document",
        reason: "off_allowlist",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("abc123");
  });

  it("rejects an empty download payload before storage", async () => {
    const storage = new CountingDocumentStorage();
    const page = new FixturePortalPage({
      download: (url) => ({
        bytes: new Uint8Array(0),
        mimeType: "application/pdf",
        finalUrl: url,
        status: 200,
      }),
    });
    const runner = await makeRunner({ page, storage });

    const result = await runner.runTask(input());

    expect(result.status).toBe("failed");
    expect(result.errors).toEqual(["download payload is empty"]);
    expect(storage.putCount).toBe(0);
  });

  it("never serializes download bytes into the run result whatever the outcome", async () => {
    const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.4 ${text}`);
    const scenarios: { name: string; page: FixturePortalPage; closeFailure?: Error }[] = [
      {
        name: "failed status",
        page: new FixturePortalPage({
          download: (url) => ({
            bytes: pdf("error"),
            mimeType: "application/pdf",
            finalUrl: url,
            status: 500,
          }),
        }),
      },
      {
        name: "off-allowlist final url",
        page: new FixturePortalPage({
          download: () => ({
            bytes: pdf("exfiltrated"),
            mimeType: "application/pdf",
            finalUrl: "https://evil.test/x.pdf",
            status: 200,
          }),
        }),
      },
      {
        name: "unexpected content type",
        page: new FixturePortalPage({
          download: (url) => ({
            bytes: pdf("mislabelled"),
            mimeType: "text/html",
            finalUrl: url,
            status: 200,
          }),
        }),
      },
      {
        name: "completed then close failure",
        page: new FixturePortalPage(),
        closeFailure: new Error("browser exited"),
      },
    ];

    for (const scenario of scenarios) {
      const runner = await makeRunner({
        page: scenario.page,
        ...(scenario.closeFailure === undefined ? {} : { closeFailure: scenario.closeFailure }),
      });
      const result = await runner.runTask(input());
      const serialized = JSON.stringify(result);

      expect(result.status, scenario.name).not.toBe("completed");
      expect(serialized, scenario.name).not.toContain('"bytes"');
      expect(serialized, scenario.name).not.toContain("%PDF");
    }
  });

  it("records an incidental off-allowlist subresource without stopping the run", async () => {
    const page = new FixturePortalPage({
      subresources: [{ url: "https://tracking.example/pixel.gif", resourceType: "image" }],
    });
    const runner = await makeRunner({ page });

    const result = await runner.runTask(input());

    expect(result.status).toBe("completed");
    expect(result.documents).toHaveLength(2);
    expect(result.provenance.blockedRequests).toEqual([
      expect.objectContaining({
        url: "https://tracking.example/pixel.gif",
        reason: "off_allowlist",
      }),
    ]);
    expect(result.warnings).toContain("1 incidental request(s) blocked; see provenance");
  });

  it("releases a reserved content hash when storing the document fails", async () => {
    const registry = new InMemoryPortalDocumentRegistry();
    const storage = new CountingDocumentStorage();
    storage.failNextPut = new Error("disk full");
    const runner = await makeRunner({ page: new FixturePortalPage(), registry, storage });

    const failed = await runner.runTask(input());
    const retried = await runner.runTask(input({ runId: "run_2" }));

    expect(failed.status).toBe("failed");
    expect(failed.errors).toEqual(["disk full"]);
    expect(retried.status).toBe("completed");
    expect(retried.documents).toHaveLength(2);
  });

  it("refuses a login POST whose body carries fields outside the reviewed form", async () => {
    const page = new FixturePortalPage({
      loginPostData: "email=a%40b.test&password=x&action=delete_account",
    });
    const runner = await makeRunner({ page });

    const result = await runner.runTask(input());

    expect(result.status).toBe("blocked");
    expect(result.provenance.blockedRequests[0]).toMatchObject({
      url: "https://portal.test/login",
      reason: "unreviewed_body",
    });
    expect(result.provenance.allowedNonIdempotentRequests).toEqual([]);
  });

  it("rejects bytes that do not carry the declared document signature", async () => {
    const storage = new CountingDocumentStorage();
    const page = new FixturePortalPage({
      download: (url) => ({
        bytes: new TextEncoder().encode("<html>proxy error</html>"),
        mimeType: "application/pdf",
        finalUrl: url,
        status: 200,
      }),
    });
    const runner = await makeRunner({ page, storage });

    const result = await runner.runTask(input());

    expect(result.status).toBe("failed");
    expect(result.errors).toEqual([
      "download payload does not carry the application/pdf signature",
    ]);
    expect(storage.putCount).toBe(0);
  });

  it("redacts identifier-like path segments from retained source URLs", async () => {
    const page = new FixturePortalPage({
      linkHrefs: [
        "https://portal.test/accounts/12345678/invoice.pdf",
        "https://portal.test/u/user%40example.test/inv.pdf?sig=abc",
      ],
    });
    const runner = await makeRunner({ page });

    const result = await runner.runTask(input());

    expect(result.status).toBe("completed");
    expect(result.documents.map((document) => document.sourceUrl)).toEqual([
      "https://portal.test/accounts/[REDACTED_SEGMENT]/invoice.pdf",
      "https://portal.test/u/[REDACTED_SEGMENT]/inv.pdf",
    ]);
    expect(result.storedDocuments[0]?.metadata["portal.sourceUrl"]).toBe(
      "https://portal.test/accounts/[REDACTED_SEGMENT]/invoice.pdf",
    );
  });

  it("strips query strings from URLs embedded in browser error messages", async () => {
    const page = new FixturePortalPage({
      download: () => {
        throw new Error("net::ERR_FAILED at https://portal.test/dl?session=abc123&x=1");
      },
    });
    const runner = await makeRunner({ page });

    const result = await runner.runTask(input());

    expect(result.status).toBe("failed");
    expect(result.errors).toEqual(["net::ERR_FAILED at https://portal.test/dl"]);
  });

  it("returns a failed result when browser startup fails", async () => {
    const runner = await makeRunner({
      page: new FixturePortalPage(),
      providerFailure: new Error("browser startup failed for synthetic-password"),
    });

    const result = await runner.runTask(input());

    expect(result.status).toBe("failed");
    expect(result.errors.join(" ")).toContain("browser startup failed");
    expect(result.errors.join(" ")).not.toContain("synthetic-password");
  });

  it("blocks redirected downloads whose final target leaves the allowlist", async () => {
    const storage = new CountingDocumentStorage();
    const page = new FixturePortalPage({
      download: () => ({
        bytes: new TextEncoder().encode("%PDF-1.4 exfiltrated"),
        mimeType: "application/pdf",
        finalUrl: "https://evil.test/invoice.pdf",
        status: 200,
      }),
    });
    const runner = await makeRunner({ page, storage });

    const result = await runner.runTask(input());

    expect(result.status).toBe("blocked");
    expect(result.storedDocuments).toEqual([]);
    expect(storage.putCount).toBe(0);
    expect(result.provenance.blockedRequests[0]).toMatchObject({
      url: "https://evil.test/invoice.pdf",
      reason: "off_allowlist",
    });
  });

  it("rejects failed and non-document download responses before storage", async () => {
    const storage = new CountingDocumentStorage();
    const page = new FixturePortalPage({
      download: (url) => ({
        bytes: new TextEncoder().encode("<html>expired session</html>"),
        mimeType: "text/html",
        finalUrl: url,
        status: 200,
      }),
    });
    const runner = await makeRunner({ page, storage });

    const result = await runner.runTask(input());

    expect(result.status).toBe("failed");
    expect(result.errors.join(" ")).toContain("unexpected content type");
    expect(storage.putCount).toBe(0);
  });

  it("limits download candidates before buffering portal responses", async () => {
    let requestCount = 0;
    const page = new FixturePortalPage({
      linkCount: 55,
      download: (url) => {
        requestCount += 1;
        return {
          bytes: new TextEncoder().encode(`%PDF-1.4 synthetic invoice ${url}`),
          mimeType: "application/pdf",
          finalUrl: url,
          status: 200,
        };
      },
    });
    const runner = await makeRunner({ page });

    const result = await runner.runTask(input());

    expect(result.status).toBe("completed");
    expect(requestCount).toBe(50);
    expect(result.warnings).toContain("download link count limited to 50 documents");
  });

  it("suppresses the failure screenshot once a sensitive step has run", async () => {
    const page = new FixturePortalPage({
      missingSelectors: new Set(["[data-testid='invoice-list']"]),
    });
    const runner = await makeRunner({ page });

    // The synthetic task marks its login navigation as sensitive.
    const result = await runner.runTask(input());

    expect(result.status).toBe("selector_missing");
    expect(page.screenshotCount).toBe(0);
    expect(result.warnings.some((warning) => warning.includes("screenshot"))).toBe(false);
  });

  it("captures exactly one failure screenshot on a non-sensitive path", async () => {
    const page = new FixturePortalPage({
      missingSelectors: new Set(["[data-testid='invoice-list']"]),
    });
    const nonSensitive: PortalTask = {
      ...task,
      steps: task.steps.map((step) => ({ ...step, sensitive: false })),
    };
    const runner = await makeRunner({ page, connectionTask: nonSensitive });

    const result = await runner.runTask(input({ task: nonSensitive }));

    expect(result.status).toBe("selector_missing");
    expect(page.screenshotCount).toBe(1);
    expect(result.warnings.filter((warning) => warning.includes("screenshot"))).toEqual([
      expect.stringMatching(/^failure screenshot hashed, bytes not retained: [0-9a-f]{64}$/),
    ]);
  });

  it("blocks download links that all leave the allowlist without fetching or storing", async () => {
    const storage = new CountingDocumentStorage();
    const page = new FixturePortalPage({
      linkHrefs: ["https://evil.test/a.pdf", "https://portal.test.evil.example/b.pdf"],
    });
    const runner = await makeRunner({ page, storage });

    const result = await runner.runTask(input());

    expect(result.status).toBe("blocked");
    expect(page.requestCount).toBe(0);
    expect(storage.putCount).toBe(0);
    expect(result.documents).toEqual([]);
    expect(
      result.warnings.filter((warning) => warning === "download blocked: off_allowlist"),
    ).toHaveLength(1);
    // The run stops at the first refused link instead of probing the rest.
    expect(result.provenance.blockedRequests.map((request) => request.url)).toEqual([
      "https://evil.test/a.pdf",
    ]);
  });

  it("blocks javascript: and mailto: hrefs instead of requesting them", async () => {
    const page = new FixturePortalPage({
      linkHrefs: ["javascript:alert(1)", "mailto:billing@portal.test"],
    });
    const runner = await makeRunner({ page });

    const result = await runner.runTask(input());

    expect(result.status).toBe("blocked");
    expect(page.requestCount).toBe(0);
    expect(result.storedDocuments).toEqual([]);
    expect(result.provenance.blockedRequests.map((request) => request.reason)).toEqual([
      "off_allowlist",
    ]);
  });

  it("resolves relative hrefs against the current page before guarding them", async () => {
    const page = new FixturePortalPage({ linkHrefs: ["/files/2026-01.pdf", "2026-02.pdf"] });
    const runner = await makeRunner({ page });

    const result = await runner.runTask(input());

    expect(result.status).toBe("completed");
    expect(result.documents.map((document) => document.sourceUrl)).toEqual([
      "https://portal.test/files/2026-01.pdf",
      "https://portal.test/2026-02.pdf",
    ]);
  });

  it("dedups downloads across runners that share a document registry", async () => {
    const registry = new InMemoryPortalDocumentRegistry();
    const firstStorage = new CountingDocumentStorage();
    const secondStorage = new CountingDocumentStorage();
    const first = await makeRunner({
      page: new FixturePortalPage(),
      registry,
      storage: firstStorage,
    });
    const second = await makeRunner({
      page: new FixturePortalPage(),
      registry,
      storage: secondStorage,
    });

    const firstResult = await first.runTask(input());
    const secondResult = await second.runTask(input({ runId: "run_2" }));

    expect(firstResult.documents).toHaveLength(2);
    expect(secondResult.status).toBe("completed");
    expect(secondResult.documents).toEqual([]);
    expect(firstStorage.putCount).toBe(2);
    expect(secondStorage.putCount).toBe(0);
  });

  it("does not dedup across workspaces in the shared registry", async () => {
    const registry = new InMemoryPortalDocumentRegistry();
    const hash = "a".repeat(64);

    const first = await registry.reserveContentHash({
      workspaceId: "ws_1",
      contentHash: hash,
      documentId: "d1",
    });
    const again = await registry.reserveContentHash({
      workspaceId: "ws_1",
      contentHash: hash,
      documentId: "d2",
    });
    const otherWorkspace = await registry.reserveContentHash({
      workspaceId: "ws_2",
      contentHash: hash,
      documentId: "d3",
    });
    await registry.releaseContentHash({ workspaceId: "ws_1", contentHash: hash });
    const afterRelease = await registry.reserveContentHash({
      workspaceId: "ws_1",
      contentHash: hash,
      documentId: "d4",
    });

    expect([first, again, otherWorkspace, afterRelease]).toEqual([true, false, true, true]);
  });

  it("fails before loading credentials when the connection targets another task", async () => {
    const secretStore = new CountingSecretStore();
    const provider = new FixtureBrowserProvider({ page: new FixturePortalPage() });
    const runner = await makeRunner({
      page: new FixturePortalPage(),
      provider,
      secretStore,
      connectionTaskId: "another-portal",
    });

    const result = await runner.runTask(input());

    expect(result.status).toBe("policy_refused");
    expect(result.errors).toEqual([
      "refused: portal connection is not bound to this workspace and reviewed task revision",
    ]);
    expect(secretStore.getCount).toBe(0);
    expect(provider.sessionCount).toBe(0);
  });

  it("fails before loading credentials when a repository leaks another workspace's connection", async () => {
    const secretStore = new CountingSecretStore();
    const provider = new FixtureBrowserProvider({ page: new FixturePortalPage() });
    const leaky: PortalConnectionRepository = {
      async getConnection(request: GetPortalConnectionInput): Promise<PortalConnection> {
        return {
          id: request.connectionId,
          workspaceId: "ws_other",
          taskId: task.id,
          taskDigest: portalTaskDigest(task),
          approvedBrowserProvider: "local-playwright",
          credentialRefs: {},
        };
      },
    };
    const runner = await makeRunner({
      page: new FixturePortalPage(),
      provider,
      secretStore,
      connections: leaky,
    });

    const result = await runner.runTask(input());

    expect(result.status).toBe("policy_refused");
    expect(result.errors[0]).toContain("not bound to this workspace");
    expect(secretStore.getCount).toBe(0);
    expect(provider.sessionCount).toBe(0);
  });

  it("scopes in-memory connection lookups to the requesting workspace", async () => {
    const secretStore = new CountingSecretStore();
    const provider = new FixtureBrowserProvider({ page: new FixturePortalPage() });
    const runner = await makeRunner({ page: new FixturePortalPage(), provider, secretStore });

    const result = await runner.runTask(input({ workspaceId: "ws_2" }));

    expect(result.status).toBe("failed");
    expect(result.errors).toEqual(["Portal connection not found: conn_1"]);
    expect(secretStore.getCount).toBe(0);
    expect(provider.sessionCount).toBe(0);
  });

  it("marks the run failed with a redacted message when closing the session throws", async () => {
    const secretMarker = "CLOSE-S3CRET-77";
    const runner = await makeRunner({
      page: new FixturePortalPage(),
      password: secretMarker,
      closeFailure: new Error(`browser exited uncleanly while holding ${secretMarker}`),
    });

    const result = await runner.runTask(input());

    expect(result.status).toBe("failed");
    expect(result.errors).toEqual(["browser exited uncleanly while holding [REDACTED_SECRET]"]);
    expect(JSON.stringify(result)).not.toContain(secretMarker);
    // Documents fetched before the close failure are still reported.
    expect(result.documents).toHaveLength(2);
  });

  it("scopes stored documents to the workspace and returns object references only", async () => {
    const storage = new CountingDocumentStorage();
    const runner = await makeRunner({ page: new FixturePortalPage(), storage });

    const result = await runner.runTask(input());
    const serialized = JSON.stringify(result);

    expect(result.storedDocuments.map((document) => document.workspaceId)).toEqual([
      "ws_1",
      "ws_1",
    ]);
    for (const [index, stored] of result.storedDocuments.entries()) {
      const fetched = result.documents[index];
      expect(stored.id).toBe(`portal_conn_1_${fetched?.contentHash.slice(0, 16)}`);
      expect(stored.metadata).toMatchObject({
        "portal.runId": "run_1",
        "portal.taskId": "synthetic-reference-portal",
        "portal.taskVersion": "1",
        "portal.index": String(index),
        "portal.sourceUrl": `https://portal.test/invoices/2026-0${index + 1}.pdf`,
      });
      expect(fetched?.content).toEqual({ kind: "objectRef", uri: `stored-document:${stored.id}` });
      expect(fetched?.provenance.workspaceId).toBe("ws_1");
    }
    expect(serialized).not.toContain('"bytes"');
    expect(serialized).not.toContain("%PDF");
  });

  it("records the justified login POST in run provenance", async () => {
    const runner = await makeRunner({ page: new FixturePortalPage() });

    const result = await runner.runTask(input());

    expect(result.status).toBe("completed");
    expect(result.provenance.blockedRequests).toEqual([]);
    expect(result.provenance.allowedNonIdempotentRequests).toEqual([
      {
        url: "https://portal.test/login",
        method: "POST",
        reason: "login",
        justification: "Portal login form requires POST before read-only invoice access.",
      },
    ]);
  });
});

class CountingSecretStore extends InMemorySecretStore {
  getCount = 0;

  override async getSecret(inputValue: GetSecretInput): Promise<SecretValue> {
    this.getCount += 1;
    return await super.getSecret(inputValue);
  }
}

class CountingDocumentStorage extends InMemoryDocumentStorage {
  putCount = 0;
  failNextPut: Error | undefined;
  readonly #documents: unknown[] = [];

  override async put(inputValue: Parameters<InMemoryDocumentStorage["put"]>[0]) {
    if (this.failNextPut !== undefined) {
      const failure = this.failNextPut;
      this.failNextPut = undefined;
      throw failure;
    }
    this.putCount += 1;
    const document = await super.put(inputValue);
    this.#documents.push(document);
    return document;
  }

  serializedDocuments(): unknown[] {
    return [...this.#documents];
  }
}

interface MakeRunnerInput {
  page: FixturePortalPage;
  storage?: CountingDocumentStorage;
  registry?: InMemoryPortalDocumentRegistry;
  evidence?: InMemoryPortalEvidenceRepository;
  password?: string;
  providerFailure?: Error;
  providerSensitiveValues?: readonly string[];
  /** Overrides the provider built from `page`/`providerFailure`. */
  provider?: FixtureBrowserProvider;
  secretStore?: InMemorySecretStore;
  /** Task id the in-memory connection is bound to (default: the synthetic task). */
  connectionTaskId?: string;
  /** Task revision the in-memory connection is bound to (default: the synthetic task). */
  connectionTask?: PortalTask;
  /** Browser provider the in-memory connection was approved for (default: the fixture's). */
  approvedBrowserProvider?: string;
  /** Overrides the in-memory connection repository entirely. */
  connections?: PortalConnectionRepository;
  closeFailure?: Error;
}

async function makeRunner(inputValue: MakeRunnerInput): Promise<LocalPlaywrightPortalTaskRunner> {
  const secretStore = inputValue.secretStore ?? new InMemorySecretStore();
  const usernameRef = await secretStore.putSecret({
    context,
    label: "Portal username",
    value: createSecretValue("synthetic-user@example.test"),
  });
  const passwordRef = await secretStore.putSecret({
    context,
    label: "Portal password",
    value: createSecretValue(inputValue.password ?? "synthetic-password"),
  });
  const connections =
    inputValue.connections ??
    new InMemoryPortalConnectionRepository([
      {
        id: "conn_1",
        workspaceId: context.workspaceId,
        taskId: inputValue.connectionTaskId ?? task.id,
        taskDigest: portalTaskDigest(inputValue.connectionTask ?? task),
        approvedBrowserProvider: inputValue.approvedBrowserProvider ?? "local-playwright",
        credentialRefs: {
          username: usernameRef,
          password: passwordRef,
        },
      },
    ]);

  return new LocalPlaywrightPortalTaskRunner({
    browserProvider:
      inputValue.provider ??
      new FixtureBrowserProvider({
        page: inputValue.page,
        failure: inputValue.providerFailure,
        sensitiveValues: inputValue.providerSensitiveValues,
        closeFailure: inputValue.closeFailure,
      }),
    documentStorage: inputValue.storage ?? new CountingDocumentStorage(),
    documentRegistry: inputValue.registry ?? new InMemoryPortalDocumentRegistry(),
    evidence: inputValue.evidence ?? new InMemoryPortalEvidenceRepository(),
    secretStore,
    connections,
  });
}

interface FixtureBrowserProviderOptions {
  page: FixturePortalPage;
  failure?: Error;
  sensitiveValues?: readonly string[];
  closeFailure?: Error;
}

class FixtureBrowserProvider implements PortalBrowserProvider {
  readonly providerName = "local-playwright";
  readonly sensitiveValues: readonly string[];
  sessionCount = 0;
  readonly #page: FixturePortalPage;
  readonly #failure: Error | undefined;
  readonly #closeFailure: Error | undefined;

  constructor(options: FixtureBrowserProviderOptions) {
    this.#page = options.page;
    this.#failure = options.failure;
    this.#closeFailure = options.closeFailure;
    this.sensitiveValues = options.sensitiveValues ?? [];
  }

  async createSession(): Promise<PortalBrowserSession> {
    if (this.#failure !== undefined) {
      throw this.#failure;
    }
    this.sessionCount += 1;
    return {
      page: this.#page,
      guardRequests: async (guard) => {
        this.#page.guardRequests(guard);
      },
      close: async () => {
        if (this.#closeFailure !== undefined) {
          throw this.#closeFailure;
        }
      },
    };
  }
}

interface FixturePortalPageOptions {
  /** Selectors `waitForSelector` resolves false for. */
  missingSelectors?: ReadonlySet<string>;
  /** Selectors `waitForSelector` rejects with a timeout error for. */
  waitTimeoutSelectors?: ReadonlySet<string>;
  /** Selectors that are present but whose fill/click action times out. */
  timeoutSelectors?: ReadonlySet<string>;
  download?: (url: string, options: PortalDownloadRequestOptions) => PortalDownloadResponse;
  linkCount?: number;
  /** Attribute the fixture links expose their URL under (default `href`). */
  hrefAttribute?: string;
  /** Mimic Playwright: a route handler that throws makes the navigation reject. */
  abortBlockedRequests?: boolean;
  /** Raw href values for the fixture links; overrides `linkCount` when set. */
  linkHrefs?: readonly string[];
  /** Body the fixture login form posts (default: the reviewed email/password fields). */
  loginPostData?: string;
  /** Extra requests the login page issues on load, e.g. third-party pixels. */
  subresources?: readonly Pick<PortalRequest, "url" | "resourceType">[];
}

class FixturePortalPage implements PortalBrowserPage {
  readonly waitCounts = new Map<string, number>();
  screenshotCount = 0;
  /** Number of `click` calls that reached the page, i.e. actions past the presence wait. */
  clickCount = 0;
  /** Number of `queryAll` calls, i.e. download steps that started. */
  queryAllCount = 0;
  /** Number of `requestBytes` calls, i.e. download fetches actually attempted. */
  requestCount = 0;
  readonly #linkHrefs: readonly string[] | undefined;
  readonly #missingSelectors: ReadonlySet<string>;
  readonly #waitTimeoutSelectors: ReadonlySet<string>;
  readonly #timeoutSelectors: ReadonlySet<string>;
  readonly #download:
    | ((url: string, options: PortalDownloadRequestOptions) => PortalDownloadResponse)
    | undefined;
  readonly #linkCount: number;
  readonly #hrefAttribute: string;
  readonly #abortBlockedRequests: boolean;
  readonly #loginPostData: string;
  readonly #subresources: readonly Pick<PortalRequest, "url" | "resourceType">[];
  #guard: PortalRequestGuard | undefined;
  #currentUrl = "https://portal.test/login";

  constructor(options: FixturePortalPageOptions = {}) {
    this.#missingSelectors = options.missingSelectors ?? new Set();
    this.#waitTimeoutSelectors = options.waitTimeoutSelectors ?? new Set();
    this.#timeoutSelectors = options.timeoutSelectors ?? new Set();
    this.#download = options.download;
    this.#linkCount = options.linkCount ?? 2;
    this.#hrefAttribute = options.hrefAttribute ?? "href";
    this.#abortBlockedRequests = options.abortBlockedRequests ?? false;
    this.#linkHrefs = options.linkHrefs;
    this.#loginPostData =
      options.loginPostData ?? "email=synthetic-user%40example.test&password=synthetic-password";
    this.#subresources = options.subresources ?? [];
  }

  guardRequests(guard: PortalRequestGuard): void {
    this.#guard = guard;
  }

  async goto(url: string): Promise<void> {
    await this.emitRequest({ url, method: "GET", resourceType: "document" });
    for (const subresource of this.#subresources) {
      await this.emitRequest({ ...subresource, method: "GET" });
    }
    this.#currentUrl = url;
  }

  async fill(selector: string): Promise<void> {
    this.throwIfTimingOut(selector);
  }

  async click(selector: string): Promise<void> {
    this.throwIfTimingOut(selector);
    this.clickCount += 1;
    await this.emitRequest({
      url: "https://portal.test/login",
      method: "POST",
      resourceType: "document",
      postData: this.#loginPostData,
    });
    this.#currentUrl = "https://portal.test/invoices";
  }

  private throwIfTimingOut(selector: string): void {
    if (this.#timeoutSelectors.has(selector)) {
      throw new Error("Timeout 15000ms exceeded");
    }
  }

  private async emitRequest(request: PortalRequest): Promise<void> {
    try {
      await this.#guard?.(request);
    } catch (error) {
      if (this.#abortBlockedRequests) {
        throw error;
      }
    }
  }

  async waitForSelector(selector: string): Promise<boolean> {
    this.waitCounts.set(selector, (this.waitCounts.get(selector) ?? 0) + 1);
    if (this.#waitTimeoutSelectors.has(selector)) {
      throw new Error("Timeout 30000ms exceeded");
    }
    return !this.#missingSelectors.has(selector);
  }

  async queryAll(selector: string): Promise<PortalElementHandle[]> {
    this.queryAllCount += 1;
    if (selector !== "a.invoice-download") {
      return [];
    }
    if (this.#linkHrefs !== undefined) {
      return this.#linkHrefs.map(
        (href, index) => new FixtureElement(href, `link-${index + 1}.pdf`, this.#hrefAttribute),
      );
    }
    return Array.from({ length: this.#linkCount }, (_value, index) => {
      const invoice = String(index + 1).padStart(2, "0");
      return new FixtureElement(
        `https://portal.test/invoices/2026-${invoice}.pdf`,
        `2026-${invoice}.pdf`,
        this.#hrefAttribute,
      );
    });
  }

  async requestBytes(
    url: string,
    options: PortalDownloadRequestOptions,
  ): Promise<PortalDownloadResponse> {
    this.requestCount += 1;
    await this.emitRequest({ url, method: "GET", resourceType: "document" });
    if (this.#download !== undefined) {
      return this.#download(url, options);
    }
    return {
      bytes: new TextEncoder().encode(`%PDF-1.4 synthetic invoice ${url}`),
      mimeType: "application/pdf",
      finalUrl: url,
      status: 200,
    };
  }

  async screenshot(): Promise<Uint8Array> {
    this.screenshotCount += 1;
    return new Uint8Array([1]);
  }

  url(): string {
    return this.#currentUrl;
  }
}

class FixtureElement implements PortalElementHandle {
  readonly #href: string;
  readonly #filename: string;
  readonly #hrefAttribute: string;

  constructor(href: string, filename: string, hrefAttribute: string) {
    this.#href = href;
    this.#filename = filename;
    this.#hrefAttribute = hrefAttribute;
  }

  async getAttribute(name: string): Promise<string | null> {
    if (name === "href" && this.#hrefAttribute === "href") {
      return this.#href;
    }
    if (name === "data-filename") {
      return this.#filename;
    }
    return null;
  }

  async textContent(): Promise<string | null> {
    return this.#filename;
  }
}

describe("LocalPlaywrightPortalTaskRunner evidence and warnings", () => {
  it("registers each stored file as portal evidence whose metadata traces back to the run", async () => {
    const evidence = new InMemoryPortalEvidenceRepository();
    const runner = await makeRunner({ page: new FixturePortalPage(), evidence });

    const result = await runner.runTask(input());

    const stored = result.storedDocuments[0];
    const fetched = result.documents[0];
    if (stored === undefined || fetched === undefined) {
      throw new Error("expected the first fixture invoice to be stored");
    }
    expect(stored.id).toBe(`portal_conn_1_${fetched.contentHash.slice(0, 16)}`);
    expect(fetched.content).toEqual({
      kind: "objectRef",
      uri: `${STORED_DOCUMENT_URI_SCHEME}${stored.id}`,
    });
    expect(evidence.listDocuments(context)[0]).toEqual({
      id: stored.id,
      workspaceId: "ws_1",
      contentHash: fetched.contentHash,
      mimeType: "application/pdf",
      originalFilename: "2026-01.pdf",
      storageUri: `${STORED_DOCUMENT_URI_SCHEME}${stored.id}`,
      sourceKind: "portal",
      sourceMetadata: {
        sourcePortal: "portal.test",
        taskId: "synthetic-reference-portal",
        taskVersion: 1,
        runId: "run_1",
        sourceUrl: "https://portal.test/invoices/2026-01.pdf",
        downloadedFilename: "2026-01.pdf",
        contentHash: fetched.contentHash,
        fetchedAt: now,
        browserProvider: "local-playwright",
        connectionId: "conn_1",
        extractionStatus: "pending",
      },
      retentionState: "active",
      createdAt: now,
    });
  });

  it("does not register evidence for a document whose storage failed", async () => {
    const evidence = new InMemoryPortalEvidenceRepository();
    const storage = new CountingDocumentStorage();
    storage.failNextPut = new Error("disk full");
    const runner = await makeRunner({ page: new FixturePortalPage(), evidence, storage });

    const failed = await runner.runTask(input());
    const retried = await runner.runTask(input({ runId: "run_2" }));

    expect(failed.status).toBe("failed");
    expect(failed.storedDocuments).toEqual([]);
    expect(retried.status).toBe("completed");
    expect(evidence.listDocuments(context).map((record) => record.sourceMetadata)).toEqual([
      expect.objectContaining({ runId: "run_2" }),
      expect.objectContaining({ runId: "run_2" }),
    ]);
  });

  it("fails the run and releases the content hash when evidence registration fails", async () => {
    const evidence = new FailingOnceEvidenceRepository(new Error("evidence store down"));
    const registry = new InMemoryPortalDocumentRegistry();
    const runner = await makeRunner({ page: new FixturePortalPage(), evidence, registry });

    const failed = await runner.runTask(input());
    const retried = await runner.runTask(input({ runId: "run_2" }));

    expect(failed.status).toBe("failed");
    expect(failed.errors).toEqual(["evidence store down"]);
    expect(failed.storedDocuments).toEqual([]);
    expect(failed.documents).toEqual([]);
    expect(retried.status).toBe("completed");
    expect(retried.documents).toHaveLength(2);
    expect(evidence.listDocuments(context)).toHaveLength(2);
  });

  it("counts every incidental block in a single warning", async () => {
    const page = new FixturePortalPage({
      subresources: [
        { url: "https://tracking.example/pixel.gif", resourceType: "image" },
        { url: "https://fonts.example/inter.woff2", resourceType: "font" },
        { url: "wss://portal.test/live", resourceType: "websocket" },
      ],
    });
    const runner = await makeRunner({ page });

    const result = await runner.runTask(input());

    expect(result.status).toBe("completed");
    expect(result.warnings).toEqual(["3 incidental request(s) blocked; see provenance"]);
    expect(result.provenance.blockedRequests.map((blocked) => blocked.reason)).toEqual([
      "off_allowlist",
      "off_allowlist",
      "streaming_channel",
    ]);
  });

  it("warns only about the incidental blocks when a material block ends the run", async () => {
    const page = new FixturePortalPage({
      subresources: [{ url: "https://tracking.example/pixel.gif", resourceType: "image" }],
    });
    const noException: PortalTask = { ...task, httpMethodExceptions: [] };
    const runner = await makeRunner({ page, connectionTask: noException });

    const result = await runner.runTask(input({ task: noException }));

    expect(result.status).toBe("blocked");
    expect(result.warnings).toEqual(["1 incidental request(s) blocked; see provenance"]);
    expect(result.provenance.blockedRequests).toHaveLength(2);
  });
});

class FailingOnceEvidenceRepository extends InMemoryPortalEvidenceRepository {
  #failure: Error | undefined;

  constructor(failure: Error) {
    super();
    this.#failure = failure;
  }

  override async saveDocument(inputValue: SavePortalEvidenceInput): Promise<void> {
    if (this.#failure !== undefined) {
      const failure = this.#failure;
      this.#failure = undefined;
      throw failure;
    }
    await super.saveDocument(inputValue);
  }
}
