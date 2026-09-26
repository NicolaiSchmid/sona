import { createRequire } from "node:module";
import { CORE_MIGRATIONS } from "../migrations/index.js";
import {
  applyMigrations,
  createSqliteDbClient,
  type DbClient,
  type SqliteDatabase,
} from "../runner.js";

// node:sqlite is a newer built-in the bundled Vite version does not recognize as
// external, so a static `import ... from "node:sqlite"` gets bundled and fails.
// Loading it through a runtime require keeps it opaque to Vite's transform.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export interface TestDatabase {
  db: DbClient;
  close: () => void;
}

/**
 * In-memory SQLite with every migration applied, foreign keys enforced, and two
 * tenants seeded (`ws_1`/`src_1`, `ws_2`/`src_2`) for isolation tests.
 */
export function createTestDatabase(): TestDatabase {
  const sqlite = new DatabaseSync(":memory:") as SqliteDatabase;
  sqlite.exec("PRAGMA foreign_keys = ON");
  const db = createSqliteDbClient(sqlite);
  applyMigrations(db, CORE_MIGRATIONS);
  seedTenant(db, "ws_1", "src_1");
  seedTenant(db, "ws_2", "src_2");
  return {
    db,
    close: () => sqlite.close(),
  };
}

function seedTenant(db: DbClient, workspaceId: string, sourceId: string): void {
  db.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)").run(
    workspaceId,
    `Workspace ${workspaceId}`,
    "2026-01-01T00:00:00Z",
  );
  db.prepare(
    "INSERT INTO sources (id, workspace_id, kind, display_name, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    sourceId,
    workspaceId,
    "enable_banking",
    `Source ${sourceId}`,
    "active",
    "2026-01-01T00:00:00Z",
  );
}
