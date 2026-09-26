/**
 * Portal task runner interface plus a fake in-memory runner for tests.
 *
 * Real execution backends implement {@link PortalTaskRunner}:
 * - `LocalPlaywrightPortalTaskRunner` — self-hosted local browser.
 * - `BrowserbasePortalTaskRunner` — managed remote browser (Sona pays).
 * - `UserDelegatedAgentTaskRunner` (planned) — runs in the user's own
 *   agent/browser subscription where available.
 *
 * Every runner MUST enforce the domain allowlist and the read-only policy at
 * execution time — the definition-time schema check is not sufficient on its own.
 */

import type { StoredDocument } from "@sona/core";
import { sha256Hex } from "@sona/core";
import { validateReadOnlyActions } from "./policy.js";
import type { BrowserProviderName, FetchedDocument, TaskRunProvenance } from "./provenance.js";
import type { PortalTask } from "./schema.js";

export interface RunPortalTaskInput {
  /** Treated as untrusted: runners re-validate it and execute the parsed copy. */
  task: PortalTask;
  connectionId: string;
  runId: string;
  workspaceId: string;
  /** ISO timestamp for the run (injectable for deterministic tests). */
  now: string;
}

export interface RunPortalTaskResult {
  status: PortalTaskRunStatus;
  runId: string;
  taskId: string;
  taskVersion: number;
  /** Fetched documents with content replaced by a `stored-document:` reference. */
  documents: FetchedDocument[];
  /** `@sona/core` storage records of the persisted originals (not the `@sona/receipts` evidence record `toStoredDocument` builds). */
  storedDocuments: StoredDocument[];
  provenance: TaskRunProvenance;
  warnings: string[];
  errors: string[];
}

export interface PortalTaskRunner {
  runTask(input: RunPortalTaskInput): Promise<RunPortalTaskResult>;
}

export type PortalTaskRunStatus =
  | "completed"
  | "policy_refused"
  | "blocked"
  | "selector_missing"
  | "failed";

/**
 * The result skeleton every runner starts from. Status starts optimistic and
 * runners only ever downgrade it. It is built before the task is validated so
 * a malformed definition still yields a structured `policy_refused` result;
 * task identity is therefore read defensively from the unvalidated input.
 */
export function createInitialRunResult(
  input: RunPortalTaskInput,
  provider: BrowserProviderName,
): RunPortalTaskResult {
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
      connectionId: input.connectionId,
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * A deterministic fake runner. It re-checks the read-only policy (defense in
 * depth), then returns a single placeholder invoice document with provenance.
 * It performs no network or browser I/O and, unlike the Playwright runner,
 * does not re-parse the task: tests hand it already-typed definitions.
 */
export class FakePortalTaskRunner implements PortalTaskRunner {
  async runTask(input: RunPortalTaskInput): Promise<RunPortalTaskResult> {
    const result = createInitialRunResult(input, "fake");

    const policy = validateReadOnlyActions(input.task.allowedActions);
    if (!policy.valid) {
      for (const violation of policy.violations) {
        result.errors.push(`refused: action "${violation.action}" implies ${violation.concept}`);
      }
      result.status = "policy_refused";
      return result;
    }

    const domain = input.task.domains[0] ?? "unknown";
    const payload = new TextEncoder().encode(
      `%PDF-1.4 fake invoice for ${input.task.id} run ${input.runId}`,
    );
    const contentHash = sha256Hex(payload);
    const filename = `${input.task.id}-invoice.pdf`;

    const document: FetchedDocument = {
      filename,
      mimeType: "application/pdf",
      contentHash,
      sourceUrl: `https://${domain}/invoices/demo`,
      content: { kind: "bytes", bytes: payload },
      provenance: {
        sourcePortal: domain,
        taskId: input.task.id,
        taskVersion: input.task.version,
        runId: input.runId,
        sourceUrl: `https://${domain}/invoices/demo`,
        downloadedFilename: filename,
        contentHash,
        fetchedAt: input.now,
        browserProvider: "fake",
        connectionId: input.connectionId,
        workspaceId: input.workspaceId,
        extractionStatus: "pending",
      },
    };

    result.documents.push(document);
    return result;
  }
}
