-- 0002_receipts: internally-stored documents, extraction results, and
-- receipt<->transaction match candidates/decisions.
--
-- Same portability rules as 0001_core: TEXT ids/timestamps, decimal strings for
-- amounts and confidences, JSON payloads as TEXT, workspace-scoped composite
-- foreign keys against the parents' UNIQUE (workspace_id, id).

CREATE TABLE IF NOT EXISTS documents (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id),
  content_hash          TEXT NOT NULL,
  mime_type             TEXT NOT NULL,
  original_filename     TEXT NOT NULL,
  storage_uri           TEXT NOT NULL,
  source_kind           TEXT NOT NULL,
  source_metadata_json  TEXT,
  retention_state       TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  UNIQUE (workspace_id, id)
);

-- Content-hash dedup for mass uploads.
CREATE UNIQUE INDEX IF NOT EXISTS uq_documents_content ON documents(workspace_id, content_hash);

CREATE TABLE IF NOT EXISTS document_extractions (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id),
  document_id        TEXT NOT NULL,
  vendor_name        TEXT,
  document_date      TEXT,
  due_date           TEXT,
  total_amount       TEXT,
  tax_amount         TEXT,
  currency           TEXT,
  invoice_number     TEXT,
  payment_reference  TEXT,
  extracted_text     TEXT,
  confidence         TEXT NOT NULL,
  extractor_version  TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, document_id) REFERENCES documents(workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_extractions_document ON document_extractions(document_id);

CREATE TABLE IF NOT EXISTS match_candidates (
  id                        TEXT PRIMARY KEY,
  workspace_id              TEXT NOT NULL REFERENCES workspaces(id),
  document_id               TEXT NOT NULL,
  -- The specific extraction the score was computed from (nullable; e.g. a
  -- deterministic Stage-1 match), so re-running OCR doesn't lose provenance.
  extraction_id             TEXT,
  -- Reference to a normalized bank transaction. Provider external ids are only
  -- stable within an account, so the account is stored alongside. Not FK'd
  -- because bank transactions are not yet a first-class table.
  transaction_account_ref   TEXT NOT NULL,
  transaction_ref           TEXT NOT NULL,
  -- Version of the scorer that produced this candidate (audit/reproducibility).
  scorer_version            TEXT NOT NULL,
  score                     TEXT NOT NULL,
  reasons_json              TEXT NOT NULL,
  blockers_json             TEXT NOT NULL,
  warnings_json             TEXT NOT NULL,
  outcome                   TEXT NOT NULL,
  created_at                TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, document_id) REFERENCES documents(workspace_id, id),
  FOREIGN KEY (workspace_id, extraction_id) REFERENCES document_extractions(workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_candidates_document ON match_candidates(document_id);
CREATE INDEX IF NOT EXISTS idx_candidates_txn
  ON match_candidates(workspace_id, transaction_account_ref, transaction_ref);

CREATE TABLE IF NOT EXISTS match_decisions (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  candidate_id  TEXT NOT NULL,
  decision      TEXT NOT NULL,
  actor         TEXT NOT NULL,
  notes         TEXT,
  created_at    TEXT NOT NULL,
  FOREIGN KEY (workspace_id, candidate_id) REFERENCES match_candidates(workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_decisions_candidate ON match_decisions(candidate_id);
