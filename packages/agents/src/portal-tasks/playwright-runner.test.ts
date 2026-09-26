import { createSecretValue, InMemoryDocumentStorage, InMemorySecretStore } from "@sona/core";
import { describe, expect, it } from "vitest";
import type {
  PortalBrowserPage,
  PortalBrowserProvider,
  PortalBrowserSession,
  PortalDownloadRequestOptions,
  PortalDownloadResponse,
  PortalElementHandle,
} from "./browser.js";
import { syntheticReferencePortalTask } from "./definitions/synthetic-reference-portal.js";
import type { PortalRequest } from "./network-guard.js";
import { createCdpPlaywrightBrowserProvider } from "./playwright-adapter.js";
import {
  InMemoryPortalConnectionRepository,
  InMemoryPortalDocumentRegistry,
  LocalPlaywrightPortalTaskRunner,
} from "./playwright-runner.js";
import type { RunPortalTaskInput } from "./runner.js";
import { type PortalTask, parsePortalTask } from "./schema.js";

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
    const runner = await makeRunner({
      storage,
      registry,
      page: new FixturePortalPage(),
    });

    const first = await runner.runTask(input());
    const second = await runner.runTask(input({ runId: "run_2" }));

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
    const runner = await makeRunner({ page });
    const offAllowlist: PortalTask = {
      ...task,
      steps: [{ kind: "navigate", url: "https://portal.test/login" }],
      domains: ["other.test"],
    };

    const result = await runner.runTask(input({ task: offAllowlist }));

    expect(result.status).toBe("blocked");
    expect(result.provenance.blockedRequests).toHaveLength(1);
    expect(result.errors.join(" ")).toContain("blocked request");
  });

  it("returns selector_missing when download matches carry no usable link", async () => {
    const page = new FixturePortalPage({ hrefAttribute: "data-missing" });
    const runner = await makeRunner({ page });
    const buttonLinks: PortalTask = {
      ...task,
      steps: task.steps.map((step) =>
        step.kind === "downloadLinks" ? { ...step, hrefAttribute: "data-missing" } : step,
      ),
    };

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
      timeoutSelectors: new Set(["[data-testid='invoice-list']"]),
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
    const { steps: _steps, httpMethodExceptions: _exceptions, ...rawTask } = task;
    const runner = await makeRunner({ page: new FixturePortalPage() });

    const result = await runner.runTask(input({ task: rawTask as unknown as PortalTask }));

    expect(result.status).toBe("completed");
    expect(result.documents).toEqual([]);
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
      download: (_url, options) => {
        if (!options.onRedirect("https://evil.test/invoice.pdf")) {
          throw new Error("download redirect blocked by portal network policy");
        }
        throw new Error("unexpected allowed redirect");
      },
    });
    const runner = await makeRunner({ page, storage });

    const result = await runner.runTask(input());

    expect(result.status).toBe("blocked");
    expect(result.storedDocuments).toEqual([]);
    expect(storage.putCount).toBe(0);
    expect(result.provenance.blockedRequests?.[0]).toMatchObject({
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
});

class CountingDocumentStorage extends InMemoryDocumentStorage {
  putCount = 0;
  readonly #documents: unknown[] = [];

  override async put(inputValue: Parameters<InMemoryDocumentStorage["put"]>[0]) {
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
  password?: string;
  providerFailure?: Error;
  providerSensitiveValues?: readonly string[];
}

async function makeRunner(inputValue: MakeRunnerInput): Promise<LocalPlaywrightPortalTaskRunner> {
  const secretStore = new InMemorySecretStore();
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
  const connections = new InMemoryPortalConnectionRepository([
    {
      id: "conn_1",
      workspaceId: context.workspaceId,
      taskId: task.id,
      credentialRefs: {
        username: usernameRef,
        password: passwordRef,
      },
    },
  ]);

  return new LocalPlaywrightPortalTaskRunner({
    browserProvider: new FixtureBrowserProvider(
      inputValue.page,
      inputValue.providerFailure,
      inputValue.providerSensitiveValues,
    ),
    documentStorage: inputValue.storage ?? new CountingDocumentStorage(),
    documentRegistry: inputValue.registry ?? new InMemoryPortalDocumentRegistry(),
    secretStore,
    connections,
  });
}

class FixtureBrowserProvider implements PortalBrowserProvider {
  readonly providerName = "local-playwright";
  readonly sensitiveValues: readonly string[];
  readonly #page: FixturePortalPage;
  readonly #failure: Error | undefined;

