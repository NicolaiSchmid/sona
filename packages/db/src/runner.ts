import type { Migration } from "./migrations/index";

/**
 * Minimal executor a database driver must provide to run migrations. Both
 * `node:sqlite`'s `DatabaseSync` and a thin Postgres wrapper satisfy this with
 * a single `exec`, including the `BEGIN`/`COMMIT`/`ROLLBACK` used below. SQLite
 * and PostgreSQL both support transactional DDL, so a migration either lands in
 * full or not at all.
 */
export interface SqlExecutor {
  exec(sql: string): void;
}

/**
 * Applies migrations in order, each inside its own transaction. If a
 * multi-statement migration fails partway through, the transaction is rolled
 * back so the schema is never left partially installed. Migration SQL uses
 * `IF NOT EXISTS`, so applying the same set more than once is safe.
 */
export function applyMigrations(db: SqlExecutor, migrations: readonly Migration[]): void {
  for (const migration of migrations) {
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Ignore rollback failures; surface the original migration error below.
      }
      throw error;
    }
  }
}
