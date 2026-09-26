import { isReviewState, type ReviewState } from "@sona/core";
import type { DbClient } from "../runner.js";
import type { ReviewItem } from "../schema.js";
import {
  parseJson,
  type Row,
  requiredLiteral,
  requiredString,
  row,
  rows,
  stringifyJson,
  withTransaction,
} from "./helpers.js";
import { RECORD_TYPES } from "./records.js";
import { insertReviewEvent, reviewEventId } from "./review-events.js";

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

  /**
   * Moves a review item to another state and records the decision. The event
   * targets the item's underlying record, but its id is keyed on the review
   * item so two items about the same record never collide.
   */
  async transition(workspaceId: string, input: ReviewTransitionInput): Promise<void> {
    withTransaction(this.#db, () => {
      const current = this.#itemById(workspaceId, input.id);
      if (current === undefined) {
        throw new Error("review item not found in workspace");
      }
      this.#db
        .prepare(
          "UPDATE review_items SET state = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
        )
        .run(input.toState, input.at, workspaceId, input.id);
      insertReviewEvent(this.#db, {
        id: reviewEventId({ type: RECORD_TYPES.reviewItem, id: input.id }, input.at, input.toState),
        workspaceId,
        targetType: current.targetType,
        targetId: current.targetId,
        fromState: current.state,
        toState: input.toState,
        actor: input.actor,
        notes: input.notes,
        createdAt: input.at,
      });
    });
  }

  async getById(workspaceId: string, id: string): Promise<ReviewItem | undefined> {
    return this.#itemById(workspaceId, id);
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

  #itemById(workspaceId: string, id: string): ReviewItem | undefined {
    const result = row(
      this.#db
        .prepare("SELECT * FROM review_items WHERE workspace_id = ? AND id = ?")
        .get(workspaceId, id),
    );
    return result === undefined ? undefined : itemFromRow(result);
  }
}

function itemFromRow(source: Row): ReviewItem {
  return {
    id: requiredString(source, "id"),
    workspaceId: requiredString(source, "workspace_id"),
    targetType: requiredString(source, "target_type"),
    targetId: requiredString(source, "target_id"),
    state: requiredLiteral(source, "state", isReviewState),
    reason: parseJson(requiredString(source, "reason_json")),
    createdAt: requiredString(source, "created_at"),
    updatedAt: requiredString(source, "updated_at"),
  };
}