  constructor(
    page: FixturePortalPage,
    failure: Error | undefined,
    sensitiveValues: readonly string[] = [],
  ) {
    this.#page = page;
    this.#failure = failure;
    this.sensitiveValues = sensitiveValues;
  }

  async createSession(): Promise<PortalBrowserSession> {
    if (this.#failure !== undefined) {
      throw this.#failure;
    }
    return {
      page: this.#page,
      route: async (pattern, handler) => {
        await this.#page.route(pattern, handler);
      },
      close: async () => undefined,
    };
  }
}

type FixtureRouteHandler = (request: PortalRequest) => void | Promise<void>;

interface FixturePortalPageOptions {
  missingSelectors?: ReadonlySet<string>;
  timeoutSelectors?: ReadonlySet<string>;
  download?: (url: string, options: PortalDownloadRequestOptions) => PortalDownloadResponse;
  linkCount?: number;
  /** Attribute the fixture links expose their URL under (default `href`). */
  hrefAttribute?: string;
  /** Mimic Playwright: a route handler that throws makes the navigation reject. */
  abortBlockedRequests?: boolean;
}

class FixturePortalPage implements PortalBrowserPage {
  readonly waitCounts = new Map<string, number>();
  screenshotCount = 0;
  readonly #missingSelectors: ReadonlySet<string>;
  readonly #timeoutSelectors: ReadonlySet<string>;
  readonly #download:
    | ((url: string, options: PortalDownloadRequestOptions) => PortalDownloadResponse)
    | undefined;
  readonly #linkCount: number;
  readonly #hrefAttribute: string;
  readonly #abortBlockedRequests: boolean;
  #routeHandler: FixtureRouteHandler | undefined;
  #currentUrl = "https://portal.test/login";

  constructor(options: FixturePortalPageOptions = {}) {
    this.#missingSelectors = options.missingSelectors ?? new Set();
    this.#timeoutSelectors = options.timeoutSelectors ?? new Set();
    this.#download = options.download;
    this.#linkCount = options.linkCount ?? 2;
    this.#hrefAttribute = options.hrefAttribute ?? "href";
    this.#abortBlockedRequests = options.abortBlockedRequests ?? false;
  }

  async route(_pattern: string, handler: FixtureRouteHandler): Promise<void> {
    this.#routeHandler = handler;
  }

  async goto(url: string): Promise<void> {
    await this.emitRequest({ url, method: "GET", resourceType: "document" });
    this.#currentUrl = url;
  }

  async fill(): Promise<void> {
    return;
  }

  async click(_selector: string): Promise<void> {
    await this.emitRequest({
      url: "https://portal.test/login",
      method: "POST",
      resourceType: "document",
    });
    this.#currentUrl = "https://portal.test/invoices";
  }

  private async emitRequest(request: PortalRequest): Promise<void> {
    try {
      await this.#routeHandler?.(request);
    } catch (error) {
      if (this.#abortBlockedRequests) {
        throw error;
      }
    }
  }

  async waitForSelector(selector: string): Promise<boolean> {
    this.waitCounts.set(selector, (this.waitCounts.get(selector) ?? 0) + 1);
    if (this.#timeoutSelectors.has(selector)) {
      throw new Error("Timeout 30000ms exceeded");
    }
    return !this.#missingSelectors.has(selector);
  }

  async queryAll(selector: string): Promise<PortalElementHandle[]> {
    if (selector !== "a.invoice-download") {
      return [];
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
