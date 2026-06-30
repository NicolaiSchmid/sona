/**
 * Enable Banking AIS connector: JWT auth, a small HTTP client, normalizers, and
 * sync orchestration. Read-only account information services only — no payment
 * initiation.
 */

export {
  createEnableBankingClient,
  EnableBankingApiError,
  type EnableBankingClient,
  type EnableBankingConfig,
  type FetchLike,
  type HttpRequestInit,
  type HttpResponse,
} from "./client.js";
export {
  createEnableBankingJwt,
  decodeJwt,
  type JwtConfig,
  type JwtHeader,
  type JwtPayload,
  MAX_JWT_TTL_SECONDS,
} from "./jwt.js";
export {
  accountUidsFromSession,
  normalizeAccount,
  normalizeBalance,
  normalizeTransaction,
} from "./normalize.js";
export {
  type BankRecordStore,
  type RawRecordStore,
  type RunEnableBankingSyncInput,
  runEnableBankingSync,
  type SyncEnv,
  type SyncRunStore,
  type SyncStatus,
  type SyncSummary,
} from "./sync.js";
export type * from "./types.js";
