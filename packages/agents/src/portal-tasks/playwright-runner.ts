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
  route(pattern: string, handler: (request: PortalRequest) => void | Promise<void>): Promise<void>;
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
  requestBytes(url: string, options: PortalDownloadRequestOptions): Promise<PortalDownloadResponse>;
  screenshot?(): Promise<Uint8Array>;
  url(): string;
}

export interface PortalDownloadRequestOptions {
  expectedMimeType: string;
  maxBytes: number;
  maxRedirects: number;
  onRedirect(url: string): boolean;
}

export interface PortalDownloadResponse {
  bytes: Uint8Array;
  mimeType: string;
  finalUrl: string;
  status: number;
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

const MAX_DOWNLOAD_DOCUMENTS_PER_RUN = 50;
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const MAX_DOWNLOAD_REDIRECTS = 5;

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
    const task = parsedTask.data;
    const runInput: RunPortalTaskInput = { ...input, task };

    const policy = validateReadOnlyActions(task.allowedActions);
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
    if (connection.workspaceId !== input.workspaceId || connection.taskId !== task.id) {
      result.status = "failed";
      result.errors.push("portal connection does not match the requested workspace/task");
      return result;
    }

    const redactor = new PortalSecretRedactor();
    const guard = createNetworkGuard({ task });
    let session: PortalBrowserSession | undefined;

