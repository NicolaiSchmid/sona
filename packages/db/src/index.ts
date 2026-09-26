/**
 * @sona/db
 *
 * Database schema, migrations, and typed SQLite repositories. Hosted cloud
 * targets PostgreSQL; local/self-hosted may use SQLite. Migrations are written
 * in the portable SQL subset shared by both.
 */

/** Package version marker, used to verify wiring and test discovery. */
export const sonaDbVersion = "0.0.0" as const;

export { CORE_MIGRATIONS, type Migration } from "./migrations/index";
export {
  type ShareLinkActor,
  type ShareLinkDownloadRequest,
  type ShareLinkDownloadResult,
  SqliteAccountantShareLinkRepository,
} from "./repositories/accountant-share-links.js";
export { SqliteAssetRepository } from "./repositories/assets.js";
export {
  type AuditEventCursor,
  type AuditEventPage,
  type ListAuditEventsOptions,
  SqliteAuditEventRepository,
} from "./repositories/audit-events.js";
export {
  createWorkspaceBankRecordStore,
  type PersistedBankAccount,
  type PersistedBankBalance,
  type PersistedBankTransaction,
  SqliteBankRecordRepository,
} from "./repositories/bank-records.js";
export {
  SqliteDocumentExtractionRepository,
  SqliteDocumentRepository,
  type StoredDocumentExtraction,
} from "./repositories/documents.js";
export {
  createWorkspaceEmailSyncRunStore,
  type EmailSyncRunError,
  type PersistedEmailSyncRun,
  type PersistedEmailSyncRunStatus,
  SqliteEmailSyncRunRepository,
} from "./repositories/email-sync-runs.js";
export {
  type LinkEvidenceResult,
  SqliteEvidenceLinkRepository,
} from "./repositories/evidence-links.js";
export { withTransaction, withTransactionAsync } from "./repositories/helpers.js";
export {
  type CreateLedgerTransactionInput,
  type CreateLedgerTransactionResult,
  type EnsureDefaultAccountsInput,
  LEDGER_CREATION_REVIEW_STATES,
  LEDGER_ERROR_CODES,
  type LedgerAccountInput,
  type LedgerCreationReviewState,
  LedgerError,
  type LedgerErrorCode,
  type LedgerPostingInput,
  type LedgerReviewTransitionInput,
  type LedgerTransactionFilter,
  type PersistedLedgerTransaction,
  SqliteLedgerRepository,
  type SupersedeLedgerTransactionInput,
  type SupersedeLedgerTransactionResult,
  UnbalancedLedgerTransactionError,
} from "./repositories/ledger.js";
export { SqliteMatchCandidateRepository } from "./repositories/matches.js";
export {
  createWorkspacePaperlessSyncRunStore,
  type PaperlessSyncRunError,
  type PersistedPaperlessSyncRun,
  type PersistedPaperlessSyncRunStatus,
  SqlitePaperlessSyncRunRepository,
} from "./repositories/paperless-sync-runs.js";
export { SqlitePortalTaskRunRepository } from "./repositories/portal-task-runs.js";
export {
  createWorkspacePortfolioStore,
  type PersistedBrokerAccount,
  type PersistedPortfolioEvent,
  type PersistedSecurity,
  SqlitePortfolioRepository,
} from "./repositories/portfolio.js";
export { SqliteRawRecordRepository } from "./repositories/raw-records.js";
export { RECORD_TYPES, type RecordRef, type RecordType } from "./repositories/records.js";
export { reviewEventId, SqliteReviewEventRepository } from "./repositories/review-events.js";
export {
  type ReviewTransitionInput,
  SqliteReviewQueueRepository,
} from "./repositories/review-queue.js";
export {
  createWorkspaceSyncRunStore,
  type PersistedSyncRun,
  SqliteSyncRunRepository,
  type SyncRunError,
} from "./repositories/sync-runs.js";
export type {
  BankRecordStore,
  EmailCursorResetReason,
  EmailSyncCursor,
  EmailSyncError,
  EmailSyncRunStore,
  EmailSyncStatus,
  EmailSyncSummary,
  NormalizedAccount,
  NormalizedBalance,
  NormalizedTransaction,
  PaperlessCursorResetReason,
  PaperlessSyncCursor,
  PaperlessSyncError,
  PaperlessSyncRunStore,
  PaperlessSyncStatus,
  PaperlessSyncSummary,
  PortfolioBrokerAccountInput,
  PortfolioSaveResult,
  PortfolioSecurityInput,
  PortfolioStore,
  RawLink,
  SyncRunStore,
  SyncStatus,
  SyncSummary,
  TaskRunProvenance,
} from "./repositories/types.js";
export * from "./runner";
export * from "./schema";
