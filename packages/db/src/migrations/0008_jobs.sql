-- 0008_jobs: SQLite-backed background job queue and job run provenance for
-- the worker (source sync, document ingest, extraction, reconciliation, export
-- generation).
--
-- Same portable conventions as earlier migrations: app-owned TEXT ids and
-- ISO-8601 timestamps, JSON payloads as TEXT, INTEGER counters.

-- One row per logical job. `idempotency_key` is derived from the job kind and
-- payload (e.g. `source_sync:<sourceId>:<window>`), so enqueueing the same
-- work twice is a no-op within a workspace.
--
-- Claim semantics: a worker moves a `queued` job whose `run_after` has passed
-- to `running`, taking a lease (`lease_owner`, `lease_until`). A lease that
-- expires without a terminal write may be taken over by another worker, which
-- keeps a single worker safe today and leaves room for several later.
CREATE TABLE IF NOT EXISTS jobs (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id),
  kind             TEXT NOT NULL,
  payload_json     TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL,
  -- queued | running | succeeded | dead
  status           TEXT NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL,
  run_after        TEXT NOT NULL,
  lease_owner      TEXT,
  lease_until      TEXT,
  -- Redacted summary of the most recent failure; never raw payloads or secrets.
  last_error       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(status, run_after, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_workspace_kind ON jobs(workspace_id, kind, created_at);

-- Append-only provenance: one row per delivery attempt. `produced_json` lists
-- the `(type, id)` record references the attempt created or touched, so any
-- ledger transaction, document, candidate, or review item can be traced back
-- to the job run that produced it.
CREATE TABLE IF NOT EXISTS job_runs (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id),
  job_id         TEXT NOT NULL,
  attempt        INTEGER NOT NULL,
  worker_id      TEXT NOT NULL,
  -- running | succeeded | failed
  status         TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  error          TEXT,
  result_json    TEXT,
  produced_json  TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, job_id, attempt),
  FOREIGN KEY (workspace_id, job_id) REFERENCES jobs(workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_job_runs_job ON job_runs(workspace_id, job_id, attempt);
