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
