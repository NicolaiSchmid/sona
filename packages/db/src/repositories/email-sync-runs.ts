import type { JsonValue } from "@sona/core";
import type { DbClient } from "../runner.js";
import {
  optionalString,
  parseJson,
  requiredNumber,
  requiredString,
  row,
  stringifyJson,
  withTransaction,
} from "./helpers.js";
import type {
  EmailCursorResetReason,
  EmailSyncCursor,
  EmailSyncError,
  EmailSyncRunStore,
  EmailSyncStatus,
  EmailSyncSummary,
} from "./types.js";

export interface EmailSyncRunError extends EmailSyncError {
  at: string;
}

/** Terminal statuses plus the transient state between `start` and `finish`. */
export type PersistedEmailSyncRunStatus = EmailSyncStatus | "running";

interface EmailSyncRunMetadata {
  errors: EmailSyncRunError[];
  summary?: EmailSyncSummary;
}

export interface PersistedEmailSyncRun {
  runId: string;
  workspaceId: string;
  sourceId: string;
  status: PersistedEmailSyncRunStatus;
  startedAt: string;
  finishedAt: string | undefined;
  errors: EmailSyncRunError[];
  summary: EmailSyncSummary | undefined;
  cursor: EmailSyncCursor | undefined;
}

/**
 * Persists email sync runs in `source_sync_runs` (shared with other source
 * kinds) and the run's UID cursor in `email_sync_cursors`. Errors and the
 * summary are counts and redacted messages only; no addresses or subjects.
 */
export class SqliteEmailSyncRunRepository {
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
        "running" satisfies PersistedEmailSyncRunStatus,
        run.startedAt,
        stringifyMetadata({ errors: [] }),
      );
  }

  async recordError(
    workspaceId: string,
    error: EmailSyncRunError & { runId: string },
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
      status: EmailSyncStatus;
      finishedAt: string;
      summary: EmailSyncSummary;
    },
  ): Promise<void> {
    const existing = await this.#requireRun(workspaceId, run.runId);
    // Terminal status and cursor land together: a run must never read as
    // finished with a summary that claims a cursor no row backs.
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
            "INSERT INTO email_sync_cursors (run_id, workspace_id, source_id, folder, uid_validity, last_uid, policy_hash, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            run.runId,
            workspaceId,
            existing.sourceId,
            cursor.folder,
            cursor.uidValidity,
            cursor.lastUid,
            cursor.policyHash,
            run.finishedAt,
          );
      }
    });
  }

  async latestCursor(input: {
    workspaceId: string;
    sourceId: string;
    folder: string;
  }): Promise<EmailSyncCursor | undefined> {
    const result = row(
      this.#db
        .prepare(
          "SELECT folder, uid_validity, last_uid, policy_hash FROM email_sync_cursors WHERE workspace_id = ? AND source_id = ? AND folder = ? ORDER BY recorded_at DESC, run_id DESC LIMIT 1",
        )
        .get(input.workspaceId, input.sourceId, input.folder),
    );
    return result === undefined ? undefined : cursorFromRow(result);
  }

  async get(workspaceId: string, runId: string): Promise<PersistedEmailSyncRun | undefined> {
    const result = row(
      this.#db
        .prepare(
          "SELECT r.id, r.workspace_id, r.source_id, r.status, r.started_at, r.finished_at, r.error_json, c.folder, c.uid_validity, c.last_uid, c.policy_hash FROM source_sync_runs r LEFT JOIN email_sync_cursors c ON c.workspace_id = r.workspace_id AND c.run_id = r.id WHERE r.workspace_id = ? AND r.id = ?",
        )
        .get(workspaceId, runId),
    );
    if (result === undefined) {
      return undefined;
    }
    const metadata = parseMetadata(result["error_json"]);
    return {
      runId: requiredString(result, "id"),
      workspaceId: requiredString(result, "workspace_id"),
      sourceId: requiredString(result, "source_id"),
      status: parseStatus(requiredString(result, "status")),
      startedAt: requiredString(result, "started_at"),
      finishedAt: optionalString(result, "finished_at"),
      errors: metadata.errors,
      summary: metadata.summary,
      cursor: result["folder"] === null ? undefined : cursorFromRow(result),
    };
  }

  async #requireRun(workspaceId: string, runId: string): Promise<PersistedEmailSyncRun> {
    const existing = await this.get(workspaceId, runId);
    if (existing === undefined) {
      throw new Error("sync run not found in workspace");
    }
    return existing;
  }
}

/** Binds the repository to one workspace so the connector cannot address another. */
export function createWorkspaceEmailSyncRunStore(
  repository: SqliteEmailSyncRunRepository,
  workspaceId: string,
): EmailSyncRunStore {
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
] as const satisfies readonly PersistedEmailSyncRunStatus[];

function parseStatus(value: string): PersistedEmailSyncRunStatus {
  const status = RUN_STATUSES.find((candidate) => candidate === value);
  if (status === undefined) {
    throw new Error("email sync run status was malformed");
  }
  return status;
}

