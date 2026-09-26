import {
  type DocumentStorage,
  type SecretRef,
  type SecretStore,
  type StoredDocument,
  sha256Hex,
  type WorkspaceContext,
} from "@sona/core";
import { parseContentLength, readBodyWithLimit } from "./download.js";
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
  /**
   * Values the provider itself must keep out of run output, such as a CDP
   * endpoint carrying an API token. The runner registers them with the run
   * redactor before the session is created so setup failures are redacted too.
   */
  sensitiveValues?: readonly string[];
  createSession(input: PortalBrowserSessionInput): Promise<PortalBrowserSession>;
}

export interface PortalBrowserSessionInput {
  task: PortalTask;
  runId: string;
}

/**
 * A guarded browser session. `route` must see every request the session can
 * make, including popups and WebSocket handshakes, before it leaves the
 * browser; a handler that throws aborts the request.
 */
export interface PortalBrowserSession {
  page: PortalBrowserPage;
  route(pattern: string, handler: (request: PortalRequest) => void | Promise<void>): Promise<void>;
  close(): Promise<void>;
}

export interface PortalElementHandle {
  getAttribute(name: string): Promise<string | null>;
  textContent(): Promise<string | null>;
}

export interface PortalBrowserPage {
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
  /** Per-document byte cap for downloads; defaults to 10 MiB. */
  maxDownloadBytes?: number;
}

interface LoadedCredential {
  key: string;
  value: string;
}

const MAX_DOWNLOAD_DOCUMENTS_PER_RUN = 50;
const DEFAULT_MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const MAX_DOWNLOAD_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 60_000;

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
  maxDownloadBytes: number;
  sensitivePageSeen: boolean;
}

export class LocalPlaywrightPortalTaskRunner implements PortalTaskRunner {
  readonly #browserProvider: PortalBrowserProvider;
  readonly #documentStorage: DocumentStorage;
  readonly #documentRegistry: PortalDocumentRegistry;
  readonly #secretStore: SecretStore;
  readonly #connections: PortalConnectionRepository;
  readonly #maxDownloadBytes: number;

  constructor(options: LocalPlaywrightPortalTaskRunnerOptions) {
    this.#browserProvider = options.browserProvider ?? createLocalPlaywrightBrowserProvider();
    this.#documentStorage = options.documentStorage;
    this.#documentRegistry = options.documentRegistry ?? new InMemoryPortalDocumentRegistry();
    this.#secretStore = options.secretStore;
    this.#connections = options.connections;
    this.#maxDownloadBytes = options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
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
    for (const value of this.#browserProvider.sensitiveValues ?? []) {
      redactor.addSecret(value);
    }
    const guard = createNetworkGuard({ task });
    let session: PortalBrowserSession | undefined;
    let blockedBeforeStep = 0;

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
        maxDownloadBytes: this.#maxDownloadBytes,
        sensitivePageSeen: false,
      };

