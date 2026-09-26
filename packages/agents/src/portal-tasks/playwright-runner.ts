import {
  type DocumentStorage,
  type SecretRef,
  type SecretStore,
  type StoredDocument,
  sha256Hex,
  type WorkspaceContext,
} from "@sona/core";
import type {
  PortalBrowserProvider,
  PortalBrowserSession,
  PortalDownloadResponse,
  PortalElementHandle,
} from "./browser.js";
import { isSelectorTimeoutError } from "./browser.js";
import { isExpectedMimeType, isSuccessfulStatus } from "./download.js";
import {
  createNetworkGuard,
  type NetworkGuard,
  type PortalRequestDecision,
} from "./network-guard.js";
import { createLocalPlaywrightBrowserProvider } from "./playwright-adapter.js";
import { validateReadOnlyActions } from "./policy.js";
import type { FetchedDocument } from "./provenance.js";
import { PortalSecretRedactor } from "./redaction.js";
import {
  createBaseRunResult,
  type PortalTaskRunner,
  type PortalTaskRunStatus,
  type RunPortalTaskInput,
  type RunPortalTaskResult,
} from "./runner.js";
import { type PortalTaskStep, safeParsePortalTask } from "./schema.js";
import { resolveUrl, sanitizeUrl } from "./url.js";

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

const MAX_DOWNLOAD_DOCUMENTS_PER_RUN = 50;
const DEFAULT_MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
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
    const result = createBaseRunResult(input, this.#browserProvider.providerName);
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
    for (const [key, ref] of Object.entries(connection.credentialRefs)) {
      const secret = await this.#secretStore.getSecret({ context, ref });
      const value = secret.reveal();
      redactor.addSecret(value);
      credentials.set(key, value);
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

type DownloadLinksStep = Extract<PortalTaskStep, { kind: "downloadLinks" }>;

async function downloadLinks(
  state: ExecutionState,
  step: DownloadLinksStep,
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
    const decision = evaluateDownloadUrl(state, href);
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
        onRedirect: (redirectUrl) => evaluateDownloadUrl(state, redirectUrl).action === "allow",
      });
    } catch (error) {
      state.result.errors.push(state.redactor.redactText(errorMessage(error)));
      return state.guard.snapshot().blockedRequests.length > blockedCountBeforeDownload
        ? "blocked"
        : "failed";
    }

    const finalDecision = evaluateDownloadUrl(state, response.finalUrl);
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

function evaluateDownloadUrl(state: ExecutionState, url: string): PortalRequestDecision {
  return state.guard.evaluateRequest({ url, method: "GET", resourceType: "document" });
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
  const sourceUrl = sanitizeUrl(input.sourceUrl);
  const filename = state.redactor.redactText(input.filename);
  return {
    filename,
    mimeType: input.mimeType,
    contentHash: input.contentHash,
    sourceUrl,
    content: { kind: "bytes", bytes: new Uint8Array(input.bytes) },
    provenance: {
      sourcePortal: domain,
      taskId: state.input.task.id,
      taskVersion: state.input.task.version,
      runId: state.input.runId,
      sourceUrl,
      downloadedFilename: filename,
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

async function resolveFilename(
  element: PortalElementHandle,
  step: DownloadLinksStep,
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
