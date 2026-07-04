import type { JsonValue } from "@sona/core";
import type { DbClient } from "../runner.js";
import { parseJson, requiredString, row, stringifyJson } from "./helpers.js";
import type { SyncRunStore, SyncStatus, SyncSummary } from "./types.js";

export interface SyncRunError {
  accountUid: string;
  message: string;
  at: string;
}

interface SyncRunMetadata {
  errors: SyncRunError[];
  summary?: SyncSummary;
}

export interface PersistedSyncRun {
  runId: string;
  workspaceId: string;
  sourceId: string;
  status: string;
  startedAt: string;
  finishedAt: string | undefined;
  errors: SyncRunError[];
  summary: SyncSummary | undefined;
}

export class SqliteSyncRunRepository {
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
        "running",
        run.startedAt,
        stringifyMetadata({ errors: [] }),
      );
  }

  async recordError(
    workspaceId: string,
    error: { runId: string; accountUid: string; message: string; at: string },
  ): Promise<void> {
    const existing = await this.get(workspaceId, error.runId);
    if (existing === undefined) {
      throw new Error("sync run not found in workspace");
    }
    const metadata: SyncRunMetadata = {
      errors: [...existing.errors, error],
      summary: existing.summary,
    };
    this.#db
      .prepare("UPDATE source_sync_runs SET error_json = ? WHERE workspace_id = ? AND id = ?")
      .run(stringifyMetadata(metadata), workspaceId, error.runId);
  }

  async finish(
    workspaceId: string,
    run: {
      runId: string;
      status: SyncStatus;
      finishedAt: string;
      summary: SyncSummary;
    },
  ): Promise<void> {
    const existing = await this.get(workspaceId, run.runId);
    if (existing === undefined) {
      throw new Error("sync run not found in workspace");
    }
    const metadata: SyncRunMetadata = {
      errors: existing.errors,
      summary: run.summary,
    };
    this.#db
      .prepare(
        "UPDATE source_sync_runs SET status = ?, finished_at = ?, error_json = ? WHERE workspace_id = ? AND id = ?",
      )
      .run(run.status, run.finishedAt, stringifyMetadata(metadata), workspaceId, run.runId);
  }

  async get(workspaceId: string, runId: string): Promise<PersistedSyncRun | undefined> {
    const result = row(
      this.#db
        .prepare(
          "SELECT id, workspace_id, source_id, status, started_at, finished_at, error_json FROM source_sync_runs WHERE workspace_id = ? AND id = ?",
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
      status: requiredString(result, "status"),
      startedAt: requiredString(result, "started_at"),
      finishedAt:
        result["finished_at"] === null ? undefined : requiredString(result, "finished_at"),
      errors: metadata.errors,
      summary: metadata.summary,
    };
  }
}

export function createWorkspaceSyncRunStore(
  repository: SqliteSyncRunRepository,
  workspaceId: string,
): SyncRunStore {
  return {
    start: async (run) => {
      if (run.workspaceId !== workspaceId) {
        throw new Error("sync run workspace mismatch");
      }
      await repository.start(run);
    },
    recordError: async (error) => repository.recordError(workspaceId, error),
    finish: async (run) => repository.finish(workspaceId, run),
  };
}

function stringifyMetadata(metadata: SyncRunMetadata): string {
  const value: Record<string, JsonValue> = {
    errors: metadata.errors.map((error) => ({
      accountUid: error.accountUid,
      message: error.message,
      at: error.at,
    })),
  };
  if (metadata.summary !== undefined) {
    value["summary"] = {
      runId: metadata.summary.runId,
      accountsSynced: metadata.summary.accountsSynced,
      balancesSynced: metadata.summary.balancesSynced,
      transactionsSynced: metadata.summary.transactionsSynced,
      errors: metadata.summary.errors.map((error) => ({
        accountUid: error.accountUid,
        message: error.message,
      })),
    };
  }
  return stringifyJson(value);
}

function parseMetadata(value: unknown): SyncRunMetadata {
  if (value === null || value === undefined) {
    return { errors: [] };
  }
  if (typeof value !== "string") {
    throw new Error("sync run error_json was not a string");
  }
  const parsed = parseJson(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { errors: [] };
  }
  const object = parsed as Record<string, JsonValue | undefined>;
  const errorsValue = object["errors"];
  const errors = Array.isArray(errorsValue) ? errorsValue.map(parseError) : [];
  const summary = parseSummary(object["summary"]);
  return { errors, summary };
}

function parseError(value: JsonValue): SyncRunError {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("sync run error entry was not an object");
  }
  const object = value as Record<string, JsonValue | undefined>;
  if (
    typeof object["accountUid"] !== "string" ||
    typeof object["message"] !== "string" ||
    typeof object["at"] !== "string"
  ) {
    throw new Error("sync run error entry was malformed");
  }
  return {
    accountUid: object["accountUid"],
    message: object["message"],
    at: object["at"],
  };
}

function parseSummary(value: JsonValue | undefined): SyncSummary | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("sync run summary was malformed");
  }
  const object = value as Record<string, JsonValue | undefined>;
  if (
    typeof object["runId"] !== "string" ||
    typeof object["accountsSynced"] !== "number" ||
    typeof object["balancesSynced"] !== "number" ||
    typeof object["transactionsSynced"] !== "number" ||
    !Array.isArray(object["errors"])
  ) {
    throw new Error("sync run summary was malformed");
  }
  return {
    runId: object["runId"],
    accountsSynced: object["accountsSynced"],
    balancesSynced: object["balancesSynced"],
    transactionsSynced: object["transactionsSynced"],
    errors: object["errors"].map(parseSummaryError),
  };
}

function parseSummaryError(value: JsonValue): { accountUid: string; message: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("sync run summary error entry was malformed");
  }
  const object = value as Record<string, JsonValue | undefined>;
  if (typeof object["accountUid"] !== "string" || typeof object["message"] !== "string") {
    throw new Error("sync run summary error entry was malformed");
  }
  return {
    accountUid: object["accountUid"],
    message: object["message"],
  };
}