      await wireNetworkGuard(state);
      for (const step of task.steps) {
        blockedBeforeStep = guard.snapshot().blockedRequests.length;
        const status = await executeStep(state, step);
        if (status !== "completed") {
          result.status = status;
          break;
        }
      }
    } catch (error) {
      // A route abort surfaces as a rejected goto/click; report it as the
      // policy block it is rather than a generic execution failure.
      result.status =
        guard.snapshot().blockedRequests.length > blockedBeforeStep ? "blocked" : "failed";
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

async function wireNetworkGuard(state: ExecutionState): Promise<void> {
  await state.session.route("**/*", async (request) => {
    const decision = state.guard.evaluateRequest(request);
    if (decision.action === "abort") {
      throw new Error(`blocked request: ${decision.reason} ${request.method} ${request.url}`);
    }
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
  let usableLinks = 0;
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
    usableLinks += 1;
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
        maxBytes: state.maxDownloadBytes,
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

  // Matching elements without a usable link mean the portal markup changed
  // under the selector; a silent empty run would hide a broken fetch.
  if (usableLinks === 0) {
    state.result.errors.push(
      `selector_missing: no usable "${step.hrefAttribute}" on ${step.selector}`,
    );
    await captureFailureArtifact(state);
    return "selector_missing";
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

/**
 * The result skeleton is built before the task is validated so a malformed
 * definition still yields a structured `policy_refused` result; task identity
 * is therefore read defensively from the unvalidated input.
 */
function baseResult(input: RunPortalTaskInput, provider: string): RunPortalTaskResult {
  const identity = taskIdentity(input.task);
  return {
    status: "completed",
    runId: input.runId,
    taskId: identity.id,
    taskVersion: identity.version,
    documents: [],
    storedDocuments: [],
    provenance: {
      runId: input.runId,
      taskId: identity.id,
      taskVersion: identity.version,
      portalDomain: identity.domain,
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

interface TaskIdentity {
  id: string;
  version: number;
  domain: string;
}

function taskIdentity(task: unknown): TaskIdentity {
  const raw: Record<string, unknown> = isObject(task) ? task : {};
  const domains = Array.isArray(raw["domains"]) ? raw["domains"] : [];
  const firstDomain: unknown = domains[0];
  return {
    id: typeof raw["id"] === "string" ? raw["id"] : "unknown",
    version: typeof raw["version"] === "number" ? raw["version"] : 0,
    domain: typeof firstDomain === "string" ? firstDomain : "unknown",
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

/**
 * Resolved at runtime rather than imported statically so `@sona/agents` loads
 * without the optional `playwright` peer; the module shape is narrowed below
 * instead of relying on Playwright's own types.
 */
const PLAYWRIGHT_SPECIFIER = "playwright";

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
  routeWebSocket(
    matcher: (url: URL) => boolean,
    handler: (route: PlaywrightWebSocketRoute) => void | Promise<void>,
  ): Promise<void>;
  cookies(urls: readonly string[]): Promise<PlaywrightCookie[]>;
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

interface PlaywrightCookie {
  name: string;
  value: string;
}

interface PlaywrightWebSocketRoute {
  url(): string;
  connectToServer(): unknown;
  close(): Promise<void>;
}

interface PlaywrightPage {
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

interface PlaywrightElement {
  getAttribute(name: string): Promise<string | null>;
  textContent(): Promise<string | null>;
}

class DynamicPlaywrightBrowserProvider implements PortalBrowserProvider {
  readonly providerName: string;
  readonly sensitiveValues: readonly string[];
  readonly #cdpEndpoint: string | undefined;

  constructor(providerName: string, cdpEndpoint: string | undefined) {
    this.providerName = providerName;
    this.#cdpEndpoint = cdpEndpoint;
    this.sensitiveValues = cdpEndpoint === undefined ? [] : cdpEndpointSecrets(cdpEndpoint);
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

/**
 * A CDP endpoint is a secret in its own right, and so are the token-shaped
 * parts it is built from, in case an error echoes only one of them.
 */
function cdpEndpointSecrets(endpoint: string): string[] {
  const secrets = new Set<string>([endpoint]);
  try {
    const url = new URL(endpoint);
    if (url.password.length > 0) {
      secrets.add(url.password);
    }
    for (const value of url.searchParams.values()) {
      if (value.length >= MIN_TOKEN_LENGTH) {
        secrets.add(value);
      }
    }
  } catch {
    // Not a URL; the full string is still redacted.
  }
  return [...secrets];
}

const MIN_TOKEN_LENGTH = 8;

async function loadPlaywrightModule(): Promise<PlaywrightModule> {
  let loaded: unknown;
  try {
    loaded = await import(PLAYWRIGHT_SPECIFIER);
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

  /**
   * Installs the guard on the browser context so popups are covered from their
   * first request, and on WebSocket handshakes, which `route` does not see.
   */
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
    // A glob such as `**/*` does not match `ws://` URLs in Playwright, so the
    // WebSocket route uses a predicate that intercepts every handshake.
    await this.#context.routeWebSocket(matchEveryUrl, async (route) => {
      try {
        await handler({ url: route.url(), method: "GET", resourceType: "websocket" });
        route.connectToServer();
      } catch {
        await route.close();
      }
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

  /**
   * Downloads with Node's streaming `fetch` rather than Playwright's request
   * API, which buffers the whole body before exposing it. Each hop carries the
   * browser session's cookies for that URL, follows redirects one at a time so
   * every target is re-evaluated by the guard, and stops reading the body the
   * moment it crosses the byte cap.
   */
  async requestBytes(
    url: string,
    options: PortalDownloadRequestOptions,
  ): Promise<PortalDownloadResponse> {
    let currentUrl = url;
    let redirectsFollowed = 0;
    while (true) {
      const response = await fetch(currentUrl, {
        method: "GET",
        headers: await this.downloadHeaders(currentUrl, options.expectedMimeType),
        redirect: "manual",
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      const status = response.status;
      if (isRedirectStatus(status)) {
        await response.body?.cancel();
        if (redirectsFollowed >= options.maxRedirects) {
          throw new Error(`download exceeded ${options.maxRedirects} redirects`);
        }
        const location = response.headers.get("location");
        if (location === null) {
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

      const mimeType = response.headers.get("content-type") ?? "application/octet-stream";
      if (!isSuccessfulStatus(status)) {
        await response.body?.cancel();
        throw new Error(`download failed with status ${status}`);
      }
      if (!isExpectedMimeType(mimeType, options.expectedMimeType)) {
        await response.body?.cancel();
        throw new Error(
          `download returned unexpected content type ${mimeType}; expected ${options.expectedMimeType}`,
        );
      }
      const contentLength = parseContentLength(response.headers.get("content-length"));
      if (contentLength !== undefined && contentLength > options.maxBytes) {
        await response.body?.cancel();
        throw new Error(`download exceeds ${options.maxBytes} byte limit`);
      }
      const bytes = await readBodyWithLimit(response.body, options.maxBytes);
      return { bytes, mimeType, finalUrl: currentUrl, status };
    }
  }

  private async downloadHeaders(
    url: string,
    expectedMimeType: string,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = { accept: `${expectedMimeType}, */*;q=0.1` };
    const cookies = await this.#context.cookies([url]);
    if (cookies.length > 0) {
      headers["cookie"] = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    }
    return headers;
  }

  async screenshot(): Promise<Uint8Array> {
    return new Uint8Array(await this.#page.screenshot());
  }

  url(): string {
    return this.#page.url();
  }
}

function matchEveryUrl(): boolean {
  return true;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

function isSelectorTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === "TimeoutError" || /timeout/i.test(error.message);
}
