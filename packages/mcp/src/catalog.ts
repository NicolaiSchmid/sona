/**
 * The reviewed function catalog backing the `search` tool.
 *
 * Each entry documents one `sona.*` operation: its path, a description, the zod
 * input schema, and a risk label. Risk labels are advisory metadata today; once
 * auth and approval gates land, higher-risk operations require explicit policy.
 */
import { z } from "zod";

export const RISK_LABELS = [
  /** Reads internal Sona data only. */
  "read_only",
  /** Writes draft/suggested records that still need review. */
  "write_draft",
  /** Produces output a human must approve before it counts. */
  "review_required",
  /** Reads from an external provider (e.g. a bank aggregator). */
  "external_read",
  /** Drives an external browser/portal session. */
  "external_browser",
  /** Must not run without an explicit configured policy. */
  "forbidden_without_policy",
] as const;

export type RiskLabel = (typeof RISK_LABELS)[number];

export interface CatalogEntry {
  /** Public facade path, e.g. "sona.receipts.ingestUpload". */
  path: string;
  /** Facade family, e.g. "receipts". */
  family: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  risk: RiskLabel;
}

export const CATALOG = [
  {
    path: "sona.sources.list",
    family: "sources",
    description: "List configured sources (banks, email, portals) for the workspace.",
    inputSchema: z.object({}),
    risk: "read_only",
  },
  {
    path: "sona.sources.sync",
    family: "sources",
    description: "Trigger a read-only sync of a source's accounts, balances, and transactions.",
    inputSchema: z.object({ sourceId: z.string() }),
    risk: "external_read",
  },
  {
    path: "sona.receipts.list",
    family: "receipts",
    description: "List stored receipt/invoice documents with extracted summary fields.",
    inputSchema: z.object({}),
    risk: "read_only",
  },
  {
    path: "sona.receipts.ingestUpload",
    family: "receipts",
    description: "Register an uploaded receipt or invoice for extraction and matching.",
    inputSchema: z.object({ fileId: z.string() }),
    risk: "write_draft",
  },
  {
    path: "sona.reconciliation.suggestReceiptMatches",
    family: "reconciliation",
    description: "Suggest receipt ↔ transaction matches for a tax year with explainable scores.",
    inputSchema: z.object({ taxYear: z.number().int() }),
    risk: "write_draft",
  },
  {
    path: "sona.reconciliation.autoApply",
    family: "reconciliation",
    description: "Auto-apply high-confidence matches under a conservative configured policy.",
    inputSchema: z.object({ minScore: z.number().min(0).max(1) }),
    risk: "review_required",
  },
  {
    path: "sona.reconciliation.listReviewItems",
    family: "reconciliation",
    description: "List items queued for human review (uncertain matches, missing receipts).",
    inputSchema: z.object({ kind: z.string() }),
    risk: "read_only",
  },
  {
    path: "sona.reconciliation.approveMatch",
    family: "reconciliation",
    description: "Approve a suggested match candidate as user-reviewed.",
    inputSchema: z.object({ candidateId: z.string() }),
    risk: "review_required",
  },
  {
    path: "sona.ledger.listAccounts",
    family: "ledger",
    description: "List the workspace's ledger accounts.",
    inputSchema: z.object({}),
    risk: "read_only",
  },
  {
    path: "sona.ledger.createRule",
    family: "ledger",
    description: "Create a draft classification rule mapping a pattern to an account.",
    inputSchema: z.object({ pattern: z.string(), account: z.string() }),
    risk: "write_draft",
  },
  {
    path: "sona.tax.listTemplates",
    family: "tax",
    description: "List configurable tax export templates for a jurisdiction.",
    inputSchema: z.object({ jurisdiction: z.string() }),
    risk: "read_only",
  },
  {
    path: "sona.tax.previewExport",
    family: "tax",
    description: "Preview a tax-year export package without writing files.",
    inputSchema: z.object({ year: z.number().int() }),
    risk: "read_only",
  },
  {
    path: "sona.tax.listMissingEvidence",
    family: "tax",
    description: "List tax-relevant postings that are missing substantiating evidence.",
    inputSchema: z.object({ year: z.number().int() }),
    risk: "read_only",
  },
  {
    path: "sona.tax.generatePackage",
    family: "tax",
    description: "Generate a reviewable tax-ready export package. Never submits to ELSTER.",
    inputSchema: z.object({ year: z.number().int(), includeDocuments: z.boolean().optional() }),
    risk: "review_required",
  },
  {
    path: "sona.assets.list",
    family: "assets",
    description: "List depreciable assets and real estate tracked in the workspace.",
    inputSchema: z.object({}),
    risk: "read_only",
  },
  {
    path: "sona.agents.listPortalTasks",
    family: "agents",
    description: "List available read-only browser portal fetch tasks.",
    inputSchema: z.object({}),
    risk: "read_only",
  },
  {
    path: "sona.agents.runPortalTask",
    family: "agents",
    description: "Run a versioned, read-only portal document-fetch task.",
    inputSchema: z.object({ connectionId: z.string() }),
    risk: "external_browser",
  },
] as const satisfies readonly CatalogEntry[];

/** Distinct facade families present in the catalog, in first-seen order. */
export const FAMILIES: readonly string[] = [...new Set(CATALOG.map((entry) => entry.family))];
