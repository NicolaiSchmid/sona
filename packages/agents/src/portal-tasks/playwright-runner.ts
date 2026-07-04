import {
  type DocumentStorage,
  type SecretRef,
  type SecretStore,
  type StoredDocument,
  sha256Hex,
  type WorkspaceContext,
} from "@sona/core";
import { createNetworkGuard, type NetworkGuard, type PortalRequest } from "./network-guard.js";
import { validateReadOnlyActions } from "./policy.js";
import type { FetchedDocument } from "./provenance.js";
import { PortalSecretRedactor } from "./redaction.js";
import type {
  PortalTaskRunner,
  PortalTaskRunStatus,
  RunPortalTaskInput,
  RunPortalTaskResult,
} from "./runner.js";
import { type PortalTask, type PortalTaskStep, safeParsePortalTask } from "./schema.js";

export interface PortalBrowserProvider {
  providerName: string;
  createSession(input: PortalBrowserSessionInput): Promise<PortalBrowserSession>;
}

export interface PortalBrowserSessionInput {
  task: PortalTask;
  runId: string;
}

export interface PortalBrowserSession {
  page: PortalBrowserPage;
  close(): Promise<void>;
}

export interface PortalConsoleMessage {
  type: string;
  text: string;
}

export interface PortalElementHandle {
  getAttribute(name: string): Promise<string | null>;
  textContent(): Promise<string | null>;
}

export interface PortalBrowserPage {
  route(pattern: string, handler: (request: PortalRequest) => void | Promise<void>): Promise<void>;
  onConsole(handler: (message: PortalConsoleMessage) => void): void;
  goto(url: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  waitForSelector(selector: string, options?: { timeoutMs?: number }): Promise<boolean>;
  queryAll(selector: string): Promise<PortalElementHandle[]>;
  requestBytes(url: string): Promise<PortalDownloadResponse>;
  screenshot?(): Promise<Uint8Array>;
  url(): string;
}

export interface PortalDownloadResponse {
  bytes: Uint8Array;
  mimeType: string;
  finalUrl: string;
}

export interface PortalConnection {
  id: string;
  workspaceId: string;
  taskId: string;
  credentialRefs: Readonly<Record<string, SecretRef>>;
}

export interface GetPortalConnectionInput {
  context: WorkspaceContext;
  connectionId: string;
}

export interface PortalConnectionRepository {
  getConnection(input: GetPortalConnectionInput): Promise<PortalConnection>;
}

export interface PortalDocumentRegistry {
  hasContentHash(input: { workspaceId: string; contentHash: string }): Promise<boolean>;
  recordContentHash(input: {
    workspaceId: string;
    contentHash: string;
    documentId: string;
  }): Promise<void>;
}

export interface LocalPlaywrightPortalTaskRunnerOptions {
  browserProvider?: PortalBrowserProvider;
  documentStorage: DocumentStorage;
  documentRegistry?: PortalDocumentRegistry;
  secretStore: SecretStore;
  connections: PortalConnectionRepository;
}

interface LoadedCredential {
  key: string;
  value: string;
}

interface ExecutionState {
  input: RunPortalTaskInput;
  context: WorkspaceContext;
  result: RunPortalTaskResult;
  credentials: Map<string, string>;
  redactor: PortalSecretRedactor;
  guard: NetworkGuard;
  session: PortalBrowserSession;
  documentStorage: DocumentStorage;
  documentRegistry: PortalDocumentRegistry;
  sensitivePageSeen: boolean;
}

export class LocalPlaywrightPortalTaskRunner implements PortalTaskRunner {
  readonly #browserProvider: PortalBrowserProvider;
  readonly #documentStorage: DocumentStorage;
  readonly #documentRegistry: PortalDocumentRegistry;
  readonly #secretStore: SecretStore;
  readonly #connections: PortalConnectionRepository;

  constructor(options: LocalPlaywrightPortalTaskRunnerOptions) {
    this.#browserProvider = options.browserProvider ?? createLocalPlaywrightBrowserProvider();
    this.#documentStorage = options.documentStorage;
    this.#documentRegistry = options.documentRegistry ?? new InMemoryPortalDocumentRegistry();
    this.#secretStore = options.secretStore;
    this.#connections = options.connections;
  }

