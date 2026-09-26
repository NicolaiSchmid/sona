-- 0006_assets: asset registry, cost components, append-only asset history,
-- versioned depreciation schedule configuration, and generated depreciation
-- entries.
--
-- Same portable conventions as earlier migrations: app-owned TEXT ids and
-- timestamps, decimal strings as TEXT, JSON as TEXT, INTEGER 0/1 booleans, and
-- composite (workspace_id, parent_id) foreign keys for tenant isolation.
--
-- Shape choices: components are a table because asset_events must reference
-- them by foreign key and they carry positional identity; acquisition side
-- costs and evidence document ids are JSON columns because they are only ever
-- read and written as a whole together with the asset.

CREATE TABLE IF NOT EXISTS assets (
  id                          TEXT PRIMARY KEY,
  workspace_id                TEXT NOT NULL REFERENCES workspaces(id),
  kind                        TEXT NOT NULL,
  name                        TEXT NOT NULL,
  commodity                   TEXT NOT NULL,
  acquired_on                 TEXT NOT NULL,
  -- Acquisition side costs (label, amount, evidence) as a JSON array.
  acquisition_side_costs_json TEXT NOT NULL,
  -- Purchase contract and other acquisition evidence document ids.
  evidence_document_ids_json  TEXT NOT NULL,
  created_at                  TEXT NOT NULL,
  UNIQUE (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_assets_workspace ON assets(workspace_id, kind);

-- Component ids are scoped to their asset (the domain model only requires
-- uniqueness within one asset), hence the composite primary key.
CREATE TABLE IF NOT EXISTS asset_components (
  id            TEXT NOT NULL,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  asset_id      TEXT NOT NULL,
  position      INTEGER NOT NULL,
  role          TEXT NOT NULL,
  label         TEXT NOT NULL,
  cost          TEXT NOT NULL,
  depreciable   INTEGER NOT NULL CHECK (depreciable IN (0, 1)),
  PRIMARY KEY (workspace_id, asset_id, id),
  UNIQUE (workspace_id, asset_id, position),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES assets(workspace_id, id)
);

-- Append-only history: improvements (nachträgliche Herstellungskosten),
-- disposals, and retractions. Rows are never updated; a wrong event is
-- retracted by a later `retraction` row and a corrected event appended. An
-- improvement's component must belong to the same asset.
CREATE TABLE IF NOT EXISTS asset_events (
  id                          TEXT PRIMARY KEY,
  workspace_id                TEXT NOT NULL REFERENCES workspaces(id),
  asset_id                    TEXT NOT NULL,
  kind                        TEXT NOT NULL,
  component_id                TEXT,
  retracts_event_id           TEXT,
  occurred_on                 TEXT NOT NULL,
  description                 TEXT NOT NULL,
  amount                      TEXT,
  commodity                   TEXT,
  evidence_document_ids_json  TEXT NOT NULL,
  created_at                  TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, asset_id, id),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES assets(workspace_id, id),
  FOREIGN KEY (workspace_id, asset_id, component_id)
    REFERENCES asset_components(workspace_id, asset_id, id),
  -- A retraction may only target an event of the same asset.
  FOREIGN KEY (workspace_id, asset_id, retracts_event_id)
    REFERENCES asset_events(workspace_id, asset_id, id)
);

CREATE INDEX IF NOT EXISTS idx_asset_events_asset
  ON asset_events(workspace_id, asset_id, occurred_on);

-- Versioned schedule configuration. A new version is appended when the user
-- changes rate/method/accounts; generated entries keep pointing at theirs.
CREATE TABLE IF NOT EXISTS asset_depreciation_schedules (
  id                                TEXT PRIMARY KEY,
  workspace_id                      TEXT NOT NULL REFERENCES workspaces(id),
  asset_id                          TEXT NOT NULL,
  version                           INTEGER NOT NULL,
  method_json                       TEXT NOT NULL,
  pro_rata_temporis                 INTEGER NOT NULL CHECK (pro_rata_temporis IN (0, 1)),
  residual_value                    TEXT,
  residual_commodity                TEXT,
  rounding_scale                    INTEGER,
  expense_account                   TEXT NOT NULL,
  accumulated_depreciation_account  TEXT NOT NULL,
  created_at                        TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, asset_id, id),
  UNIQUE (workspace_id, asset_id, version),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES assets(workspace_id, id)
);

-- Insert-only log of generated depreciation transactions, one row per
-- transaction. A year may accumulate several rows over time (a superseded
-- draft and its replacement); which one is live is the ledger transaction's
-- review state. Recorded rows are never rewritten by recomputation;
-- corrections happen via explicit adjustment postings. transaction_id
-- references the ledger polymorphically (like evidence_links), so it carries
-- no SQL foreign key.
CREATE TABLE IF NOT EXISTS asset_depreciation_entries (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  asset_id        TEXT NOT NULL,
  config_id       TEXT NOT NULL,
  year            INTEGER NOT NULL,
  transaction_id  TEXT NOT NULL,
  amount          TEXT NOT NULL,
  commodity       TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, transaction_id),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES assets(workspace_id, id),
  -- The config must belong to the same asset as the entry.
  FOREIGN KEY (workspace_id, asset_id, config_id)
    REFERENCES asset_depreciation_schedules(workspace_id, asset_id, id)
);

CREATE INDEX IF NOT EXISTS idx_asset_depreciation_entries_year
  ON asset_depreciation_entries(workspace_id, asset_id, year);
