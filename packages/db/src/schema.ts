/**
 * Typed row interfaces for the core schema (`migrations/0001_core.sql`).
 *
 * These mirror the on-disk columns (snake_case, TEXT ids/timestamps, decimal
 * strings for money, INTEGER 0/1 booleans). Workflow/domain columns are typed
 * with the literal unions from `@sona/core` so the persisted vocabulary stays
 * in sync with the domain model. Mapping to camelCase domain types happens in
 * the repository layer (`./repositories/*`).
 */
import type {
  AccountKind,
  AssetComponentRole,
  AssetEventKind,
  AssetKind,
  BrokerAccountKind,
  EvidenceLinkKind,
  JsonValue,
  PortfolioEvent,
  PortfolioEventType,
  RawSourceRecordType,
  ReviewState,
  SourceKind,
  SourceStatus,
  ValuationSource,
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

// --- Repository extension schema (migrations/0003_repositories.sql) ---------

export interface BankAccountRow {
  id: string;
  workspace_id: string;
  source_id: string;
  external_id: string;
  name: string | null;
  iban: string | null;
  currency: string | null;
  product: string | null;
  raw_json: string;
  raw_record_id: string;
  updated_at: string;
}

export interface BankBalanceRow {
  id: string;
  workspace_id: string;
  source_id: string;
  account_external_id: string;
  balance_type: string;
  amount: string;
  currency: string;
  reference_date: string;
  raw_json: string;
  raw_record_id: string;
  updated_at: string;
}

export interface BankTransactionRow {
  id: string;
  workspace_id: string;
  source_id: string;
  account_external_id: string;
  external_id: string;
  booked_on: string | null;
  value_date: string | null;
  amount: string;
  currency: string;
  status: string | null;
  counterparty_name: string | null;
  remittance_info: string | null;
  raw_json: string;
  raw_record_id: string;
  updated_at: string;
}

export interface ReviewItemRow {
  id: string;
  workspace_id: string;
  target_type: string;
  target_id: string;
  state: ReviewState;
  reason_json: string;
  created_at: string;
  updated_at: string;
}

export interface PortalTaskRunRow {
  run_id: string;
  workspace_id: string;
  task_id: string;
  task_version: number;
  portal_domain: string;
  browser_provider: string;
  fetched_at: string;
}

export const REPOSITORY_TABLES = [
  "bank_accounts",
  "bank_balances",
  "bank_transactions",
  "review_items",
  "portal_task_runs",
] as const;

export type RepositoryTableName = (typeof REPOSITORY_TABLES)[number];

export interface ReviewItem {
  id: string;
  workspaceId: string;
  targetType: string;
  targetId: string;
  state: ReviewState;
  reason: JsonValue;
  createdAt: string;
  updatedAt: string;
}

// --- Ledger repository schema (migrations/0004_ledger_repositories.sql) -----

export interface LedgerTransactionIdempotencyKeyRow {
  workspace_id: string;
  idempotency_key: string;
  transaction_id: string;
}

export interface LedgerTransactionSupersessionRow {
  workspace_id: string;
  transaction_id: string;
  supersedes_transaction_id: string;
  superseded_at: string;
}

export const LEDGER_REPOSITORY_TABLES = [
  "ledger_transaction_idempotency_keys",
  "ledger_transaction_supersessions",
] as const;

export type LedgerRepositoryTableName = (typeof LEDGER_REPOSITORY_TABLES)[number];

// --- Assets schema (migrations/0006_assets.sql) -----------------------------

export interface AssetRow {
  id: string;
  workspace_id: string;
  kind: AssetKind;
  name: string;
  commodity: string;
  acquired_on: string;
  acquisition_side_costs_json: string;
  evidence_document_ids_json: string;
  created_at: string;
}

export interface AssetComponentRow {
  id: string;
  workspace_id: string;
  asset_id: string;
  position: number;
  role: AssetComponentRole;
  label: string;
  cost: string;
  depreciable: 0 | 1;
}

export interface AssetEventRow {
  id: string;
  workspace_id: string;
  asset_id: string;
  kind: AssetEventKind;
  component_id: string | null;
  retracts_event_id: string | null;
  occurred_on: string;
  description: string;
  amount: string | null;
  commodity: string | null;
  evidence_document_ids_json: string;
  created_at: string;
}

export interface AssetDepreciationScheduleRow {
  id: string;
  workspace_id: string;
  asset_id: string;
  version: number;
  method_json: string;
  pro_rata_temporis: 0 | 1;
  residual_value: string | null;
  residual_commodity: string | null;
  rounding_scale: number | null;
  expense_account: string;
  accumulated_depreciation_account: string;
  created_at: string;
}

export interface AssetDepreciationEntryRow {
  id: string;
  workspace_id: string;
  asset_id: string;
  config_id: string;
  year: number;
  transaction_id: string;
  amount: string;
  commodity: string;
  created_at: string;
}

export const ASSET_TABLES = [
  "assets",
  "asset_components",
  "asset_events",
  "asset_depreciation_schedules",
  "asset_depreciation_entries",
] as const;

export type AssetTableName = (typeof ASSET_TABLES)[number];
// --- Portfolio schema (migrations/0007_portfolio.sql) -----------------------

export interface BrokerAccountRow {
  id: string;
  workspace_id: string;
  source_id: string;
  external_id: string;
  name: string;
  kind: BrokerAccountKind;
  currency: string | null;
  updated_at: string;
}

export interface SecurityRow {
  id: string;
  workspace_id: string;
  security_key: string;
  isin: string | null;
  wkn: string | null;
  ticker: string | null;
  name: string | null;
  updated_at: string;
}

export interface PortfolioEventRow {
  id: string;
  workspace_id: string;
  source_id: string;
  external_id: string;
  broker_account_external_id: string;
  kind: PortfolioEvent["kind"];
  event_type: PortfolioEventType;
  event_date: string;
  amount: string;
  currency: string;
  isin: string | null;
  wkn: string | null;
  ticker: string | null;
  security_name: string | null;
  shares: string | null;
  gross_amount: string | null;
  gross_currency: string | null;
  exchange_rate: string | null;
  fees: string | null;
  taxes: string | null;
  note: string | null;
  raw_json: string;
  raw_record_id: string;
  created_at: string;
}

export interface PortfolioValuationRow {
  id: string;
  workspace_id: string;
  source_id: string;
  /** '' when the snapshot is not account-specific. */
  broker_account_ref: string;
  /** '' when the snapshot is not security-specific. */
  security_key: string;
  isin: string | null;
  wkn: string | null;
  ticker: string | null;
  security_name: string | null;
  as_of: string;
  shares: string | null;
  market_value: string;
  currency: string;
  valuation_source: ValuationSource;
  raw_record_id: string | null;
  created_at: string;
}

export const PORTFOLIO_TABLES = [
  "broker_accounts",
  "securities",
  "portfolio_events",
  "portfolio_valuations",
] as const;

export type PortfolioTableName = (typeof PORTFOLIO_TABLES)[number];

// --- Email ingestion schema (migrations/0005_email_sources.sql) --------------

export interface EmailSyncCursorRow {
  run_id: string;
  workspace_id: string;
  source_id: string;
  folder: string;
  uid_validity: string;
  last_uid: number;
  policy_hash: string;
  recorded_at: string;
}

/** Names of every table created by the email ingestion migration. */
export const EMAIL_TABLES = ["email_sync_cursors"] as const;

export type EmailTableName = (typeof EMAIL_TABLES)[number];
