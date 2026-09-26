-- 0010_adapters: Paperless import cursors and accountant share links.
--
-- Numbering: 0008 and 0009 are reserved for phases developed in parallel
-- (worker jobs, auth/tenancy); the gap is intentional.
--
-- Conventions follow earlier migrations: app-owned TEXT ids/timestamps,
-- INTEGER counters, composite (workspace_id, parent_id) foreign keys so no row
-- can reference another workspace's parent.

-- Insert-only: one row per finished Paperless sync run that produced a cursor.
-- The cursor is the (modified, id) position of the last fully imported
-- document; the policy hash triggers a rescan when import rules change.
CREATE TABLE IF NOT EXISTS paperless_sync_cursors (
  run_id            TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
  source_id         TEXT NOT NULL,
  -- `modified` timestamp of the last fully processed document, as returned by Paperless.
  last_modified     TEXT NOT NULL,
  -- Its Paperless document id; breaks ties among documents modified at the same instant.
  last_document_id  BIGINT NOT NULL,
  policy_hash       TEXT NOT NULL,
  recorded_at       TEXT NOT NULL,
  FOREIGN KEY (workspace_id, source_id) REFERENCES sources(workspace_id, id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES source_sync_runs(workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_paperless_sync_cursors_source
  ON paperless_sync_cursors(workspace_id, source_id, recorded_at);

-- Expiring, revocable, read-only share links for accountant packages. Only the
-- SHA-256 of the bearer token is stored; the package itself lives in document
-- storage under package_document_id and is identified by its own hash.
CREATE TABLE IF NOT EXISTS accountant_share_links (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id),
  package_document_id  TEXT NOT NULL,
  package_sha256       TEXT NOT NULL,
  tax_year             INTEGER NOT NULL,
  token_hash           TEXT NOT NULL,
  created_by           TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  expires_at           TEXT NOT NULL,
  max_downloads        INTEGER NOT NULL,
  download_count       INTEGER NOT NULL DEFAULT 0,
  revoked_at           TEXT,
  UNIQUE (workspace_id, id)
);

-- Tokens are looked up without a workspace (the recipient has no account), so
-- the hash must be globally unique.
CREATE UNIQUE INDEX IF NOT EXISTS uq_accountant_share_links_token
  ON accountant_share_links(token_hash);

CREATE INDEX IF NOT EXISTS idx_accountant_share_links_workspace
  ON accountant_share_links(workspace_id, created_at);
