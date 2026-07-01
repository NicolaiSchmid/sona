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
  type GenerateOptions,
  type GenerateResult,
  generateExportLines,
  sectionForAccount,
} from "./export/generate.js";
export {
  generateMissingEvidenceReport,
  type MissingEvidenceRow,
} from "./export/missing-evidence.js";
export {
  type ExportFile,
  type GeneratePackageInput,
  generateExportPackage,
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
