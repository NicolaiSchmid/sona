/**
 * Persists Paperless sync runs in `source_sync_runs` (shared with other source
 * kinds) and each run's `(modified, id)` cursor in `paperless_sync_cursors`.
 * Errors and the summary are counts and redacted messages only.
 */
import type { JsonValue } from "@sona/core";
import type { DbClient } from "../runner.js";
import {
  optionalString,
  parseJson,
  type Row,
  requiredNumber,
  requiredString,
  row,
  stringifyJson,
  withTransaction,
} from "./helpers.js";
import type {
  PaperlessCursorResetReason,
  PaperlessSyncCursor,
  PaperlessSyncError,
  PaperlessSyncRunStore,
  PaperlessSyncStatus,
  PaperlessSyncSummary,
} from "./types.js";

export interface PaperlessSyncRunError extends PaperlessSyncError {
  at: string;
}

export type PersistedPaperlessSyncRunStatus = PaperlessSyncStatus | "running";

export interface PersistedPaperlessSyncRun {
  runId: string;
  workspaceId: string;
  sourceId: string;
  status: PersistedPaperlessSyncRunStatus;
  startedAt: string;
  finishedAt: string | undefined;
  errors: PaperlessSyncRunError[];
  summary: PaperlessSyncSummary | undefined;
  cursor: PaperlessSyncCursor | undefined;
}

interface RunMetadata {
  errors: PaperlessSyncRunError[];
  summary: PaperlessSyncSummary | undefined;
}

const RUN_SELECT =
  "SELECT r.id, r.workspace_id, r.source_id, r.status, r.started_at, r.finished_at, r.error_json, c.last_modified, c.last_document_id, c.policy_hash FROM source_sync_runs r LEFT JOIN paperless_sync_cursors c ON c.workspace_id = r.workspace_id AND c.run_id = r.id";

export class SqlitePaperlessSyncRunRepository {
  readonly #db: DbClient;

  constructor(db: DbClient) {
    this.#db = db;
  }

  async start(run: {
    runId: string;
    workspaceId: string;
    sourceId: string;
    startedAt: string;
  }): Promise<void> {
    this.#db
      .prepare(
        "INSERT INTO source_sync_runs (id, workspace_id, source_id, status, started_at, error_json) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        run.runId,
        run.workspaceId,
        run.sourceId,
        "running" satisfies PersistedPaperlessSyncRunStatus,
        run.startedAt,
        stringifyMetadata({ errors: [], summary: undefined }),
      );
  }

  async recordError(
    workspaceId: string,
    error: PaperlessSyncRunError & { runId: string },
  ): Promise<void> {
    const existing = await this.#requireRun(workspaceId, error.runId);
    this.#db
      .prepare("UPDATE source_sync_runs SET error_json = ? WHERE workspace_id = ? AND id = ?")
      .run(
        stringifyMetadata({ errors: [...existing.errors, error], summary: existing.summary }),
        workspaceId,
        error.runId,
      );
  }

  /** Closes the run; `run.summary.cursor`, when present, becomes the resumable cursor. */
  async finish(
    workspaceId: string,
    run: {
      runId: string;
      status: PaperlessSyncStatus;
      finishedAt: string;
      summary: PaperlessSyncSummary;
    },
  ): Promise<void> {
    const existing = await this.#requireRun(workspaceId, run.runId);
    withTransaction(this.#db, () => {
      this.#db
        .prepare(
          "UPDATE source_sync_runs SET status = ?, finished_at = ?, error_json = ? WHERE workspace_id = ? AND id = ?",
        )
        .run(
          run.status,
          run.finishedAt,
          stringifyMetadata({ errors: existing.errors, summary: run.summary }),
          workspaceId,
          run.runId,
        );
      const cursor = run.summary.cursor;
      if (cursor !== undefined) {
        this.#db
          .prepare(
            "INSERT INTO paperless_sync_cursors (run_id, workspace_id, source_id, last_modified, last_document_id, policy_hash, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            run.runId,
            workspaceId,
            existing.sourceId,
            cursor.lastModified,
            cursor.lastDocumentId,
            cursor.policyHash,
            run.finishedAt,
          );
      }
    });
  }

  async latestCursor(input: {
    workspaceId: string;
    sourceId: string;
  }): Promise<PaperlessSyncCursor | undefined> {
    const result = row(
      this.#db
        .prepare(
          "SELECT last_modified, last_document_id, policy_hash FROM paperless_sync_cursors WHERE workspace_id = ? AND source_id = ? ORDER BY recorded_at DESC, run_id DESC LIMIT 1",
        )
        .get(input.workspaceId, input.sourceId),
    );
    return result === undefined ? undefined : cursorFromRow(result);
  }

  async get(workspaceId: string, runId: string): Promise<PersistedPaperlessSyncRun | undefined> {
    const result = row(
      this.#db
        .prepare(`${RUN_SELECT} WHERE r.workspace_id = ? AND r.id = ?`)
        .get(workspaceId, runId),
    );
    if (result === undefined) {
      return undefined;
    }
    const metadata = parseMetadata(optionalString(result, "error_json"));
    return {
      runId: requiredString(result, "id"),
      workspaceId: requiredString(result, "workspace_id"),
      sourceId: requiredString(result, "source_id"),
      status: parseStatus(requiredString(result, "status")),
      startedAt: requiredString(result, "started_at"),
      finishedAt: optionalString(result, "finished_at"),
      errors: metadata.errors,
      summary: metadata.summary,
      cursor: result["last_modified"] === null ? undefined : cursorFromRow(result),
    };
  }

  async #requireRun(workspaceId: string, runId: string): Promise<PersistedPaperlessSyncRun> {
    const existing = await this.get(workspaceId, runId);
    if (existing === undefined) {
      throw new Error("sync run not found in workspace");
    }
    return existing;
  }
}

