/**
 * The evidence graph links any domain record to any other with a typed
 * relationship. It is the core auditability moat: every derived number can be
 * traced back through the records that justify it.
 */
import { z } from "zod";

/** Allowed evidence relationship kinds. */
export const EVIDENCE_LINK_KINDS = [
  /** A raw/normalized record was imported into a ledger transaction. */
  "imported_as",
  /** A document substantiates a ledger transaction/posting. */
  "substantiates",
  /** A classification rule produced a posting's account. */
  "classified_by",
  /** A review event approved/adjusted a record. */
  "reviewed_by",
  /** A record was generated from another (e.g. depreciation from a schedule). */
  "generated_from",
  /** A ledger posting was emitted as a tax export line. */
  "exported_as",
] as const;

export type EvidenceLinkKind = (typeof EVIDENCE_LINK_KINDS)[number];

export function isEvidenceLinkKind(value: string): value is EvidenceLinkKind {
  return (EVIDENCE_LINK_KINDS as readonly string[]).includes(value);
}

export const evidenceLinkSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  /** Type of the source record, e.g. "bank_transaction". */
  fromType: z.string().min(1),
  fromId: z.string().min(1),
  /** Type of the target record, e.g. "ledger_transaction". */
  toType: z.string().min(1),
  toId: z.string().min(1),
  kind: z.enum(EVIDENCE_LINK_KINDS),
  notes: z.string().optional(),
  createdAt: z.string().min(1),
});

export type EvidenceLink = z.infer<typeof evidenceLinkSchema>;
