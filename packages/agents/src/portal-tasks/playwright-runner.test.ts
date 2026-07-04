import { createSecretValue, InMemoryDocumentStorage, InMemorySecretStore } from "@sona/core";
import { describe, expect, it } from "vitest";
import {
  InMemoryPortalConnectionRepository,
  InMemoryPortalDocumentRegistry,
  LocalPlaywrightPortalTaskRunner,
  type PortalBrowserPage,
  type PortalBrowserProvider,
  type PortalBrowserSession,
  type PortalElementHandle,
} from "./playwright-runner.js";
import type { RunPortalTaskInput } from "./runner.js";
import type { PortalTask } from "./schema.js";

const now = "2026-02-01T00:00:00Z";
const context = { workspaceId: "ws_1", userId: "user_1" };

const task: PortalTask = {
  id: "synthetic-reference-portal",
  name: "Synthetic reference portal",
  version: 1,
  risk: "read_only_document_fetch",
  domains: ["portal.test"],
  requires: ["credentials"],
  allowedActions: ["navigate", "login", "search_invoices", "download_invoice_pdf"],
  forbiddenActions: ["purchase", "cancel_order", "change_payment_method"],
  outputs: ["document_file", "provenance_json"],
  httpMethodExceptions: [
    {
      method: "POST",
      urlPattern: "https://portal.test/login",
      reason: "login",
      justification: "Portal login form requires a POST before read-only invoice access.",
    },
  ],
  steps: [
    {
      kind: "navigate",
      url: "https://portal.test/login",
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
    expect(first.storedDocuments).toHaveLength(2);
    expect(first.storedDocuments[0]?.metadata["portal.runId"]).toBe("run_1");
    expect(first.storedDocuments[0]?.metadata["portal.taskId"]).toBe("synthetic-reference-portal");
    expect(second.status).toBe("completed");
    expect(second.documents).toEqual([]);
    expect(second.storedDocuments).toEqual([]);
    expect(storage.putCount).toBe(2);
  });

  it("redacts injected credentials from logs, provenance, console captures, and metadata", async () => {
    const secretMarker = "S3CRET-MARKER-14";
    const storage = new CountingDocumentStorage();
    const page = new FixturePortalPage({
      consoleMessages: [`login used ${secretMarker}`],
    });
    const runner = await makeRunner({
      storage,
      page,
      password: secretMarker,
    });

    const result = await runner.runTask(input());
    const stored = storage.serializedDocuments();
    const serialized = JSON.stringify({
      result,
      stored,
    });

    expect(serialized).not.toContain(secretMarker);
    expect(serialized).toContain("[REDACTED_SECRET]");
    expect(page.screenshotCount).toBe(0);
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
    browserProvider: new FixtureBrowserProvider(inputValue.page),
    documentStorage: inputValue.storage ?? new CountingDocumentStorage(),
    documentRegistry: inputValue.registry ?? new InMemoryPortalDocumentRegistry(),
    secretStore,
    connections,
  });
}

class FixtureBrowserProvider implements PortalBrowserProvider {
  readonly providerName = "local-playwright";
  readonly #page: FixturePortalPage;

  constructor(page: FixturePortalPage) {
    this.#page = page;
  }

  async createSession(): Promise<PortalBrowserSession> {
    return {
      page: this.#page,
      close: async () => undefined,
    };
  }
}

interface FixturePortalPageOptions {
  missingSelectors?: ReadonlySet<string>;
  consoleMessages?: readonly string[];
}

class FixturePortalPage implements PortalBrowserPage {
  readonly waitCounts = new Map<string, number>();
  screenshotCount = 0;
  readonly #missingSelectors: ReadonlySet<string>;
  readonly #consoleMessages: readonly string[];
  #routeHandler:
    | ((request: { url: string; method: string; resourceType: string }) => void)
    | undefined;
  #consoleHandler: ((message: { type: string; text: string }) => void) | undefined;
  #currentUrl = "https://portal.test/login";

  constructor(options: FixturePortalPageOptions = {}) {
    this.#missingSelectors = options.missingSelectors ?? new Set();
    this.#consoleMessages = options.consoleMessages ?? [];
  }

  async route(
    _pattern: string,
    handler: (request: { url: string; method: string; resourceType: string }) => void,
  ): Promise<void> {
    this.#routeHandler = handler;
  }

  onConsole(handler: (message: { type: string; text: string }) => void): void {
    this.#consoleHandler = handler;
  }

  async goto(url: string): Promise<void> {
    this.#routeHandler?.({ url, method: "GET", resourceType: "document" });
    this.#currentUrl = url;
  }

  async fill(_selector: string, value: string): Promise<void> {
    for (const message of this.#consoleMessages) {
      this.#consoleHandler?.({ type: "log", text: message.replace("synthetic-password", value) });
    }
  }

  async click(_selector: string): Promise<void> {
    this.#routeHandler?.({
      url: "https://portal.test/login",
      method: "POST",
      resourceType: "document",
    });
    this.#currentUrl = "https://portal.test/invoices";
  }

  async waitForSelector(selector: string): Promise<boolean> {
    this.waitCounts.set(selector, (this.waitCounts.get(selector) ?? 0) + 1);
    return !this.#missingSelectors.has(selector);
  }

  async queryAll(selector: string): Promise<PortalElementHandle[]> {
    if (selector !== "a.invoice-download") {
      return [];
    }
    return [
      new FixtureElement("https://portal.test/invoices/2026-01.pdf", "2026-01.pdf"),
      new FixtureElement("https://portal.test/invoices/2026-02.pdf", "2026-02.pdf"),
    ];
  }

  async requestBytes(
    url: string,
  ): Promise<{ bytes: Uint8Array; mimeType: string; finalUrl: string }> {
    this.#routeHandler?.({ url, method: "GET", resourceType: "document" });
    return {
      bytes: new TextEncoder().encode(`%PDF-1.4 synthetic invoice ${url}`),
      mimeType: "application/pdf",
      finalUrl: url,
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

  constructor(href: string, filename: string) {
    this.#href = href;
    this.#filename = filename;
  }

  async getAttribute(name: string): Promise<string | null> {
    if (name === "href") {
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