/** Binds the repository to one workspace so the connector cannot address another. */
export function createWorkspacePaperlessSyncRunStore(
  repository: SqlitePaperlessSyncRunRepository,
  workspaceId: string,
): PaperlessSyncRunStore {
  const requireWorkspace = (candidate: string): void => {
    if (candidate !== workspaceId) {
      throw new Error("sync run workspace mismatch");
    }
  };
  return {
    start: async (run) => {
      requireWorkspace(run.workspaceId);
      await repository.start(run);
    },
    recordError: async (error) => repository.recordError(workspaceId, error),
    finish: async (run) => repository.finish(workspaceId, run),
    latestCursor: async (input) => {
      requireWorkspace(input.workspaceId);
      return repository.latestCursor(input);
    },
  };
}

const RUN_STATUSES = [
  "running",
  "succeeded",
  "completed_with_errors",
  "failed",
] as const satisfies readonly PersistedPaperlessSyncRunStatus[];

function parseStatus(value: string): PersistedPaperlessSyncRunStatus {
  const status = RUN_STATUSES.find((candidate) => candidate === value);
  if (status === undefined) {
    throw new Error("paperless sync run status was malformed");
  }
  return status;
}

function cursorFromRow(source: Row): PaperlessSyncCursor {
  return {
    lastModified: requiredString(source, "last_modified"),
    lastDocumentId: requiredNumber(source, "last_document_id"),
    policyHash: requiredString(source, "policy_hash"),
  };
}

const COUNTER_KEYS = [
  "documentsSeen",
  "documentsIngested",
  "documentsSkippedNotAllowlisted",
  "documentsSkippedDuplicate",
  "documentsSkippedPolicy",
  "documentsStored",
  "documentsDeduplicated",
] as const satisfies ReadonlyArray<keyof PaperlessSyncSummary>;

function errorToJson(error: PaperlessSyncError): { documentId: number | null; message: string } {
  return { documentId: error.documentId ?? null, message: error.message };
}

function stringifyMetadata(metadata: RunMetadata): string {
  const value: Record<string, JsonValue> = {
    errors: metadata.errors.map((error) => ({ ...errorToJson(error), at: error.at })),
  };
  const summary = metadata.summary;
  if (summary !== undefined) {
    value["summary"] = {
      runId: summary.runId,
      ...Object.fromEntries(COUNTER_KEYS.map((key) => [key, summary[key]])),
      cursorReset: summary.cursorReset ?? null,
      cursor: summary.cursor === undefined ? null : { ...summary.cursor },
      errors: summary.errors.map(errorToJson),
    };
  }
  return stringifyJson(value);
}

type JsonObject = Record<string, JsonValue | undefined>;

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value;
}

function parseMetadata(value: string | undefined): RunMetadata {
  const parsed = value === undefined ? undefined : asObject(parseJson(value));
  if (parsed === undefined) {
    return { errors: [], summary: undefined };
  }
  const errors = Array.isArray(parsed["errors"]) ? parsed["errors"].map(parseRunError) : [];
  const summary = parsed["summary"];
  return { errors, summary: summary === undefined ? undefined : parseSummary(summary) };
}

function parseSyncError(value: JsonValue): PaperlessSyncError {
  const object = asObject(value);
  if (object === undefined || typeof object["message"] !== "string") {
    throw new Error("paperless sync run error entry was malformed");
  }
  const documentId = object["documentId"];
  return {
    documentId: typeof documentId === "number" ? documentId : undefined,
    message: object["message"],
  };
}

function parseRunError(value: JsonValue): PaperlessSyncRunError {
  const at = asObject(value)?.["at"];
  if (typeof at !== "string") {
    throw new Error("paperless sync run error entry was malformed");
  }
  return { ...parseSyncError(value), at };
}

function parseCursorReset(value: JsonValue | undefined): PaperlessCursorResetReason | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value !== "policy_changed") {
    throw new Error("paperless sync run summary cursorReset was malformed");
  }
  return value;
}

function parseCursor(value: JsonValue | undefined): PaperlessSyncCursor | undefined {
  const object = asObject(value);
  if (object === undefined) {
    return undefined;
  }
  const { lastModified, lastDocumentId, policyHash } = object;
  if (
    typeof lastModified !== "string" ||
    typeof lastDocumentId !== "number" ||
    typeof policyHash !== "string"
  ) {
    throw new Error("paperless sync run summary cursor was malformed");
  }
  return { lastModified, lastDocumentId, policyHash };
}

function parseSummary(value: JsonValue): PaperlessSyncSummary {
  const object = asObject(value);
  if (
    object === undefined ||
    typeof object["runId"] !== "string" ||
    !Array.isArray(object["errors"])
  ) {
    throw new Error("paperless sync run summary was malformed");
  }
  const counters = {} as Record<(typeof COUNTER_KEYS)[number], number>;
  for (const key of COUNTER_KEYS) {
    const counter = object[key];
    if (typeof counter !== "number") {
      throw new Error(`paperless sync run summary ${key} was malformed`);
    }
    counters[key] = counter;
  }
  return {
    runId: object["runId"],
    ...counters,
    cursorReset: parseCursorReset(object["cursorReset"]),
    cursor: parseCursor(object["cursor"]),
    errors: object["errors"].map(parseSyncError),
  };
}
