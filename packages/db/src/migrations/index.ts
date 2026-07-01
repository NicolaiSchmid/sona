import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** A single forward-only schema migration. */
export interface Migration {
  /** Sortable id, e.g. "0001_core". */
  id: string;
  /** Raw SQL, portable across SQLite and PostgreSQL. */
  sql: string;
}

function load(file: string): string {
  return readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
}

/**
 * Ordered list of core migrations. The `.sql` files are the source of truth so
 * they stay readable and usable by external migration tooling.
 *
 * The SQL is read relative to this module. Packages are consumed from source
 * via the pnpm workspace (Vitest/tsx), and bundled for production, so the
 * `.sql` sits next to this file at resolution time. A plain `tsc` build emits
 * declarations only and does not copy `.sql` assets.
 */
export const CORE_MIGRATIONS: readonly Migration[] = [
  { id: "0001_core", sql: load("./0001_core.sql") },
  { id: "0002_receipts", sql: load("./0002_receipts.sql") },
];
