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
import { documentBytesProblem, isExpectedMimeType, isSuccessfulStatus } from "./download.js";
import {
  createNetworkGuard,
  type NetworkGuard,
  type PortalRequestDecision,
} from "./network-guard.js";
import { createLocalPlaywrightBrowserProvider } from "./playwright-adapter.js";
import { validateReadOnlyActions } from "./policy.js";
import { type FetchedDocument, STORED_DOCUMENT_URI_SCHEME } from "./provenance.js";
import { PortalSecretRedactor } from "./redaction.js";
import {
  createInitialRunResult,
  type PortalTaskRunner,
  type PortalTaskRunStatus,
  type RunPortalTaskInput,
  type RunPortalTaskResult,
} from "./runner.js";
import { type PortalTaskStep, portalTaskDigest, safeParsePortalTask } from "./schema.js";
import { redactSensitiveUrlPath, resolveUrl, sanitizeUrl, sanitizeUrlsInText } from "./url.js";

/**
 * A user's approval to run one reviewed task revision with stored credentials.
 * `taskDigest` pins the exact definition (domains and steps included) so a
 * later revision cannot reuse the credentials without a fresh approval.
 */
export interface PortalConnection {
  id: string;
  workspaceId: string;
  taskId: string;
  taskDigest: string;
  credentialRefs: Readonly<Record<string, SecretRef>>;
}

export interface GetPortalConnectionInput {
  context: WorkspaceContext;
  connectionId: string;
}

export interface PortalConnectionRepository {
  getConnection(input: GetPortalConnectionInput): Promise<PortalConnection>;
}

export interface DocumentHashKey {
  workspaceId: string;
  contentHash: string;
}

export interface RecordContentHashInput extends DocumentHashKey {
  documentId: string;
}

/** Durable, workspace-scoped index of stored content hashes used for dedup. */
export interface PortalDocumentRegistry {
  hasContentHash(input: DocumentHashKey): Promise<boolean>;
  recordContentHash(input: RecordContentHashInput): Promise<void>;
}

export interface LocalPlaywrightPortalTaskRunnerOptions {
  browserProvider?: PortalBrowserProvider;
  documentStorage: DocumentStorage;
  /** Required: an in-process default would silently lose dedup across restarts. */
  documentRegistry: PortalDocumentRegistry;
  secretStore: SecretStore;
  connections: PortalConnectionRepository;
  /** Per-document byte cap for downloads; defaults to 10 MiB. */
  maxDownloadBytes?: number;
}

const MAX_DOWNLOAD_DOCUMENTS_PER_RUN = 50;
const DEFAULT_MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const DEFAULT_SELECTOR_TIMEOUT_MS = 15_000;

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
  /**
   * One-way latch: once a sensitive step ran, later pages may still show the
   * authenticated session, so failure screenshots stay off for the whole run.
   */
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
    this.#documentRegistry = options.documentRegistry;
    this.#secretStore = options.secretStore;
    this.#connections = options.connections;
    this.#maxDownloadBytes = options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
  }

  async runTask(input: RunPortalTaskInput): Promise<RunPortalTaskResult> {
    const result = createInitialRunResult(input, this.#browserProvider.providerName);
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
    if (task.steps.length === 0) {
      // Launching a browser to do nothing would report a successful fetch.
      result.status = "policy_refused";
      result.errors.push("refused: portal task defines no executable steps");
      return result;
    }

    const context: WorkspaceContext = { workspaceId: input.workspaceId };
    const redactor = new PortalSecretRedactor();
    for (const value of this.#browserProvider.sensitiveValues ?? []) {
      redactor.addSecret(value);
    }
    const guard = createNetworkGuard({ task });
    let session: PortalBrowserSession | undefined;
    let blockedBeforeStep = 0;

    try {
      const connection = await this.#connections.getConnection({
        context,
        connectionId: input.connectionId,
      });
      if (
        connection.workspaceId !== input.workspaceId ||
        connection.taskId !== task.id ||
        connection.taskDigest !== portalTaskDigest(task)
      ) {
        result.status = "failed";
        result.errors.push(
          "portal connection is not bound to this workspace and reviewed task revision",
        );
        return result;
      }

      const credentials = await this.loadCredentials(context, connection, redactor);
      session = await this.#browserProvider.createSession({ task, runId: input.runId });

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

      await session.guardRequests((request) => {
        const decision = guard.evaluateRequest(request);
        if (decision.action === "abort") {
          throw new Error(
            `blocked request: ${decision.reason} ${request.method} ${sanitizeUrl(request.url) ?? "[unparseable url]"}`,
          );
        }
      });
      for (const step of task.steps) {
        blockedBeforeStep = guard.snapshot().blockedRequests.length;
        const status = await executeStep(state, step);
        // A click whose navigation the guard aborted resolves normally and
        // only a later step would notice; stop at the block itself instead of
        // reporting the symptom or contacting the portal any further.
        if (blockedDuring(guard, blockedBeforeStep)) {
          result.status = "blocked";
          break;
        }
        if (status !== "completed") {
          result.status = status;
          break;
        }
      }
    } catch (error) {
      // A route abort surfaces as a rejected goto/click; report it as the
      // policy block it is rather than a generic execution failure.
      result.status = blockedDuring(guard, blockedBeforeStep) ? "blocked" : "failed";
      result.errors.push(describeError(redactor, error));
    } finally {
      if (session !== undefined) {
        try {
          await session.close();
        } catch (error) {
          result.status = "failed";
          result.errors.push(describeError(redactor, error));
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

  async hasContentHash(input: DocumentHashKey): Promise<boolean> {
    return this.#hashes.has(documentHashKey(input));
  }

  async recordContentHash(input: RecordContentHashInput): Promise<void> {
    this.#hashes.set(documentHashKey(input), input.documentId);
  }
}

function blockedDuring(guard: NetworkGuard, blockedBefore: number): boolean {
  return guard.snapshot().blockedRequests.length > blockedBefore;
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
      return await selectorStep(state, step.selector, () =>
        state.session.page.fill(step.selector, value, selectorOptions()),
      );
    }
    case "click":
      return await selectorStep(state, step.selector, () =>
        state.session.page.click(step.selector, selectorOptions()),
      );
    case "waitForSelector":
      return await selectorStep(state, step.selector, async () => {
        const found = await state.session.page.waitForSelector(
          step.selector,
          selectorOptions(step.timeoutMs),
        );
        if (!found) {
          throw new SelectorMissingError(step.selector);
        }
      });
    case "downloadLinks":
      return await downloadLinks(state, step);
  }
}

