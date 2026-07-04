-- 0003_repositories: SQLite-backed repository tables for banking imports,
-- receipt review queues, and browser portal task run provenance.
--
-- Values follow the same portable conventions as earlier migrations: app-owned
-- TEXT ids/timestamps, JSON payloads as TEXT, and decimal strings as TEXT.

-- Banking --------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bank_accounts (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id),
  source_id      TEXT NOT NULL,
  external_id    TEXT NOT NULL,
  name           TEXT,
  iban           TEXT,
  currency       TEXT,
  product        TEXT,
  raw_json       TEXT NOT NULL,
  raw_record_id  TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, source_id, external_id),
  FOREIGN KEY (workspace_id, source_id) REFERENCES sources(workspace_id, id),
  FOREIGN KEY (workspace_id, raw_record_id) REFERENCES raw_source_records(workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_bank_accounts_workspace
  ON bank_accounts(workspace_id, source_id);

CREATE TABLE IF NOT EXISTS bank_balances (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id),
  source_id            TEXT NOT NULL,
  account_external_id  TEXT NOT NULL,
  balance_type         TEXT NOT NULL,
  amount               TEXT NOT NULL,
  currency             TEXT NOT NULL,
  reference_date       TEXT NOT NULL,
  raw_json             TEXT NOT NULL,
  raw_record_id        TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, source_id, account_external_id, balance_type, currency, reference_date),
  FOREIGN KEY (workspace_id, source_id) REFERENCES sources(workspace_id, id),
  FOREIGN KEY (workspace_id, raw_record_id) REFERENCES raw_source_records(workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_bank_balances_account
  ON bank_balances(workspace_id, source_id, account_external_id);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id),
  source_id            TEXT NOT NULL,
  account_external_id  TEXT NOT NULL,
  external_id          TEXT NOT NULL,
  booked_on            TEXT,
  value_date           TEXT,
  amount               TEXT NOT NULL,
  currency             TEXT NOT NULL,
  status               TEXT,
  counterparty_name    TEXT,
  remittance_info      TEXT,
  raw_json             TEXT NOT NULL,
  raw_record_id        TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, source_id, account_external_id, external_id),
  FOREIGN KEY (workspace_id, source_id) REFERENCES sources(workspace_id, id),
  FOREIGN KEY (workspace_id, raw_record_id) REFERENCES raw_source_records(workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_bank_transactions_account
  ON bank_transactions(workspace_id, source_id, account_external_id);

-- Review queue ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS review_items (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  target_type   TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  state         TEXT NOT NULL,
  reason_json   TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_review_items_target
  ON review_items(workspace_id, target_type, target_id);

-- Browser portal task provenance --------------------------------------------

CREATE TABLE IF NOT EXISTS portal_task_runs (
  run_id            TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
  task_id           TEXT NOT NULL,
  task_version      INTEGER NOT NULL,
  portal_domain     TEXT NOT NULL,
  browser_provider  TEXT NOT NULL,
  fetched_at        TEXT NOT NULL,
  UNIQUE (workspace_id, run_id)
);

CREATE INDEX IF NOT EXISTS idx_portal_task_runs_task
  ON portal_task_runs(workspace_id, task_id, fetched_at);
