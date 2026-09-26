/**
 * @sona/tax-de
 *
 * Configurable German private-tax templates and tax-ready export mappings.
 * Produces draft/review artifacts only — never tax advice or ELSTER submission.
 */

/** Package version marker, used to verify wiring and test discovery. */
export const sonaTaxDeVersion = "0.0.0" as const;

export { matchesAccountPattern } from "./export/accounts.js";
export {
  type DepreciationExportRow,
  type DepreciationRowStatus,
  type DepreciationScheduleExportInput,
  type DepreciationSectionOptions,
  type DepreciationSectionResult,
  type DepreciationTransactionRef,
  type ExcludedDepreciationYear,
  generateDepreciationSection,
} from "./export/depreciation.js";
export {
  type GenerateOptions,
  type GenerateResult,
  generateExportLines,
  requiredReviewState,
  sectionForAccount,
} from "./export/generate.js";
export {
  generateInvestmentEvidenceRows,
  INVESTMENT_EVIDENCE_KINDS,
  type InvestmentEvidenceFromDraftInput,
  type InvestmentEvidenceInput,
  type InvestmentEvidenceKind,
  type InvestmentEvidenceResult,
  type InvestmentEvidenceRow,
  investmentEvidenceFromDraft,
} from "./export/investment-evidence.js";
export {
  generateMissingEvidenceReport,
  type MissingEvidenceRow,
} from "./export/missing-evidence.js";
export {
  type ExportFile,
  type GeneratePackageInput,
  generateExportPackage,
  OPTIONAL_PACKAGE_FILES,
  PACKAGE_FILES,
  type TaxExportPackage,
} from "./export/package.js";
export type {
  ExportMode,
  TaxExportLine,
  TaxPostingInput,
  TaxSection,
  TaxTemplate,
} from "./export/types.js";
export { PRIVATE_DE_TEMPLATE } from "./templates/private-de.js";
