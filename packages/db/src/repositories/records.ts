/**
 * Polymorphic record references shared by the evidence graph, review events,
 * and audit events: a `(type, id)` pair naming any domain record.
 */

/** Record type names used on evidence, review, and audit endpoints across Sona. */
export const RECORD_TYPES = {
  ledgerTransaction: "ledger_transaction",
  ledgerPosting: "ledger_posting",
  document: "document",
  rawSourceRecord: "raw_source_record",
  bankTransaction: "bank_transaction",
  documentExtraction: "document_extraction",
  matchCandidate: "match_candidate",
  matchDecision: "match_decision",
  reviewEvent: "review_event",
  reviewItem: "review_item",
  portalTaskRun: "portal_task_run",
  taxExportLine: "tax_export_line",
  asset: "asset",
  /** Named after its table; matches core's `ASSET_RECORD_TYPES.scheduleConfig`. */
  assetDepreciationSchedule: "asset_depreciation_schedule",
  taxExportPackage: "tax_export_package",
  sourceSyncRun: "source_sync_run",
  job: "job",
} as const;

export type RecordType = (typeof RECORD_TYPES)[keyof typeof RECORD_TYPES];

/** A polymorphic reference to any domain record. */
export interface RecordRef {
  type: string;
  id: string;
}