class SelectorMissingError extends Error {
  constructor(selector: string) {
    super(`selector not found: ${selector}`);
    this.name = "SelectorMissingError";
  }
}

function selectorOptions(timeoutMs: number | undefined = DEFAULT_SELECTOR_TIMEOUT_MS): {
  timeoutMs: number;
} {
  return { timeoutMs };
}

/**
 * A missing element is a portal layout change, not a crash: it is reported as
 * `selector_missing` exactly once, with a failure artifact, and never retried.
 */
async function selectorStep(
  state: ExecutionState,
  selector: string,
  action: () => Promise<void>,
): Promise<PortalTaskRunStatus> {
  try {
    await action();
    return "completed";
  } catch (error) {
    if (!(error instanceof SelectorMissingError) && !isSelectorTimeoutError(error)) {
      throw error;
    }
    return await reportSelectorMissing(state, selector);
  }
}

async function reportSelectorMissing(
  state: ExecutionState,
  detail: string,
): Promise<PortalTaskRunStatus> {
  state.result.errors.push(`selector_missing: ${detail}`);
  await captureFailureArtifact(state);
  return "selector_missing";
}

type DownloadLinksStep = Extract<PortalTaskStep, { kind: "downloadLinks" }>;

async function downloadLinks(
  state: ExecutionState,
  step: DownloadLinksStep,
): Promise<PortalTaskRunStatus> {
  const elements = await state.session.page.queryAll(step.selector);
  if (elements.length === 0) {
    return await reportSelectorMissing(state, step.selector);
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
    const blockedBeforeDownload = state.guard.snapshot().blockedRequests.length;
    let response: PortalDownloadResponse;
    try {
      response = await state.session.page.requestBytes(href, {
        expectedMimeType: step.mimeType,
        maxBytes: state.maxDownloadBytes,
      });
    } catch (error) {
      state.result.errors.push(describeError(state.redactor, error));
      return blockedDuring(state.guard, blockedBeforeDownload) ? "blocked" : "failed";
    }

    const problem = downloadProblem(state, step, response, blockedBeforeDownload);
    if (problem !== undefined) {
      state.result.errors.push(problem.message);
      return problem.status;
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
    return await reportSelectorMissing(
      state,
      `no usable "${step.hrefAttribute}" on ${step.selector}`,
    );
  }

  return "completed";
}

interface DownloadProblem {
  status: Extract<PortalTaskRunStatus, "blocked" | "failed">;
  message: string;
}

/** The runner is the single policy authority over what a download may store. */
function downloadProblem(
  state: ExecutionState,
  step: DownloadLinksStep,
  response: PortalDownloadResponse,
  blockedBeforeDownload: number,
): DownloadProblem | undefined {
  if (
    evaluateDownloadUrl(state, response.finalUrl).action === "abort" ||
    blockedDuring(state.guard, blockedBeforeDownload)
  ) {
    return { status: "blocked", message: "download blocked: redirect left the portal policy" };
  }
  if (!isSuccessfulStatus(response.status)) {
    return { status: "failed", message: `download failed with status ${response.status}` };
  }
  if (!isExpectedMimeType(response.mimeType, step.mimeType)) {
    return {
      status: "failed",
      message: `download returned unexpected content type ${response.mimeType}; expected ${step.mimeType}`,
    };
  }
  const bytesProblem = documentBytesProblem(response.bytes, step.mimeType);
  if (bytesProblem !== undefined) {
    return { status: "failed", message: bytesProblem };
  }
  return undefined;
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
  const sourceUrl = retainedSourceUrl(state.redactor, input.sourceUrl);
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

/** Query, userinfo, identifier-like path segments, and known secrets are all removed. */
function retainedSourceUrl(redactor: PortalSecretRedactor, rawUrl: string): string | undefined {
  const redacted = redactSensitiveUrlPath(rawUrl);
  return redacted === undefined ? undefined : redactor.redactText(redacted);
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
    content: { kind: "objectRef", uri: `${STORED_DOCUMENT_URI_SCHEME}${stored.id}` },
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

function documentHashKey(input: DocumentHashKey): string {
  return `${input.workspaceId}:${input.contentHash}`;
}

function freezeConnection(connection: PortalConnection): PortalConnection {
  return Object.freeze({
    ...connection,
    credentialRefs: Object.freeze({ ...connection.credentialRefs }),
  });
}

/**
 * Browser errors embed target URLs, which may carry session ids. Known secrets
 * are removed first (a CDP endpoint is registered whole, query included), then
 * any remaining URL loses its query string.
 */
function describeError(redactor: PortalSecretRedactor, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeUrlsInText(redactor.redactText(message));
}
