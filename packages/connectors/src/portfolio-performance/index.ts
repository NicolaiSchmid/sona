/**
 * Portfolio Performance connector: CSV export parsing, normalization into
 * portfolio events and valuation snapshots, and idempotent import into the raw
 * vault. Read-only by construction — it never talks to a broker.
 */

export {
  type CsvDelimiter,
  type CsvRecord,
  type CsvTable,
  EmptyCsvError,
  parseCsv,
} from "./csv.js";
export {
  type PortfolioBrokerAccountInput,
  type PortfolioImportRunStore,
  type PortfolioImportStatus,
  type PortfolioImportSummary,
  type PortfolioRawRecordStore,
  type PortfolioSaveResult,
  type PortfolioSecurityInput,
  type PortfolioStore,
  type RunPortfolioPerformanceHoldingsImportInput,
  type RunPortfolioPerformanceImportInput,
  runPortfolioPerformanceHoldingsImport,
  runPortfolioPerformanceImport,
} from "./import.js";
export {
  DEFAULT_BROKER_ACCOUNT_EXTERNAL_ID,
  type NormalizeHoldingInput,
  type NormalizeRowOptions,
  normalizePortfolioPerformanceHolding,
  normalizePortfolioPerformanceRow,
  normalizePortfolioPerformanceRows,
} from "./normalize.js";
export {
  PpRowParseError,
  parseLocalizedDate,
  parseLocalizedDecimal,
  parsePortfolioPerformanceCsv,
  parsePortfolioPerformanceHoldingsCsv,
} from "./parse.js";
export type * from "./types.js";
export { PP_COLUMNS, PP_HOLDINGS_COLUMNS } from "./types.js";