    try {
      const credentials = await this.loadCredentials(context, connection, redactor);
      session = await this.#browserProvider.createSession({
        task,
        runId: input.runId,
      });

      const state: ExecutionState = {
        input: runInput,
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

      await wirePageGuards(state);
      for (const step of task.steps) {
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
      if (session !== undefined) {
        try {
          await session.close();
        } catch (error) {
          result.status = "failed";
          result.errors.push(redactor.redactText(errorMessage(error)));
        }
      }
      const snapshot = guard.snapshot();
      result.provenance.blockedRequests = snapshot.blockedRequests;
      result.provenance.allowedNonIdempotentRequests = snapshot.allowedNonIdempotentRequests;
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
  await state.session.route("**/*", async (request) => {
    const decision = state.guard.evaluateRequest(request);
    if (decision.action === "abort") {
      throw new Error(`blocked request: ${decision.reason} ${request.method} ${request.url}`);
    }
  });
  state.session.page.onConsole(() => undefined);
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
      let found: boolean;
      try {
        found = await state.session.page.waitForSelector(step.selector, {
          timeoutMs: step.timeoutMs,
        });
      } catch (error) {
        if (!isSelectorTimeoutError(error)) {
          throw error;
        }
        found = false;
      }
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
  if (elements.length > MAX_DOWNLOAD_DOCUMENTS_PER_RUN) {
    state.result.warnings.push(
      `download link count limited to ${MAX_DOWNLOAD_DOCUMENTS_PER_RUN} documents`,
    );
  }

  for (const element of elements.slice(0, MAX_DOWNLOAD_DOCUMENTS_PER_RUN)) {
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
    const blockedCountBeforeDownload = state.guard.snapshot().blockedRequests.length;
    let response: PortalDownloadResponse;
    try {
      response = await state.session.page.requestBytes(href, {
        expectedMimeType: step.mimeType,
        maxBytes: MAX_DOWNLOAD_BYTES,
        maxRedirects: MAX_DOWNLOAD_REDIRECTS,
        onRedirect: (redirectUrl) => {
          const redirectDecision = state.guard.evaluateRequest({
            url: redirectUrl,
            method: "GET",
            resourceType: "document",
          });
          return redirectDecision.action === "allow";
        },
      });
    } catch (error) {
      state.result.errors.push(state.redactor.redactText(errorMessage(error)));
      return state.guard.snapshot().blockedRequests.length > blockedCountBeforeDownload
        ? "blocked"
        : "failed";
    }

    const finalDecision = state.guard.evaluateRequest({
      url: response.finalUrl,
      method: "GET",
      resourceType: "document",
    });
    if (finalDecision.action === "abort") {
      state.result.warnings.push(`download blocked after redirect: ${finalDecision.reason}`);
      return "blocked";
    }
    if (!isSuccessfulStatus(response.status)) {
      state.result.errors.push(`download failed with status ${response.status}`);
      return "failed";
    }
    if (!isExpectedMimeType(response.mimeType, step.mimeType)) {
      state.result.errors.push(
        `download returned unexpected content type ${response.mimeType}; expected ${step.mimeType}`,
      );
      return "failed";
    }

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
    state.result.storedDocuments.push(stored);
    state.result.documents.push(stripFetchedDocumentContent(document, stored));
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

function stripFetchedDocumentContent(
  document: FetchedDocument,
  stored: StoredDocument,
): FetchedDocument {
  return {
    ...document,
    content: { kind: "objectRef", uri: `stored-document:${stored.id}` },
  };
}

function isSuccessfulStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function isExpectedMimeType(actual: string, expected: string): boolean {
  return mediaType(actual) === mediaType(expected);
}

function mediaType(contentType: string): string {
  return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
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
  newContext(options: {
    acceptDownloads: boolean;
    serviceWorkers: "allow" | "block";
  }): Promise<PlaywrightContext>;
  close(): Promise<void>;
}

interface PlaywrightContext {
  route(pattern: string, handler: (route: PlaywrightRoute) => Promise<void>): Promise<void>;
  newPage(): Promise<PlaywrightPage>;
  request: {
    get(url: string, options: { maxRedirects: number }): Promise<PlaywrightResponse>;
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
  status(): number;
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
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    const adaptedPage = new PlaywrightPageAdapter(page, context);
    return {
      page: adaptedPage,
      route: async (pattern, handler) => {
        await adaptedPage.route(pattern, handler);
      },
      close: async () => {
        await context.close();
        await browser.close();
      },
    };
  }
}

async function loadPlaywrightModule(): Promise<PlaywrightModule> {
  let loaded: unknown;
  try {
    loaded = await dynamicImport("playwright");
  } catch (error) {
    throw new Error(
      `playwright module is required for the default portal browser provider; install the optional peer dependency "playwright" or inject a PortalBrowserProvider: ${errorMessage(error)}`,
    );
  }
  if (!isPlaywrightModule(loaded)) {
    throw new Error(
      'playwright module is required for the default portal browser provider but did not expose chromium; install the optional peer dependency "playwright" or inject a PortalBrowserProvider',
    );
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
    await this.#context.route(pattern, async (route) => {
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
    try {
      const found = await this.#page.waitForSelector(selector, { timeout: options.timeoutMs });
      return found !== null;
    } catch (error) {
      if (isSelectorTimeoutError(error)) {
        return false;
      }
      throw error;
    }
  }

  async queryAll(selector: string): Promise<PortalElementHandle[]> {
    return await this.#page.$$(selector);
  }

  async requestBytes(
    url: string,
    options: PortalDownloadRequestOptions,
  ): Promise<PortalDownloadResponse> {
    let currentUrl = url;
    let redirectsFollowed = 0;
    while (true) {
      const response = await this.#context.request.get(currentUrl, { maxRedirects: 0 });
      const status = response.status();
      const headers = response.headers();
      if (isRedirectStatus(status)) {
        if (redirectsFollowed >= options.maxRedirects) {
          throw new Error(`download exceeded ${options.maxRedirects} redirects`);
        }
        const location = getHeader(headers, "location");
        if (location === undefined) {
          throw new Error(`download redirect ${status} missing Location header`);
        }
        const nextUrl = resolveUrl(location, currentUrl);
        if (!options.onRedirect(nextUrl)) {
          throw new Error("download redirect blocked by portal network policy");
        }
        currentUrl = nextUrl;
        redirectsFollowed += 1;
        continue;
      }

      const mimeType = getHeader(headers, "content-type") ?? "application/octet-stream";
      if (!isSuccessfulStatus(status)) {
        throw new Error(`download failed with status ${status}`);
      }
      if (!isExpectedMimeType(mimeType, options.expectedMimeType)) {
        throw new Error(
          `download returned unexpected content type ${mimeType}; expected ${options.expectedMimeType}`,
        );
      }
      const contentLength = parseContentLength(getHeader(headers, "content-length"));
      if (contentLength !== undefined && contentLength > options.maxBytes) {
        throw new Error(`download exceeds ${options.maxBytes} byte limit`);
      }
      const body = await response.body();
      if (body.byteLength > options.maxBytes) {
        throw new Error(`download exceeds ${options.maxBytes} byte limit`);
      }
      return {
        bytes: new Uint8Array(body),
        mimeType,
        finalUrl: response.url(),
        status,
      };
    }
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

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

function getHeader(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected) {
      return value;
    }
  }
  return undefined;
}

function parseContentLength(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function isSelectorTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === "TimeoutError" || /timeout/i.test(error.message);
}
