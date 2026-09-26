/**
 * SQLite-backed sources and their credential references (`sources`,
 * `source_credentials` from `migrations/0001_core.sql`).
 *
 * A credential row never holds a secret: `secretRef` is the serialized
 * `SecretRef` the secret store resolves at sync time.
 */
import type { SecretRef, Source, SourceKind, SourceStatus } from "@sona/core";
import type { DbClient } from "../runner.js";
import {
  placeholders,
  type Row,
  requiredLiteral,
  requiredNumber,
  requiredString,
  row,
  rows,
} from "./helpers.js";

const SOURCE_KINDS = [
  "enable_banking",
  "fints",
  "email",
  "upload",
  "portal",
  "portfolio",
  "manual",
] as const satisfies readonly SourceKind[];

const SOURCE_STATUSES = [
  "active",
  "paused",
  "error",
  "revoked",
] as const satisfies readonly SourceStatus[];

function isSourceKind(value: string): value is SourceKind {
  return (SOURCE_KINDS as readonly string[]).includes(value);
}

function isSourceStatus(value: string): value is SourceStatus {
  return (SOURCE_STATUSES as readonly string[]).includes(value);
}

export interface SourceCredentialInput {
  id: string;
  sourceId: string;
  secretRef: SecretRef;
  createdAt: string;
}

export interface PersistedSourceCredential {
  id: string;
  workspaceId: string;
  sourceId: string;
  secretRef: SecretRef;
  createdAt: string;
}

/** A source the scheduler should sync, across workspaces. */
export interface SchedulableSource {
  workspaceId: string;
  sourceId: string;
  kind: SourceKind;
}

const SOURCE_SELECT =
  "SELECT id, workspace_id, kind, display_name, status, created_at FROM sources";

const CREDENTIAL_SELECT =
  "SELECT id, workspace_id, source_id, secret_ref, created_at FROM source_credentials";

export class SqliteSourceRepository {
  readonly #db: DbClient;

  constructor(db: DbClient) {
    this.#db = db;
  }

  /** Creates the source; an existing id in the workspace is left untouched. */
  async create(source: Source): Promise<Source> {
    this.#db
      .prepare(
        "INSERT INTO sources (id, workspace_id, kind, display_name, status, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id, id) DO NOTHING",
      )
      .run(
        source.id,
        source.workspaceId,
        source.kind,
        source.displayName,
        source.status,
        source.createdAt,
      );
    return this.#require(source.workspaceId, source.id);
  }

  async getById(workspaceId: string, id: string): Promise<Source | undefined> {
    const result = row(
      this.#db.prepare(`${SOURCE_SELECT} WHERE workspace_id = ? AND id = ?`).get(workspaceId, id),
    );
    return result === undefined ? undefined : sourceFromRow(result);
  }

  async list(workspaceId: string): Promise<Source[]> {
    return rows(
      this.#db
        .prepare(`${SOURCE_SELECT} WHERE workspace_id = ? ORDER BY created_at, id`)
        .all(workspaceId),
    ).map(sourceFromRow);
  }

  async setStatus(workspaceId: string, id: string, status: SourceStatus): Promise<Source> {
    this.#db
      .prepare("UPDATE sources SET status = ? WHERE workspace_id = ? AND id = ?")
      .run(status, workspaceId, id);
    return this.#require(workspaceId, id);
  }

  /**
   * Active sources of the given kinds across every workspace. This is the one
   * cross-workspace read, reserved for the scheduler (a system actor); every
   * job it enqueues carries the source's own workspace.
   */
  async listActiveForScheduler(kinds: readonly SourceKind[]): Promise<SchedulableSource[]> {
    if (kinds.length === 0) {
      return [];
    }
    return rows(
      this.#db
        .prepare(
          `SELECT workspace_id, id, kind FROM sources WHERE status = 'active' AND kind IN ${placeholders(kinds.length)} ORDER BY workspace_id, created_at, id`,
        )
        .all(...kinds),
    ).map((source) => ({
      workspaceId: requiredString(source, "workspace_id"),
      sourceId: requiredString(source, "id"),
      kind: requiredLiteral(source, "kind", isSourceKind),
    }));
  }

  /** Appends a credential reference; the newest one is the current credential. */
  async saveCredential(
    workspaceId: string,
    input: SourceCredentialInput,
  ): Promise<PersistedSourceCredential> {
    if (input.secretRef.workspaceId !== workspaceId) {
      throw new Error("secret ref does not belong to the source's workspace");
    }
    this.#db
      .prepare(
        "INSERT INTO source_credentials (id, workspace_id, source_id, secret_ref, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        input.id,
        workspaceId,
        input.sourceId,
        JSON.stringify(serializeSecretRef(input.secretRef)),
        input.createdAt,
      );
    const persisted = await this.currentCredential(workspaceId, input.sourceId);
    if (persisted === undefined) {
      throw new Error("source credential was not persisted");
    }
    return persisted;
  }

  /** The most recently saved credential reference for a source, if any. */
  async currentCredential(
    workspaceId: string,
    sourceId: string,
  ): Promise<PersistedSourceCredential | undefined> {
    const newest = rows(
      this.#db
        .prepare(
          `${CREDENTIAL_SELECT} WHERE workspace_id = ? AND source_id = ? AND created_at = (SELECT MAX(created_at) FROM source_credentials WHERE workspace_id = ? AND source_id = ?) ORDER BY id`,
        )
        .all(workspaceId, sourceId, workspaceId, sourceId),
    ).map(credentialFromRow);
    // Rotations recorded in the same instant are told apart by the secret's
    // monotonic version, not by id ordering.
    return newest.reduce<PersistedSourceCredential | undefined>(
      (best, candidate) =>
        best === undefined || candidate.secretRef.version >= best.secretRef.version
          ? candidate
          : best,
      undefined,
    );
  }

  async #require(workspaceId: string, id: string): Promise<Source> {
    const source = await this.getById(workspaceId, id);
    if (source === undefined) {
      throw new Error(`source ${id} not found in workspace`);
    }
    return source;
  }
}

function sourceFromRow(source: Row): Source {
  return {
    id: requiredString(source, "id"),
    workspaceId: requiredString(source, "workspace_id"),
    kind: requiredLiteral(source, "kind", isSourceKind),
    displayName: requiredString(source, "display_name"),
    status: requiredLiteral(source, "status", isSourceStatus),
    createdAt: requiredString(source, "created_at"),
  };
}

function credentialFromRow(source: Row): PersistedSourceCredential {
  const workspaceId = requiredString(source, "workspace_id");
  const secretRef = parseSecretRef(requiredString(source, "secret_ref"));
  if (secretRef.workspaceId !== workspaceId) {
    throw new Error("source credential secret ref belongs to another workspace");
  }
  return {
    id: requiredString(source, "id"),
    workspaceId,
    sourceId: requiredString(source, "source_id"),
    secretRef,
    createdAt: requiredString(source, "created_at"),
  };
}

function serializeSecretRef(ref: SecretRef): Record<string, string | number> {
  return { id: ref.id, workspaceId: ref.workspaceId, label: ref.label, version: ref.version };
}

function parseSecretRef(value: string): SecretRef {
  const parsed: unknown = JSON.parse(value);
  const source = row(parsed);
  if (source === undefined) {
    throw new Error("source credential secret_ref was not an object");
  }
  return {
    id: requiredString(source, "id"),
    workspaceId: requiredString(source, "workspaceId"),
    label: requiredString(source, "label"),
    version: requiredNumber(source, "version"),
  };
}
