import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { CORE_MIGRATIONS } from "./migrations/index";
import { applyMigrations } from "./runner";
import { CORE_TABLES } from "./schema";

// node:sqlite is a newer built-in the bundled Vite version does not recognize as
// external, so a static `import ... from "node:sqlite"` gets bundled and fails.
// Loading it through a runtime require keeps it opaque to Vite's transform.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type DatabaseSync = InstanceType<typeof DatabaseSync>;

function tableNames(db: DatabaseSync): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((r) => r.name));
}

describe("core migrations", () => {
  it("creates every core table in an in-memory SQLite database", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyMigrations(db, CORE_MIGRATIONS);
      const names = tableNames(db);
      for (const table of CORE_TABLES) {
        expect(names.has(table), `missing table ${table}`).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it("is idempotent when applied twice", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyMigrations(db, CORE_MIGRATIONS);
      expect(() => applyMigrations(db, CORE_MIGRATIONS)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("enforces the raw-record dedup unique index", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyMigrations(db, CORE_MIGRATIONS);
      db.exec(
        "INSERT INTO workspaces (id, name, created_at) VALUES ('ws_1', 'Test', '2026-01-01T00:00:00Z')",
      );
      db.exec(
        "INSERT INTO sources (id, workspace_id, kind, display_name, status, created_at)" +
          " VALUES ('src_1', 'ws_1', 'manual', 'Manual', 'active', '2026-01-01T00:00:00Z')",
      );
      const insertRaw = (id: string) =>
        db.exec(
          `INSERT INTO raw_source_records (id, workspace_id, source_id, record_type, payload_json, payload_hash, observed_at, created_at)` +
            ` VALUES ('${id}', 'ws_1', 'src_1', 'bank_transaction', '{}', 'hash_dup', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
        );
      insertRaw("raw_1");
      expect(() => insertRaw("raw_2")).toThrow();
    } finally {
      db.close();
    }
  });
});
