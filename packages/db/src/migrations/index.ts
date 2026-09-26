import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** A single forward-only schema migration. */
export interface Migration {
  /** Sortable id, e.g. "0001_core". */
  id: string;
  /** Raw SQL, portable across SQLite and PostgreSQL. */
  sql: string;
}

function load(file: string): string {
  // Compiled output lives in `dist/migrations/`; a plain `tsc` build does not
  // copy `.sql` assets, so fall back to the source directory next to it.
  for (const base of [import.meta.url, new URL("../../src/migrations/", import.meta.url).href]) {
    const path = fileURLToPath(new URL(file, base));
    if (existsSync(path)) {
      return readFileSync(path, "utf8");
    }
  }
  throw new Error(`migration file not found: ${file}`);
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
  { id: "0003_repositories", sql: load("./0003_repositories.sql") },
  { id: "0004_ledger_repositories", sql: load("./0004_ledger_repositories.sql") },
  { id: "0005_email_sources", sql: load("./0005_email_sources.sql") },
  { id: "0006_assets", sql: load("./0006_assets.sql") },
  { id: "0007_portfolio", sql: load("./0007_portfolio.sql") },
  { id: "0008_jobs", sql: load("./0008_jobs.sql") },
];
