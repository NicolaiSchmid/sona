/**
 * The shared `review_events` log: every review-state transition on any record
 * (review items, ledger transactions, ...) is appended here with its actor.
 */
import { isReviewState, type ReviewEvent, type ReviewState } from "@sona/core";
import type { DbClient } from "../runner.js";
import { optionalString, type Row, requiredLiteral, requiredString, rows } from "./helpers.js";
import type { RecordRef } from "./records.js";

/**
 * Deterministic id for the transition recorded against `key` at `at`. The
 * target state is part of the id so a transition and a supersession (or two
 * distinct transitions) at the same instant do not collide.
 */
export function reviewEventId(key: RecordRef, at: string, toState: ReviewState): string {
  return `review_event:${key.type}:${key.id}:${at}:${toState}`;
}

/** Appends a review event; meant to be called inside the caller's transaction. */
export function insertReviewEvent(db: DbClient, event: ReviewEvent): void {
  if (event.actor.trim() === "") {
    throw new Error("review event actor is required");
  }
  db.prepare(
    "INSERT INTO review_events (id, workspace_id, target_type, target_id, from_state, to_state, actor, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    event.id,
    event.workspaceId,
    event.targetType,
    event.targetId,
    event.fromState,
    event.toState,
    event.actor,
    event.notes ?? null,
    event.createdAt,
  );
}

const EVENT_SELECT =
  "SELECT id, workspace_id, target_type, target_id, from_state, to_state, actor, notes, created_at FROM review_events";

export class SqliteReviewEventRepository {
  readonly #db: DbClient;

  constructor(db: DbClient) {
    this.#db = db;
  }

  async append(event: ReviewEvent): Promise<void> {
    insertReviewEvent(this.#db, event);
  }

  /** Transition history of one record, oldest first. */
  async listForTarget(workspaceId: string, target: RecordRef): Promise<ReviewEvent[]> {
    return rows(
      this.#db
        .prepare(
          `${EVENT_SELECT} WHERE workspace_id = ? AND target_type = ? AND target_id = ? ORDER BY created_at, id`,
        )
        .all(workspaceId, target.type, target.id),
    ).map(eventFromRow);
  }
}

function eventFromRow(source: Row): ReviewEvent {
  return {
    id: requiredString(source, "id"),
    workspaceId: requiredString(source, "workspace_id"),
    targetType: requiredString(source, "target_type"),
    targetId: requiredString(source, "target_id"),
    fromState: requiredLiteral(source, "from_state", isReviewState),
    toState: requiredLiteral(source, "to_state", isReviewState),
    actor: requiredString(source, "actor"),
    notes: optionalString(source, "notes"),
    createdAt: requiredString(source, "created_at"),
  };
}
