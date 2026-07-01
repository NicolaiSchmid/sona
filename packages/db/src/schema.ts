/**
 * Typed row interfaces for the core schema (`migrations/0001_core.sql`).
 *
 * These mirror the on-disk columns (snake_case, TEXT ids/timestamps, decimal
 * strings for money, INTEGER 0/1 booleans). Workflow/domain columns are typed
 * with the literal unions from `@sona/core` so the persisted vocabulary stays
 * in sync with the domain model. Mapping to camelCase domain types happens in
 * the repository layer, added in a later phase.
 */
import type {
  AccountKind,
  EvidenceLinkKind,
  RawSourceRecordType,
  ReviewState,
  SourceKind,
  SourceStatus,
} from "@sona/core";
import type {
  DocumentSourceKind,
  MatchDecisionKind,
  MatchOutcome,
  RetentionState,
} from "@sona/receipts";

export interface UserRow {
  id: string;
  email: string;
  created_at: string;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  created_at: string;
}

export interface WorkspaceMemberRow {
  workspace_id: string;
  user_id: string;
  role: string;
  created_at: string;
}

export interface SourceRow {
  id: string;
  workspace_id: string;
  kind: SourceKind;
  display_name: string;
  status: SourceStatus;
  created_at: string;
}

export interface SourceCredentialRow {
  id: string;
  workspace_id: string;
  source_id: string;
  secret_ref: string;
  created_at: string;
}

export interface SourceSyncRunRow {
  id: string;
  workspace_id: string;
  source_id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  error_json: string | null;
}

export interface RawSourceRecordRow {
  id: string;
  workspace_id: string;
  source_id: string;
  external_id: string | null;
  record_type: RawSourceRecordType;
  payload_json: string;
  payload_hash: string;
  observed_at: string;
  supersedes_record_id: string | null;
  created_at: string;
}

export interface LedgerAccountRow {
  id: string;
  workspace_id: string;
  path: string;
  kind: AccountKind;
  commodity: string | null;
  receipt_required: 0 | 1;
  created_at: string;
}

export interface LedgerTransactionRow {
  id: string;
  workspace_id: string;
  booked_on: string;
  description: string;
  review_state: ReviewState;
  created_at: string;
}

export interface LedgerPostingRow {
  id: string;
  workspace_id: string;
  transaction_id: string;
  account_id: string;
  amount: string;
  commodity: string;
  memo: string | null;
}

export interface EvidenceLinkRow {
  id: string;
  workspace_id: string;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  kind: EvidenceLinkKind;
  notes: string | null;
  created_at: string;
}

export interface ReviewEventRow {
  id: string;
  workspace_id: string;
  target_type: string;
  target_id: string;
  from_state: ReviewState;
  to_state: ReviewState;
  actor: string;
  notes: string | null;
  created_at: string;
}

export interface AuditEventRow {
  id: string;
  workspace_id: string;
  action: string;
  actor: string;
  target_type: string | null;
  target_id: string | null;
  metadata_json: string | null;
  created_at: string;
}

/** Names of every table created by the core migration, in dependency order. */
export const CORE_TABLES = [
  "users",
  "workspaces",
  "workspace_members",
  "sources",
  "source_credentials",
  "source_sync_runs",
  "raw_source_records",
  "ledger_accounts",
  "ledger_transactions",
  "ledger_postings",
  "evidence_links",
  "review_events",
  "audit_events",
] as const;

export type CoreTableName = (typeof CORE_TABLES)[number];

// --- Receipts schema (migrations/0002_receipts.sql) -------------------------

export interface DocumentRow {
  id: string;
  workspace_id: string;
  content_hash: string;
  mime_type: string;
  original_filename: string;
  storage_uri: string;
  source_kind: DocumentSourceKind;
  source_metadata_json: string | null;
  retention_state: RetentionState;
  created_at: string;
}

export interface DocumentExtractionRow {
  id: string;
  workspace_id: string;
  document_id: string;
  vendor_name: string | null;
  document_date: string | null;
  due_date: string | null;
  total_amount: string | null;
  tax_amount: string | null;
  currency: string | null;
  invoice_number: string | null;
  payment_reference: string | null;
  extracted_text: string | null;
  confidence: string;
  extractor_version: string;
  created_at: string;
}

export interface MatchCandidateRow {
  id: string;
  workspace_id: string;
  document_id: string;
  extraction_id: string | null;
  transaction_account_ref: string;
  transaction_ref: string;
  scorer_version: string;
  score: string;
  reasons_json: string;
  blockers_json: string;
  warnings_json: string;
  outcome: MatchOutcome;
  created_at: string;
}

export interface MatchDecisionRow {
  id: string;
  workspace_id: string;
  candidate_id: string;
  decision: MatchDecisionKind;
  actor: string;
  notes: string | null;
  created_at: string;
}

/** Names of every table created by the receipts migration. */
export const RECEIPT_TABLES = [
  "documents",
  "document_extractions",
  "match_candidates",
  "match_decisions",
] as const;

export type ReceiptTableName = (typeof RECEIPT_TABLES)[number];
