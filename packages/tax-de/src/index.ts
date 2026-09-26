/**
 * @sona/tax-de
 *
 * Configurable German private-tax templates and tax-ready export mappings.
 * Produces draft/review artifacts only — never tax advice or ELSTER submission.
 */

/** Package version marker, used to verify wiring and test discovery. */
export const sonaTaxDeVersion = "0.0.0" as const;

export {
  ACCOUNTANT_DOCUMENTS_DIR,
  ACCOUNTANT_MANIFEST_FILE,
  ACCOUNTANT_README_FILE,
  type AccountantManifestEntry,
  type AccountantPackage,
  type AccountantPackageDocument,
  type AccountantPackageFile,
  type AccountantPackageInput,
  type BundledDocument,
  buildAccountantPackage,
  bundledDocumentPath,
  type LoadAccountantDocumentsInput,
  loadAccountantDocuments,
  referencedEvidenceDocumentIds,
} from "./accountant/package.js";
export {
  type AccountantShareLink,
  type CreateShareLinkInput,
  createShareLink,
  DEFAULT_MAX_DOWNLOADS,
  DEFAULT_SHARE_LINK_TTL_MS,
  evaluateShareLinkAccess,
  generateShareToken,
  hashShareToken,
  MAX_SHARE_LINK_TTL_MS,
  SHARE_LINK_AUDIT_ACTIONS,
  SHARE_LINK_DENIAL_REASONS,
  SHARE_TOKEN_BYTES,
  type ShareLinkAccess,
  type ShareLinkAccessRequest,
  type ShareLinkAuditAction,
  type ShareLinkDenialReason,
} from "./accountant/share-link.js";
export { crc32, createZip, type ZipEntry } from "./accountant/zip.js";
export {
  type GenerateElsterDraftInput,
  generateElsterDraft,
  groupForLine,
  mappingCoversYear,
  totalsByCurrency,
} from "./elster-draft/mapping.js";
export {
  ELSTER_DRAFT_BANNER,
  ELSTER_DRAFT_JSON_FILE,
  ELSTER_DRAFT_MARKDOWN_FILE,
  renderElsterDraftJson,
  renderElsterDraftMarkdown,
} from "./elster-draft/render.js";
export type {
  ElsterDraft,
  ElsterDraftGroup,
  ElsterDraftLine,
  ElsterDraftMapping,
  ElsterDraftTotal,
  ElsterExcludedPosting,
  ElsterLineGroup,
  ElsterUnmappedSection,
} from "./elster-draft/types.js";
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
export { ELSTER_DRAFT_MAPPING_PRIVATE_DE } from "./templates/elster-draft-de.js";
export { PRIVATE_DE_TEMPLATE } from "./templates/private-de.js";
