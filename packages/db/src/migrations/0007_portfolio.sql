-- 0007_portfolio: broker accounts, securities, normalized portfolio events, and
-- informational valuation snapshots imported from Portfolio Performance.
--
-- Numbering: 0004–0006 and 0008 are reserved for phases developed in parallel
-- (worker jobs, email ingestion, portal runner, assets); the gap is intentional.
--
-- Conventions follow earlier migrations: app-owned TEXT ids/timestamps, JSON
-- as TEXT, decimal strings as TEXT, and composite (workspace_id, parent_id)
-- foreign keys so no row can reference another workspace's parent.
--
-- Portfolio events are evidence, not ledger postings: draft ledger transactions
-- are derived from them and reviewed separately. Valuations are append-only
-- reference data and never enter the double-entry ledger.

CREATE TABLE IF NOT EXISTS broker_accounts (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  source_id     TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL,
  currency      TEXT,
  updated_at    TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, source_id, external_id),
  FOREIGN KEY (workspace_id, source_id) REFERENCES sources(workspace_id, id)
);

CREATE TABLE IF NOT EXISTS securities (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  security_key  TEXT NOT NULL,
  isin          TEXT,
  wkn           TEXT,
  ticker        TEXT,
  name          TEXT,
  updated_at    TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, security_key)
);

CREATE TABLE IF NOT EXISTS portfolio_events (
  id                          TEXT PRIMARY KEY,
  workspace_id                TEXT NOT NULL REFERENCES workspaces(id),
  source_id                   TEXT NOT NULL,
  external_id                 TEXT NOT NULL,
  broker_account_external_id  TEXT NOT NULL,
  kind                        TEXT NOT NULL,
  event_type                  TEXT NOT NULL,
  event_date                  TEXT NOT NULL,
  amount                      TEXT NOT NULL,
  currency                    TEXT NOT NULL,
  isin                        TEXT,
  wkn                         TEXT,
  ticker                      TEXT,
  security_name               TEXT,
  shares                      TEXT,
  gross_amount                TEXT,
  gross_currency              TEXT,
  exchange_rate               TEXT,
  fees                        TEXT,
  taxes                       TEXT,
  note                        TEXT,
  raw_json                    TEXT NOT NULL,
  raw_record_id               TEXT NOT NULL,
  created_at                  TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, source_id, external_id),
  FOREIGN KEY (workspace_id, source_id) REFERENCES sources(workspace_id, id),
  FOREIGN KEY (workspace_id, raw_record_id) REFERENCES raw_source_records(workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_portfolio_events_date
  ON portfolio_events(workspace_id, source_id, event_date);

-- broker_account_ref / security_key use '' (not NULL) when unknown so the
-- point-in-time uniqueness constraint stays portable.
CREATE TABLE IF NOT EXISTS portfolio_valuations (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id),
  source_id           TEXT NOT NULL,
  broker_account_ref  TEXT NOT NULL,
  security_key        TEXT NOT NULL,
  isin                TEXT,
  wkn                 TEXT,
  ticker              TEXT,
  security_name       TEXT,
  as_of               TEXT NOT NULL,
  shares              TEXT,
  market_value        TEXT NOT NULL,
  currency            TEXT NOT NULL,
  valuation_source    TEXT NOT NULL,
  raw_record_id       TEXT,
  created_at          TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, source_id, broker_account_ref, security_key, as_of),
  FOREIGN KEY (workspace_id, source_id) REFERENCES sources(workspace_id, id),
  FOREIGN KEY (workspace_id, raw_record_id) REFERENCES raw_source_records(workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_portfolio_valuations_as_of
  ON portfolio_valuations(workspace_id, source_id, as_of);