  async runTask(input: RunPortalTaskInput): Promise<RunPortalTaskResult> {
    const result = baseResult(input, this.#browserProvider.providerName);
    const parsedTask = safeParsePortalTask(input.task);
    if (!parsedTask.success) {
      result.status = "policy_refused";
      result.errors.push(
        `refused: portal task definition failed validation: ${parsedTask.error.issues
          .map((issue) => issue.message)
          .join("; ")}`,
      );
      return result;
    }

    const policy = validateReadOnlyActions(input.task.allowedActions);
    if (!policy.valid) {
      result.status = "policy_refused";
      for (const violation of policy.violations) {
        result.errors.push(`refused: action "${violation.action}" implies ${violation.concept}`);
      }
      return result;
    }

    const context: WorkspaceContext = { workspaceId: input.workspaceId };
    const connection = await this.#connections.getConnection({
      context,
      connectionId: input.connectionId,
    });
    if (connection.workspaceId !== input.workspaceId || connection.taskId !== input.task.id) {
      result.status = "failed";
      result.errors.push("portal connection does not match the requested workspace/task");
      return result;
    }

    const redactor = new PortalSecretRedactor();
    const credentials = await this.loadCredentials(context, connection, redactor);
    const guard = createNetworkGuard({ task: input.task });
    const session = await this.#browserProvider.createSession({
      task: input.task,
      runId: input.runId,
    });

    const state: ExecutionState = {
      input,
      context,
      result,
      credentials,
      redactor,
      guard,
      session,
      documentStorage: this.#documentStorage,
      documentRegistry: this.#documentRegistry,
      sensitivePageSeen: false,
    };

    try {
      await wirePageGuards(state);
      for (const step of input.task.steps) {
        const status = await executeStep(state, step);
        if (status !== "completed") {
          result.status = status;
          break;
        }
      }
    } catch (error) {
      result.status = "failed";
      result.errors.push(redactor.redactText(errorMessage(error)));
    } finally {
      await session.close();
      const snapshot = guard.snapshot();
      result.provenance.blockedRequests = snapshot.blockedRequests;
      result.provenance.allowedNonIdempotentRequests = snapshot.allowedNonIdempotentRequests;
      if (result.provenance.consoleMessages !== undefined) {
        result.provenance.consoleMessages = result.provenance.consoleMessages.map((message) =>
          redactor.redactConsoleMessage(message),
        );
      }
      if (result.status === "completed" && snapshot.blockedRequests.length > 0) {
        result.status = "blocked";
      }
    }

    return result;
  }

  private async loadCredentials(
    context: WorkspaceContext,
    connection: PortalConnection,
    redactor: PortalSecretRedactor,
  ): Promise<Map<string, string>> {
    const credentials = new Map<string, string>();
    const loaded: LoadedCredential[] = [];
    for (const [key, ref] of Object.entries(connection.credentialRefs)) {
      const secret = await this.#secretStore.getSecret({ context, ref });
      const value = secret.reveal();
      redactor.addSecret(value);
      loaded.push({ key, value });
    }
    for (const credential of loaded) {
      credentials.set(credential.key, credential.value);
    }
    return credentials;
  }
}

export class InMemoryPortalConnectionRepository implements PortalConnectionRepository {
  readonly #connections = new Map<string, PortalConnection>();

  constructor(connections: readonly PortalConnection[] = []) {
    for (const connection of connections) {
      this.#connections.set(
        connectionKey(connection.workspaceId, connection.id),
        freezeConnection(connection),
      );
    }
  }

  async getConnection(input: GetPortalConnectionInput): Promise<PortalConnection> {
    const connection = this.#connections.get(
      connectionKey(input.context.workspaceId, input.connectionId),
    );
    if (connection === undefined) {
      throw new Error(`Portal connection not found: ${input.connectionId}`);
    }
    return freezeConnection(connection);
  }
}

export class InMemoryPortalDocumentRegistry implements PortalDocumentRegistry {
  readonly #hashes = new Map<string, string>();

  async hasContentHash(input: { workspaceId: string; contentHash: string }): Promise<boolean> {
    return this.#hashes.has(documentHashKey(input.workspaceId, input.contentHash));
  }

  async recordContentHash(input: {
    workspaceId: string;
    contentHash: string;
    documentId: string;
  }): Promise<void> {
    this.#hashes.set(documentHashKey(input.workspaceId, input.contentHash), input.documentId);
  }
}

