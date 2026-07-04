/**
 * @sona/db
 *
 * Database schema, migrations, and (later) typed repositories. Hosted cloud
 * targets PostgreSQL; local/self-hosted may use SQLite. Migrations are written
 * in the portable SQL subset shared by both.
 */

/** Package version marker, used to verify wiring and test discovery. */
export const sonaDbVersion = "0.0.0" as const;

export { CORE_MIGRATIONS, type Migration } from "./migrations/index";
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
export { SqliteMatchCandidateRepository } from "./repositories/matches.js";
export { SqlitePortalTaskRunRepository } from "./repositories/portal-task-runs.js";
export { SqliteRawRecordRepository } from "./repositories/raw-records.js";
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
  NormalizedAccount,
  NormalizedBalance,
  NormalizedTransaction,
  RawLink,
  SyncRunStore,
  SyncStatus,
  SyncSummary,
  TaskRunProvenance,
} from "./repositories/types.js";
export * from "./runner";
export * from "./schema";
