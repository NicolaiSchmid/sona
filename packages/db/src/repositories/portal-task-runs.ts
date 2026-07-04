import type { DbClient } from "../runner.js";
import { requiredNumber, requiredString, row, rows } from "./helpers.js";
import type { TaskRunProvenance } from "./types.js";

export class SqlitePortalTaskRunRepository {
  readonly #db: DbClient;

  constructor(db: DbClient) {
    this.#db = db;
  }

  async append(run: TaskRunProvenance): Promise<void> {
    const existing = await this.getById(run.workspaceId, run.runId);
    if (existing !== undefined) {
      throw new Error("portal task runs are append-only");
    }
    this.#db
      .prepare(
        "INSERT INTO portal_task_runs (run_id, workspace_id, task_id, task_version, portal_domain, browser_provider, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        run.runId,
        run.workspaceId,
        run.taskId,
        run.taskVersion,
        run.portalDomain,
        run.browserProvider,
        run.fetchedAt,
      );
  }

  async getById(workspaceId: string, runId: string): Promise<TaskRunProvenance | undefined> {
    const result = row(
      this.#db
        .prepare("SELECT * FROM portal_task_runs WHERE workspace_id = ? AND run_id = ?")
        .get(workspaceId, runId),
    );
    return result === undefined ? undefined : runFromRow(result);
  }

  async listForTask(workspaceId: string, taskId: string): Promise<TaskRunProvenance[]> {
    return rows(
      this.#db
        .prepare(
          "SELECT * FROM portal_task_runs WHERE workspace_id = ? AND task_id = ? ORDER BY fetched_at, run_id",
        )
        .all(workspaceId, taskId),
    ).map(runFromRow);
  }

  async columnNames(): Promise<string[]> {
    return rows(this.#db.prepare("PRAGMA table_info(portal_task_runs)").all()).map((source) =>
      requiredString(source, "name"),
    );
  }
}

function runFromRow(source: Record<string, unknown>): TaskRunProvenance {
  return {
    runId: requiredString(source, "run_id"),
    taskId: requiredString(source, "task_id"),
    taskVersion: requiredNumber(source, "task_version"),
    portalDomain: requiredString(source, "portal_domain"),
    browserProvider: requiredString(source, "browser_provider"),
    workspaceId: requiredString(source, "workspace_id"),
    fetchedAt: requiredString(source, "fetched_at"),
  };
}