async function wirePageGuards(state: ExecutionState): Promise<void> {
  await state.session.page.route("**/*", async (request) => {
    const decision = state.guard.evaluateRequest(request);
    if (decision.action === "abort") {
      throw new Error(`blocked request: ${decision.reason} ${request.method} ${request.url}`);
    }
  });
  state.session.page.onConsole((message) => {
    const redacted = state.redactor.redactConsoleMessage(message);
    state.result.provenance.consoleMessages = [
      ...(state.result.provenance.consoleMessages ?? []),
      redacted,
    ];
  });
}

async function executeStep(
  state: ExecutionState,
  step: PortalTaskStep,
): Promise<PortalTaskRunStatus> {
  if (step.sensitive === true) {
    state.sensitivePageSeen = true;
  }

  switch (step.kind) {
    case "navigate":
      await state.session.page.goto(step.url);
      return "completed";
    case "fill": {
      const value = state.credentials.get(step.credentialKey);
      if (value === undefined) {
        state.result.errors.push(`missing credential: ${step.credentialKey}`);
        return "failed";
      }
      await state.session.page.fill(step.selector, value);
      return "completed";
    }
    case "click":
      await state.session.page.click(step.selector);
      return "completed";
    case "waitForSelector": {
      const found = await state.session.page.waitForSelector(step.selector, {
        timeoutMs: step.timeoutMs,
      });
      if (!found) {
        state.result.errors.push(`selector_missing: ${step.selector}`);
        await captureFailureArtifact(state);
        return "selector_missing";
      }
      return "completed";
    }
    case "downloadLinks":
      return await downloadLinks(state, step);
  }
}

async function downloadLinks(
  state: ExecutionState,
  step: Extract<PortalTaskStep, { kind: "downloadLinks" }>,
): Promise<PortalTaskRunStatus> {
  const elements = await state.session.page.queryAll(step.selector);
  if (elements.length === 0) {
    state.result.errors.push(`selector_missing: ${step.selector}`);
    await captureFailureArtifact(state);
    return "selector_missing";
  }

  let storedIndex = 0;
  for (const element of elements) {
    const rawHref = await element.getAttribute(step.hrefAttribute);
    if (rawHref === null || rawHref.trim().length === 0) {
      continue;
    }
    const href = resolveUrl(rawHref, state.session.page.url());
    const decision = state.guard.evaluateRequest({
      url: href,
      method: "GET",
      resourceType: "document",
    });
    if (decision.action === "abort") {
      state.result.warnings.push(`download blocked: ${decision.reason}`);
      continue;
    }
    const response = await state.session.page.requestBytes(href);
    const contentHash = sha256Hex(response.bytes);
    if (
      await state.documentRegistry.hasContentHash({
        workspaceId: state.input.workspaceId,
        contentHash,
      })
    ) {
      continue;
    }

    const filename = await resolveFilename(element, step, href, storedIndex);
    const document = makeFetchedDocument(state, {
      filename,
      mimeType: response.mimeType || step.mimeType,
      contentHash,
      sourceUrl: response.finalUrl,
      bytes: response.bytes,
    });
    const stored = await storeDocument(state, document, storedIndex);
    await state.documentRegistry.recordContentHash({
      workspaceId: state.input.workspaceId,
      contentHash,
      documentId: stored.id,
    });
    state.result.documents.push(document);
    state.result.storedDocuments.push(stored);
    storedIndex += 1;
  }

  return "completed";
}

async function captureFailureArtifact(state: ExecutionState): Promise<void> {
  if (state.sensitivePageSeen || state.session.page.screenshot === undefined) {
    return;
  }
  const screenshot = await state.session.page.screenshot();
  const hash = sha256Hex(screenshot);
  state.result.warnings.push(`failure screenshot captured: ${hash}`);
}

interface FetchedDocumentInput {
  filename: string;
  mimeType: string;
  contentHash: string;
  sourceUrl: string;
  bytes: Uint8Array;
}

function makeFetchedDocument(state: ExecutionState, input: FetchedDocumentInput): FetchedDocument {
  const domain = state.input.task.domains[0] ?? "unknown";
  return {
    filename: state.redactor.redactText(input.filename),
    mimeType: input.mimeType,
    contentHash: input.contentHash,
    sourceUrl: sanitizeUrl(input.sourceUrl),
    content: { kind: "bytes", bytes: new Uint8Array(input.bytes) },
    provenance: {
      sourcePortal: domain,
      taskId: state.input.task.id,
      taskVersion: state.input.task.version,
      runId: state.input.runId,
      sourceUrl: sanitizeUrl(input.sourceUrl) ?? undefined,
      downloadedFilename: state.redactor.redactText(input.filename),
      contentHash: input.contentHash,
      fetchedAt: state.input.now,
      browserProvider: state.result.provenance.browserProvider,
      workspaceId: state.input.workspaceId,
      extractionStatus: "pending",
    },
  };
}

