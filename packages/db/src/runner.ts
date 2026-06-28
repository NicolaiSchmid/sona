import type { Migration } from "./migrations/index";

/**
 * Minimal executor a database driver must provide to run migrations. Both
 * `node:sqlite`'s `DatabaseSync` and a thin Postgres wrapper satisfy this.
 */
export interface SqlExecutor {
  exec(sql: string): void;
}

/**
 * Applies migrations in order. Migration SQL uses `IF NOT EXISTS`, so applying
 * the same set more than once is safe (idempotent at the DDL level).
 */
export function applyMigrations(db: SqlExecutor, migrations: readonly Migration[]): void {
  for (const migration of migrations) {
    db.exec(migration.sql);
  }
}
