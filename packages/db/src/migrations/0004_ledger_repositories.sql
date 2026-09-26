-- 0004_ledger_repositories: companion tables and indexes for the ledger,
-- evidence link, and audit event repositories.
--
-- Migrations must stay re-runnable, so this adds new `IF NOT EXISTS` objects
-- instead of altering `ledger_transactions` in place.

-- Import idempotency: a workspace-scoped natural key for a ledger transaction
-- so re-running an import does not create a second transaction.
CREATE TABLE IF NOT EXISTS ledger_transaction_idempotency_keys (
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id),
  idempotency_key  TEXT NOT NULL,
  transaction_id   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, idempotency_key),
  UNIQUE (workspace_id, transaction_id),
  FOREIGN KEY (workspace_id, transaction_id) REFERENCES ledger_transactions(workspace_id, id)
);

-- Append-only supersession chain: a correction is a new balanced transaction
-- that supersedes the old one. Amounts on the old transaction are never
-- updated; only its review_state flips to `superseded`. Each transaction can
-- be superseded at most once, so the chain is linear.
CREATE TABLE IF NOT EXISTS ledger_transaction_supersessions (
  workspace_id               TEXT NOT NULL REFERENCES workspaces(id),
  transaction_id             TEXT NOT NULL,
  supersedes_transaction_id  TEXT NOT NULL,
  superseded_at              TEXT NOT NULL,
  PRIMARY KEY (workspace_id, transaction_id),
  UNIQUE (workspace_id, supersedes_transaction_id),
  FOREIGN KEY (workspace_id, transaction_id) REFERENCES ledger_transactions(workspace_id, id),
  FOREIGN KEY (workspace_id, supersedes_transaction_id) REFERENCES ledger_transactions(workspace_id, id)
);

-- Evidence links are deduplicated on their full typed edge. Earlier schemas
-- allowed duplicate edges, so drop all but the earliest row of each edge
-- before the unique index is created. Re-running finds nothing to delete.
DELETE FROM evidence_links
WHERE EXISTS (
  SELECT 1 FROM evidence_links earlier
  WHERE earlier.workspace_id = evidence_links.workspace_id
    AND earlier.from_type = evidence_links.from_type
    AND earlier.from_id = evidence_links.from_id
    AND earlier.to_type = evidence_links.to_type
    AND earlier.to_id = evidence_links.to_id
    AND earlier.kind = evidence_links.kind
    AND (
      earlier.created_at < evidence_links.created_at
      OR (earlier.created_at = evidence_links.created_at AND earlier.id < evidence_links.id)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_evidence_links_edge
  ON evidence_links(workspace_id, from_type, from_id, to_type, to_id, kind);