async function storeDocument(
  state: ExecutionState,
  document: FetchedDocument,
  index: number,
): Promise<StoredDocument> {
  if (document.content.kind !== "bytes") {
    throw new Error("Playwright runner only stores in-memory download bytes");
  }
  const id = `portal_${state.input.connectionId}_${document.contentHash.slice(0, 16)}`;
  const metadata = state.redactor.metadata({
    "portal.runId": state.input.runId,
    "portal.taskId": state.input.task.id,
    "portal.taskVersion": String(state.input.task.version),
    "portal.sourceUrl": document.sourceUrl ?? "",
    "portal.filename": document.filename,
    "portal.index": String(index),
  });
  return await state.documentStorage.put({
    context: state.context,
    id,
    bytes: document.content.bytes,
    contentType: document.mimeType,
    originalFilename: document.filename,
    createdAt: state.input.now,
    metadata,
  });
}

function baseResult(input: RunPortalTaskInput, provider: string): RunPortalTaskResult {
  const domain = input.task.domains[0] ?? "unknown";
  return {
    status: "completed",
    runId: input.runId,
    taskId: input.task.id,
    taskVersion: input.task.version,
    documents: [],
    storedDocuments: [],
    provenance: {
      runId: input.runId,
      taskId: input.task.id,
      taskVersion: input.task.version,
      portalDomain: domain,
      browserProvider: provider,
      workspaceId: input.workspaceId,
      fetchedAt: input.now,
      blockedRequests: [],
      allowedNonIdempotentRequests: [],
      consoleMessages: [],
    },
    warnings: [],
    errors: [],
  };
}

function resolveUrl(rawHref: string, baseUrl: string): string {
  return new URL(rawHref, baseUrl).toString();
}

async function resolveFilename(
  element: PortalElementHandle,
  step: Extract<PortalTaskStep, { kind: "downloadLinks" }>,
  href: string,
  index: number,
): Promise<string> {
  if (step.filenameAttribute !== undefined) {
    const value = await element.getAttribute(step.filenameAttribute);
    if (value !== null && value.trim().length > 0) {
      return value;
    }
  }
  const text = await element.textContent();
  if (text !== null && text.trim().length > 0) {
    return text.trim();
  }
  const pathname = new URL(href).pathname;
  const basename = pathname.split("/").filter(Boolean).at(-1);
  return basename ?? `portal-document-${index + 1}.pdf`;
}

function sanitizeUrl(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return undefined;
  }
}

function connectionKey(workspaceId: string, connectionId: string): string {
  return `${workspaceId}:${connectionId}`;
}

function documentHashKey(workspaceId: string, contentHash: string): string {
  return `${workspaceId}:${contentHash}`;
}

