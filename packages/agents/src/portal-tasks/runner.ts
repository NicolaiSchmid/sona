/**
 * Portal task runner interface plus a fake in-memory runner for tests.
 *
 * Real execution backends implement {@link PortalTaskRunner}. Planned adapters:
 * - `BrowserbasePortalTaskRunner` — managed remote browser (Sona pays).
 * - `LocalPlaywrightPortalTaskRunner` — self-hosted local browser.
 * - `UserDelegatedAgentTaskRunner` — runs in the user's own agent/browser
 *   subscription where available.
 *
 * Every runner MUST enforce the domain allowlist and the read-only policy at
 * execution time — the definition-time schema check is not sufficient on its own.
 */
import { sha256Hex } from "@sona/core";
import { validateReadOnlyActions } from "./policy.js";
import type { FetchedDocument, TaskRunProvenance } from "./provenance.js";
import type { PortalTask } from "./schema.js";

export interface RunPortalTaskInput {
  task: PortalTask;
  connectionId: string;
  runId: string;
  workspaceId: string;
  /** ISO timestamp for the run (injectable for deterministic tests). */
  now: string;
}

export interface RunPortalTaskResult {
  runId: string;
  taskId: string;
  taskVersion: number;
  documents: FetchedDocument[];
  provenance: TaskRunProvenance;
  warnings: string[];
  errors: string[];
}

export interface PortalTaskRunner {
  runTask(input: RunPortalTaskInput): Promise<RunPortalTaskResult>;
}

function baseResult(input: RunPortalTaskInput, provider: string): RunPortalTaskResult {
  const domain = input.task.domains[0] ?? "unknown";
  return {
    runId: input.runId,
    taskId: input.task.id,
    taskVersion: input.task.version,
    documents: [],
    provenance: {
      runId: input.runId,
      taskId: input.task.id,
      taskVersion: input.task.version,
      portalDomain: domain,
      browserProvider: provider,
      workspaceId: input.workspaceId,
      fetchedAt: input.now,
    },
    warnings: [],
    errors: [],
  };
}

/**
 * A deterministic fake runner. It re-checks the read-only policy (defense in
 * depth), then returns a single placeholder invoice document with provenance.
 * It performs no network or browser I/O.
 */
export class FakePortalTaskRunner implements PortalTaskRunner {
  async runTask(input: RunPortalTaskInput): Promise<RunPortalTaskResult> {
    const result = baseResult(input, "fake");

    const policy = validateReadOnlyActions(input.task.allowedActions);
    if (!policy.valid) {
      for (const violation of policy.violations) {
        result.errors.push(`refused: action "${violation.action}" implies ${violation.concept}`);
      }
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
        workspaceId: input.workspaceId,
        extractionStatus: "pending",
      },
    };

    result.documents.push(document);
    return result;
  }
}