function cursorFromRow(source: Record<string, unknown>): EmailSyncCursor {
  return {
    folder: requiredString(source, "folder"),
    uidValidity: requiredString(source, "uid_validity"),
    lastUid: requiredNumber(source, "last_uid"),
    policyHash: requiredString(source, "policy_hash"),
  };
}

function stringifyMetadata(metadata: EmailSyncRunMetadata): string {
  const value: Record<string, JsonValue> = {
    errors: metadata.errors.map((error) => ({
      uid: error.uid ?? null,
      message: error.message,
      at: error.at,
    })),
  };
  if (metadata.summary !== undefined) {
    value["summary"] = summaryToJson(metadata.summary);
  }
  return stringifyJson(value);
}

function summaryToJson(summary: EmailSyncSummary): JsonValue {
  return {
    runId: summary.runId,
    messagesSeen: summary.messagesSeen,
    messagesIngested: summary.messagesIngested,
    messagesSkippedNotAllowlisted: summary.messagesSkippedNotAllowlisted,
    messagesSkippedDuplicate: summary.messagesSkippedDuplicate,
    messagesWithoutDocuments: summary.messagesWithoutDocuments,
    attachmentsStored: summary.attachmentsStored,
    attachmentsDeduplicated: summary.attachmentsDeduplicated,
    attachmentsSkipped: summary.attachmentsSkipped,
    cursorReset: summary.cursorReset ?? null,
    cursor: summary.cursor === undefined ? null : { ...summary.cursor },
    errors: summary.errors.map((error) => ({ uid: error.uid ?? null, message: error.message })),
  };
}

type JsonObject = Record<string, JsonValue | undefined>;

function parseMetadata(value: unknown): EmailSyncRunMetadata {
  if (typeof value !== "string") {
    return { errors: [] };
  }
  const parsed = asObject(parseJson(value));
  if (parsed === undefined) {
    return { errors: [] };
  }
  const errors = Array.isArray(parsed["errors"]) ? parsed["errors"].map(parseRunError) : [];
  const summaryValue = parsed["summary"];
  return {
    errors,
    summary: summaryValue === undefined ? undefined : parseSummary(summaryValue),
  };
}

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value;
}

function parseSyncError(value: JsonValue, label: string): EmailSyncError {
  const object = asObject(value);
  if (object === undefined || typeof object["message"] !== "string") {
    throw new Error(`email sync run ${label} entry was malformed`);
  }
  return {
    uid: typeof object["uid"] === "number" ? object["uid"] : undefined,
    message: object["message"],
  };
}

function parseRunError(value: JsonValue): EmailSyncRunError {
  const at = asObject(value)?.["at"];
  if (typeof at !== "string") {
    throw new Error("email sync run error entry was malformed");
  }
  return { ...parseSyncError(value, "error"), at };
}

const CURSOR_RESET_REASONS = [
  "uid_validity_changed",
  "policy_changed",
] as const satisfies readonly EmailCursorResetReason[];

function parseCursorReset(value: JsonValue | undefined): EmailCursorResetReason | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const reason = CURSOR_RESET_REASONS.find((candidate) => candidate === value);
  if (reason === undefined) {
    throw new Error("email sync run summary cursorReset was malformed");
  }
  return reason;
}

function requireCounter(object: JsonObject, key: keyof EmailSyncSummary): number {
  const counter = object[key];
  if (typeof counter !== "number") {
    throw new Error(`email sync run summary ${key} was malformed`);
  }
  return counter;
}

function parseSummary(value: JsonValue): EmailSyncSummary {
  const object = asObject(value);
  if (
    object === undefined ||
    typeof object["runId"] !== "string" ||
    !Array.isArray(object["errors"])
  ) {
    throw new Error("email sync run summary was malformed");
  }
  return {
    runId: object["runId"],
    messagesSeen: requireCounter(object, "messagesSeen"),
    messagesIngested: requireCounter(object, "messagesIngested"),
    messagesSkippedNotAllowlisted: requireCounter(object, "messagesSkippedNotAllowlisted"),
    messagesSkippedDuplicate: requireCounter(object, "messagesSkippedDuplicate"),
    messagesWithoutDocuments: requireCounter(object, "messagesWithoutDocuments"),
    attachmentsStored: requireCounter(object, "attachmentsStored"),
    attachmentsDeduplicated: requireCounter(object, "attachmentsDeduplicated"),
    attachmentsSkipped: requireCounter(object, "attachmentsSkipped"),
    cursorReset: parseCursorReset(object["cursorReset"]),
    cursor: parseCursor(object["cursor"]),
    errors: object["errors"].map((entry) => parseSyncError(entry, "summary error")),
  };
}

function parseCursor(value: JsonValue | undefined): EmailSyncCursor | undefined {
  const object = asObject(value);
  if (object === undefined) {
    return undefined;
  }
  const folder = object["folder"];
  const uidValidity = object["uidValidity"];
  const lastUid = object["lastUid"];
  const policyHash = object["policyHash"];
  if (
    typeof folder !== "string" ||
    typeof uidValidity !== "string" ||
    typeof lastUid !== "number" ||
    typeof policyHash !== "string"
  ) {
    throw new Error("email sync run summary cursor was malformed");
  }
  return { folder, uidValidity, lastUid, policyHash };
}