function freezeConnection(connection: PortalConnection): PortalConnection {
  return Object.freeze({
    ...connection,
    credentialRefs: Object.freeze({ ...connection.credentialRefs }),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createLocalPlaywrightBrowserProvider(): PortalBrowserProvider {
  return new DynamicPlaywrightBrowserProvider("local-playwright", undefined);
}

export function createCdpPlaywrightBrowserProvider(
  providerName: string,
  cdpEndpoint: string,
): PortalBrowserProvider {
  return new DynamicPlaywrightBrowserProvider(providerName, cdpEndpoint);
}

type DynamicImport = (specifier: string) => Promise<unknown>;

const dynamicImport = new Function("specifier", "return import(specifier)") as DynamicImport;

interface PlaywrightModule {
  chromium: {
    launch(options: { headless: boolean }): Promise<PlaywrightBrowser>;
    connectOverCDP(endpoint: string): Promise<PlaywrightBrowser>;
  };
}

interface PlaywrightBrowser {
  newContext(options: { acceptDownloads: boolean }): Promise<PlaywrightContext>;
  close(): Promise<void>;
}

interface PlaywrightContext {
  newPage(): Promise<PlaywrightPage>;
  request: {
    get(url: string): Promise<PlaywrightResponse>;
  };
  close(): Promise<void>;
}

interface PlaywrightPage {
  route(pattern: string, handler: (route: PlaywrightRoute) => Promise<void>): Promise<void>;
  on(event: "console", handler: (message: PlaywrightConsoleMessage) => void): void;
  goto(url: string): Promise<unknown>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  waitForSelector(selector: string, options: { timeout?: number }): Promise<unknown | null>;
  $$(selector: string): Promise<PlaywrightElement[]>;
  screenshot(): Promise<Buffer>;
  url(): string;
}

interface PlaywrightRoute {
  request(): {
    url(): string;
    method(): string;
    resourceType(): string;
  };
  continue(): Promise<void>;
  abort(): Promise<void>;
}

interface PlaywrightConsoleMessage {
  type(): string;
  text(): string;
}

interface PlaywrightElement {
  getAttribute(name: string): Promise<string | null>;
  textContent(): Promise<string | null>;
}

interface PlaywrightResponse {
  body(): Promise<Buffer>;
  headers(): Record<string, string>;
  url(): string;
}

class DynamicPlaywrightBrowserProvider implements PortalBrowserProvider {
  readonly providerName: string;
  readonly #cdpEndpoint: string | undefined;

  constructor(providerName: string, cdpEndpoint: string | undefined) {
    this.providerName = providerName;
    this.#cdpEndpoint = cdpEndpoint;
  }

  async createSession(): Promise<PortalBrowserSession> {
    const module = await loadPlaywrightModule();
    const browser =
      this.#cdpEndpoint === undefined
        ? await module.chromium.launch({ headless: true })
        : await module.chromium.connectOverCDP(this.#cdpEndpoint);
    const context = await browser.newContext({ acceptDownloads: false });
    const page = await context.newPage();
    return {
      page: new PlaywrightPageAdapter(page, context),
      close: async () => {
        await context.close();
        await browser.close();
      },
    };
  }
}

async function loadPlaywrightModule(): Promise<PlaywrightModule> {
  const loaded = await dynamicImport("playwright");
  if (!isPlaywrightModule(loaded)) {
    throw new Error("playwright module is not available");
  }
  return loaded;
}

function isPlaywrightModule(value: unknown): value is PlaywrightModule {
  if (!isObject(value)) {
    return false;
  }
  const chromium = value["chromium"];
  return (
    isObject(chromium) &&
    typeof chromium["launch"] === "function" &&
    typeof chromium["connectOverCDP"] === "function"
  );
}

class PlaywrightPageAdapter implements PortalBrowserPage {
  readonly #page: PlaywrightPage;
  readonly #context: PlaywrightContext;

  constructor(page: PlaywrightPage, context: PlaywrightContext) {
    this.#page = page;
    this.#context = context;
  }

  async route(
    pattern: string,
    handler: (request: PortalRequest) => void | Promise<void>,
  ): Promise<void> {
    await this.#page.route(pattern, async (route) => {
      const request = route.request();
      try {
        await handler({
          url: request.url(),
          method: request.method(),
          resourceType: request.resourceType(),
        });
        await route.continue();
      } catch {
        await route.abort();
      }
    });
  }

  onConsole(handler: (message: PortalConsoleMessage) => void): void {
    this.#page.on("console", (message) => {
      handler({
        type: message.type(),
        text: message.text(),
      });
    });
  }

  async goto(url: string): Promise<void> {
    await this.#page.goto(url);
  }

  async fill(selector: string, value: string): Promise<void> {
    await this.#page.fill(selector, value);
  }

  async click(selector: string): Promise<void> {
    await this.#page.click(selector);
  }

  async waitForSelector(selector: string, options: { timeoutMs?: number } = {}): Promise<boolean> {
    const found = await this.#page.waitForSelector(selector, { timeout: options.timeoutMs });
    return found !== null;
  }

  async queryAll(selector: string): Promise<PortalElementHandle[]> {
    return await this.#page.$$(selector);
  }

  async requestBytes(url: string): Promise<PortalDownloadResponse> {
    const response = await this.#context.request.get(url);
    const headers = response.headers();
    return {
      bytes: new Uint8Array(await response.body()),
      mimeType: headers["content-type"] ?? "application/octet-stream",
      finalUrl: response.url(),
    };
  }

  async screenshot(): Promise<Uint8Array> {
    return new Uint8Array(await this.#page.screenshot());
  }

  url(): string {
    return this.#page.url();
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
