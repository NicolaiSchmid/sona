/**
 * SQLite-backed append-only audit log. There is deliberately no update or
 * delete API: an audit event, once written, is immutable. Callers are
 * responsible for keeping `metadata` to a redacted summary — never raw
 * credentials, tokens, or full financial payloads.
 *
 * Timestamps must carry an explicit offset and are stored in canonical
 * `toISOString()` form, so the `(created_at, id)` keyset order is
 * chronological regardless of the writer's offset or precision.
 */
import type { AuditEvent } from "@sona/core";
import type { DbClient, DbValue } from "../runner.js";
import {
  optionalString,
  parseJson,
  type Row,
  requiredString,
  row,
  rows,
  stringifyJson,
} from "./helpers.js";

/** Keyset cursor: events are ordered by `(createdAt, id)`. */
export interface AuditEventCursor {
  createdAt: string;
  id: string;
}

export interface ListAuditEventsOptions {
  /** Page size; defaults to 100, capped at 1000. */
  limit?: number;
  /** Return events strictly after this cursor. */
  after?: AuditEventCursor;
}

export interface AuditEventPage {
  events: AuditEvent[];
  /** Cursor for the next page, or undefined when this was the last page. */
  nextCursor: AuditEventCursor | undefined;
}

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;

/** ISO-8601 date-time with an explicit `Z` or `±HH:MM` offset (no host-local guessing). */
const OFFSET_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

const EVENT_SELECT =
  "SELECT id, workspace_id, action, actor, target_type, target_id, metadata_json, created_at FROM audit_events";

export class SqliteAuditEventRepository {
  readonly #db: DbClient;

  constructor(db: DbClient) {
    this.#db = db;
  }

  async append(event: AuditEvent): Promise<void> {
    if (event.actor.trim() === "") {
      throw new Error("audit event actor is required");
    }
    const createdAt = canonicalTimestamp(event.createdAt);
    const existing = await this.getById(event.workspaceId, event.id);
    if (existing !== undefined) {
      throw new Error("audit events are append-only");
    }
    this.#db
      .prepare(
        "INSERT INTO audit_events (id, workspace_id, action, actor, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        event.id,
        event.workspaceId,
        event.action,
        event.actor,
        event.targetType ?? null,
        event.targetId ?? null,
        event.metadata === undefined ? null : stringifyJson(event.metadata),
        createdAt,
      );
  }

  async getById(workspaceId: string, id: string): Promise<AuditEvent | undefined> {
    const result = row(
      this.#db.prepare(`${EVENT_SELECT} WHERE workspace_id = ? AND id = ?`).get(workspaceId, id),
    );
    return result === undefined ? undefined : eventFromRow(result);
  }

  /** Lists a workspace's events oldest-first with keyset pagination. */
  async list(workspaceId: string, options: ListAuditEventsOptions = {}): Promise<AuditEventPage> {
    const limit = pageSize(options.limit);
    const clauses = ["workspace_id = ?"];
    const params: DbValue[] = [workspaceId];
    if (options.after !== undefined) {
      const after = canonicalTimestamp(options.after.createdAt);
      clauses.push("(created_at > ? OR (created_at = ? AND id > ?))");
      params.push(after, after, options.after.id);
    }
    // Fetch one extra row to learn whether another page exists.
    params.push(limit + 1);

    const events = rows(
      this.#db
        .prepare(`${EVENT_SELECT} WHERE ${clauses.join(" AND ")} ORDER BY created_at, id LIMIT ?`)
        .all(...params),
    ).map(eventFromRow);

    if (events.length <= limit) {
      return { events, nextCursor: undefined };
    }
    const page = events.slice(0, limit);
    const last = page[page.length - 1];
    return {
      events: page,
      nextCursor: last === undefined ? undefined : { createdAt: last.createdAt, id: last.id },
    };
  }
}

function canonicalTimestamp(value: string): string {
  const time = OFFSET_DATETIME_RE.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(time)) {
    throw new Error(
      `audit event timestamp must be an ISO-8601 date-time with an explicit offset, got ${JSON.stringify(value)}`,
    );
  }
  return new Date(time).toISOString();
}

function pageSize(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_PAGE_SIZE;
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`audit event page limit must be a positive integer, got ${String(limit)}`);
  }
  return Math.min(limit, MAX_PAGE_SIZE);
}

function eventFromRow(source: Row): AuditEvent {
  const targetType = optionalString(source, "target_type");
  const targetId = optionalString(source, "target_id");
  const metadata = optionalString(source, "metadata_json");
  return {
    id: requiredString(source, "id"),
    workspaceId: requiredString(source, "workspace_id"),
    action: requiredString(source, "action"),
    actor: requiredString(source, "actor"),
    ...(targetType === undefined ? {} : { targetType }),
    ...(targetId === undefined ? {} : { targetId }),
    ...(metadata === undefined ? {} : { metadata: parseJson(metadata) }),
    createdAt: requiredString(source, "created_at"),
  };
}
