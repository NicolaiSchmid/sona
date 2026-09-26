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
  matchDecision: "match_decision",
  reviewEvent: "review_event",
  reviewItem: "review_item",
  taxExportLine: "tax_export_line",
} as const;

export type RecordType = (typeof RECORD_TYPES)[keyof typeof RECORD_TYPES];

/** A polymorphic reference to any domain record. */
export interface RecordRef {
  type: string;
  id: string;
}
