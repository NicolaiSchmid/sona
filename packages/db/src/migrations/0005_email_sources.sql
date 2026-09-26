-- 0005_email_sources: per-run UID cursors for read-only IMAP email ingestion.
--
-- The cursor is recorded with the sync run that produced it, so every advance
-- is attributable to a run and the next run resumes from the most recent one.
-- Mailbox credentials never live here: they are secret-store references on
-- source_credentials.
--
-- Same portability rules as earlier migrations (TEXT ids/timestamps, composite
-- workspace-scoped foreign keys). `ALTER TABLE ADD COLUMN` is not idempotent in
-- SQLite, so the cursor is a child table instead of a column on source_sync_runs.

-- source_sync_runs was created without a (workspace_id, id) key; add one so
-- children can reference runs with the usual workspace-scoped composite FK.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_runs_workspace_id ON source_sync_runs(workspace_id, id);

-- Insert-only: one row per finished run that produced a cursor.
CREATE TABLE IF NOT EXISTS email_sync_cursors (
  run_id        TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  source_id     TEXT NOT NULL,
  folder        TEXT NOT NULL,
  -- IMAP UIDVALIDITY (32-bit unsigned) as a decimal string.
  uid_validity  TEXT NOT NULL,
  -- Highest UID up to which every message was ingested successfully. IMAP UIDs
  -- are unsigned 32-bit, which overflows PostgreSQL's signed INTEGER.
  last_uid      BIGINT NOT NULL,
  -- Fingerprint of the ingestion policy (allowlist, MIME/size rules) the cursor
  -- was built under; a change triggers a rescan from UID 1.
  policy_hash   TEXT NOT NULL,
  -- When the run finished and the cursor was written.
  recorded_at   TEXT NOT NULL,
  FOREIGN KEY (workspace_id, source_id) REFERENCES sources(workspace_id, id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES source_sync_runs(workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_email_sync_cursors_source
  ON email_sync_cursors(workspace_id, source_id, folder, recorded_at);

-- Message-ID dedup looks raw records up by provider identity on every scanned
-- message; without this the lookup scans the source's whole raw record set.
CREATE INDEX IF NOT EXISTS idx_raw_records_external
  ON raw_source_records(workspace_id, source_id, external_id);
