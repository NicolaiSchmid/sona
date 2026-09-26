import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { CORE_MIGRATIONS } from "./migrations/index";
import { applyMigrations } from "./runner";
import { CORE_TABLES, LEDGER_REPOSITORY_TABLES, RECEIPT_TABLES, REPOSITORY_TABLES } from "./schema";

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
      for (const table of [
        ...CORE_TABLES,
        ...RECEIPT_TABLES,
        ...REPOSITORY_TABLES,
        ...LEDGER_REPOSITORY_TABLES,
      ]) {
        expect(names.has(table), `missing table ${table}`).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it("enforces the document content-hash dedup index", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyMigrations(db, CORE_MIGRATIONS);
      db.exec(
        "INSERT INTO workspaces (id, name, created_at) VALUES ('ws_1', 'A', '2026-01-01T00:00:00Z')",
      );
      const insertDoc = (id: string) =>
        db.exec(
          "INSERT INTO documents (id, workspace_id, content_hash, mime_type, original_filename, storage_uri, source_kind, retention_state, created_at)" +
            ` VALUES ('${id}', 'ws_1', 'hash_same', 'application/pdf', 'r.pdf', 's3://x', 'upload', 'active', '2026-01-01T00:00:00Z')`,
        );
      insertDoc("doc_1");
      expect(() => insertDoc("doc_2")).toThrow(/UNIQUE constraint failed/i);
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
      expect(() => insertRaw("raw_2")).toThrow(/UNIQUE constraint failed/i);
    } finally {
      db.close();
    }
  });

  it("enforces the ledger repository constraints at the schema level", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyMigrations(db, CORE_MIGRATIONS);
      db.exec("PRAGMA foreign_keys = ON");
      for (const ws of ["ws_1", "ws_2"]) {
        db.exec(
          `INSERT INTO workspaces (id, name, created_at) VALUES ('${ws}', 'Test', '2026-01-01T00:00:00Z')`,
        );
      }
      const insertTx = (id: string, ws: string) =>
        db.exec(
          "INSERT INTO ledger_transactions (id, workspace_id, booked_on, description, review_state, created_at)" +
            ` VALUES ('${id}', '${ws}', '2026-01-01', 'synthetic', 'draft', '2026-01-01T00:00:00Z')`,
        );
      insertTx("tx_a", "ws_1");
      insertTx("tx_b", "ws_1");
      insertTx("tx_c", "ws_1");
      insertTx("tx_z", "ws_2");

      // Supersession chain is linear: an original is superseded at most once,
      // a replacement replaces at most one, and both ends live in the workspace.
      const supersede = (ws: string, tx: string, supersedes: string) =>
        db.exec(
          "INSERT INTO ledger_transaction_supersessions (workspace_id, transaction_id, supersedes_transaction_id, superseded_at)" +
            ` VALUES ('${ws}', '${tx}', '${supersedes}', '2026-01-02T00:00:00Z')`,
        );
      supersede("ws_1", "tx_b", "tx_a");
      expect(() => supersede("ws_1", "tx_c", "tx_a")).toThrow(/UNIQUE constraint failed/i);
      expect(() => supersede("ws_1", "tx_b", "tx_c")).toThrow(/UNIQUE constraint failed/i);
      expect(() => supersede("ws_1", "tx_c", "tx_z")).toThrow(/FOREIGN KEY constraint failed/i);
      expect(() => supersede("ws_2", "tx_z", "tx_a")).toThrow(/FOREIGN KEY constraint failed/i);
      expect(() => supersede("ws_1", "tx_c", "tx_missing")).toThrow(
        /FOREIGN KEY constraint failed/i,
      );

      // Idempotency keys: unique per workspace, one per transaction, reusable elsewhere.
      const insertKey = (ws: string, key: string, tx: string) =>
        db.exec(
          "INSERT INTO ledger_transaction_idempotency_keys (workspace_id, idempotency_key, transaction_id)" +
            ` VALUES ('${ws}', '${key}', '${tx}')`,
        );
      insertKey("ws_1", "import:1", "tx_a");
      expect(() => insertKey("ws_1", "import:1", "tx_c")).toThrow(/UNIQUE constraint failed/i);
      expect(() => insertKey("ws_1", "import:2", "tx_a")).toThrow(/UNIQUE constraint failed/i);
      expect(() => insertKey("ws_2", "import:2", "tx_a")).toThrow(/FOREIGN KEY constraint failed/i);
      expect(() => insertKey("ws_2", "import:1", "tx_z")).not.toThrow();

      // Evidence edges are unique on (workspace, from, to, kind).
      const insertEdge = (id: string, ws: string, kind: string) =>
        db.exec(
          "INSERT INTO evidence_links (id, workspace_id, from_type, from_id, to_type, to_id, kind, created_at)" +
            ` VALUES ('${id}', '${ws}', 'document', 'doc_1', 'ledger_transaction', 'tx_a', '${kind}', '2026-01-01T00:00:00Z')`,
        );
      insertEdge("el_1", "ws_1", "substantiates");
      expect(() => insertEdge("el_2", "ws_1", "substantiates")).toThrow(
        /UNIQUE constraint failed/i,
      );
      expect(() => insertEdge("el_3", "ws_1", "imported_as")).not.toThrow();
      expect(() => insertEdge("el_4", "ws_2", "substantiates")).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("deduplicates pre-existing evidence edges before adding the unique index", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyMigrations(
        db,
        CORE_MIGRATIONS.filter((migration) => migration.id < "0004"),
      );
      db.exec(
        "INSERT INTO workspaces (id, name, created_at) VALUES ('ws_1', 'A', '2026-01-01T00:00:00Z')",
      );
      const insertEdge = (id: string, kind: string, createdAt: string) =>
        db.exec(
          "INSERT INTO evidence_links (id, workspace_id, from_type, from_id, to_type, to_id, kind, created_at)" +
            ` VALUES ('${id}', 'ws_1', 'document', 'doc_1', 'ledger_transaction', 'tx_1', '${kind}', '${createdAt}')`,
        );
      insertEdge("el_late", "substantiates", "2026-01-02T00:00:00Z");
      insertEdge("el_early", "substantiates", "2026-01-01T00:00:00Z");
      insertEdge("el_tie_b", "imported_as", "2026-01-03T00:00:00Z");
      insertEdge("el_tie_a", "imported_as", "2026-01-03T00:00:00Z");

      applyMigrations(
        db,
        CORE_MIGRATIONS.filter((migration) => migration.id >= "0004"),
      );

      const remaining = db.prepare("SELECT id FROM evidence_links ORDER BY id").all() as Array<{
        id: string;
      }>;
      expect(remaining.map((r) => r.id)).toEqual(["el_early", "el_tie_a"]);
      expect(() => insertEdge("el_dup", "substantiates", "2026-01-04T00:00:00Z")).toThrow(
        /UNIQUE constraint failed/i,
      );
    } finally {
      db.close();
    }
  });

  it("rejects a child row that references a parent in another workspace", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyMigrations(db, CORE_MIGRATIONS);
      db.exec("PRAGMA foreign_keys = ON");
      db.exec(
        "INSERT INTO workspaces (id, name, created_at) VALUES ('ws_1', 'A', '2026-01-01T00:00:00Z')",
      );
      db.exec(
        "INSERT INTO workspaces (id, name, created_at) VALUES ('ws_2', 'B', '2026-01-01T00:00:00Z')",
      );
      db.exec(
        "INSERT INTO sources (id, workspace_id, kind, display_name, status, created_at)" +
          " VALUES ('src_1', 'ws_1', 'manual', 'Manual', 'active', '2026-01-01T00:00:00Z')",
      );
      // ws_2 trying to attach a raw record to ws_1's source must fail the
      // composite (workspace_id, source_id) foreign key.
      expect(() =>
        db.exec(
          "INSERT INTO raw_source_records (id, workspace_id, source_id, record_type, payload_json, payload_hash, observed_at, created_at)" +
            " VALUES ('raw_x', 'ws_2', 'src_1', 'bank_transaction', '{}', 'h', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        ),
      ).toThrow(/FOREIGN KEY constraint failed/i);
    } finally {
      db.close();
    }
  });
});
