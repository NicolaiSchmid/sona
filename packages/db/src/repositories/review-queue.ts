import type { JsonValue, ReviewState } from "@sona/core";
import type { DbClient } from "../runner.js";
import type { ReviewItem } from "../schema.js";
import { parseJson, requiredString, row, rows, stringifyJson } from "./helpers.js";

export interface ReviewTransitionInput {
  id: string;
  toState: ReviewState;
  actor: string;
  at: string;
  notes?: string;
}

export class SqliteReviewQueueRepository {
  readonly #db: DbClient;

  constructor(db: DbClient) {
    this.#db = db;
  }

  async enqueue(item: ReviewItem): Promise<void> {
    this.#db
      .prepare(
        "INSERT INTO review_items (id, workspace_id, target_type, target_id, state, reason_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id, id) DO NOTHING",
      )
      .run(
        item.id,
        item.workspaceId,
        item.targetType,
        item.targetId,
        item.state,
        stringifyJson(item.reason),
        item.createdAt,
        item.updatedAt,
      );
  }

  async transition(workspaceId: string, input: ReviewTransitionInput): Promise<void> {
    const current = await this.getById(workspaceId, input.id);
    if (current === undefined) {
      throw new Error("review item not found in workspace");
    }
    this.#db.exec("BEGIN");
    try {
      this.#db
        .prepare(
          "UPDATE review_items SET state = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
        )
        .run(input.toState, input.at, workspaceId, input.id);
      this.#db
        .prepare(
          "INSERT INTO review_events (id, workspace_id, target_type, target_id, from_state, to_state, actor, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          `review_event:${input.id}:${input.at}`,
          workspaceId,
          current.targetType,
          current.targetId,
          current.state,
          input.toState,
          input.actor,
          input.notes ?? null,
          input.at,
        );
      this.#db.exec("COMMIT");
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // Surface the original write failure.
      }
      throw error;
    }
  }

  async getById(workspaceId: string, id: string): Promise<ReviewItem | undefined> {
    const result = row(
      this.#db
        .prepare("SELECT * FROM review_items WHERE workspace_id = ? AND id = ?")
        .get(workspaceId, id),
    );
    return result === undefined ? undefined : itemFromRow(result);
  }

  async listByState(workspaceId: string, state: ReviewState): Promise<ReviewItem[]> {
    return rows(
      this.#db
        .prepare(
          "SELECT * FROM review_items WHERE workspace_id = ? AND state = ? ORDER BY updated_at, id",
        )
        .all(workspaceId, state),
    ).map(itemFromRow);
  }
}

function itemFromRow(source: Record<string, unknown>): ReviewItem {
  return {
    id: requiredString(source, "id"),
    workspaceId: requiredString(source, "workspace_id"),
    targetType: requiredString(source, "target_type"),
    targetId: requiredString(source, "target_id"),
    state: requiredString(source, "state") as ReviewState,
    reason: parseJson(requiredString(source, "reason_json")) as JsonValue,
    createdAt: requiredString(source, "created_at"),
    updatedAt: requiredString(source, "updated_at"),
  };
}
