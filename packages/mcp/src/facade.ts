/**
 * The typed `sona.*` facade.
 *
 * This is the only surface agent code may call. Functions are stubs that return
 * deterministic placeholder data — they never touch a real database, secret
 * store, network, or filesystem. Later phases wire these to real repositories
 * behind risk-based approval gates. The string backend paths stay private; the
 * facade is the public contract.
 */

export interface SonaFacade {
  sources: {
    list(): Promise<Array<{ id: string; kind: string; displayName: string; status: string }>>;
    sync(input: { sourceId: string }): Promise<{ sourceId: string; status: "queued" }>;
  };
  receipts: {
    list(): Promise<Array<{ id: string; vendor: string; total: string; currency: string }>>;
    ingestUpload(input: { fileId: string }): Promise<{ documentId: string; status: "queued" }>;
  };
  reconciliation: {
    suggestReceiptMatches(input: {
      taxYear: number;
    }): Promise<Array<{ candidateId: string; score: number; reasons: string[] }>>;
    autoApply(input: { minScore: number }): Promise<{ applied: number; skipped: number }>;
    listReviewItems(input: {
      kind: string;
    }): Promise<Array<{ id: string; kind: string; reason: string }>>;
    approveMatch(input: { candidateId: string }): Promise<{ candidateId: string; approved: true }>;
  };
  ledger: {
    listAccounts(): Promise<Array<{ path: string; kind: string }>>;
    createRule(input: {
      pattern: string;
      account: string;
    }): Promise<{ ruleId: string; status: "draft" }>;
  };
  tax: {
    listTemplates(input: {
      jurisdiction: string;
    }): Promise<Array<{ id: string; jurisdiction: string; audience: string }>>;
    previewExport(input: { year: number }): Promise<{ year: number; lineCount: number }>;
    listMissingEvidence(input: {
      year: number;
    }): Promise<Array<{ postingId: string; account: string }>>;
    generatePackage(input: {
      year: number;
      includeDocuments?: boolean;
    }): Promise<{ year: number; manifest: string[] }>;
  };
  assets: {
    list(): Promise<Array<{ id: string; kind: string; description: string }>>;
  };
  agents: {
    listPortalTasks(): Promise<Array<{ id: string; name: string; risk: string }>>;
    runPortalTask(input: { connectionId: string }): Promise<{ runId: string; status: "queued" }>;
  };
}

/**
 * Creates the deterministic stub facade used by the `execute` tool.
 *
 * NOTE: when these stubs are wired to real write-draft operations, each method
 * MUST validate its input against the corresponding catalog `inputSchema`
 * (`packages/mcp/src/catalog.ts`) at that write boundary — agent snippets are
 * plain JavaScript and do not go through the catalog's zod schemas, so malformed
 * ids/accounts would otherwise reach real jobs.
 */
export function createFacade(): SonaFacade {
  return {
    sources: {
      async list() {
        return [
          { id: "src_demo_dkb", kind: "enable_banking", displayName: "DKB", status: "active" },
        ];
      },
      async sync({ sourceId }) {
        return { sourceId, status: "queued" };
      },
    },
    receipts: {
      async list() {
        return [{ id: "doc_demo", vendor: "Example GmbH", total: "84.23", currency: "EUR" }];
      },
      async ingestUpload({ fileId }) {
        return { documentId: `doc_${fileId}`, status: "queued" };
      },
    },
    reconciliation: {
      async suggestReceiptMatches({ taxYear }) {
        return [
          {
            candidateId: `cand_${taxYear}_1`,
            score: 0.98,
            reasons: ["exact amount", "date within 2 days"],
          },
        ];
      },
      async autoApply(_input) {
        return { applied: 0, skipped: 0 };
      },
      async listReviewItems({ kind }) {
        return [{ id: "rev_1", kind, reason: "multiple plausible receipts" }];
      },
      async approveMatch({ candidateId }) {
        return { candidateId, approved: true };
      },
    },
    ledger: {
      async listAccounts() {
        return [
          { path: "Assets:Bank", kind: "asset" },
          { path: "Expenses:TaxAdvice", kind: "expense" },
        ];
      },
      async createRule(_input) {
        return { ruleId: "rule_demo", status: "draft" };
      },
    },
    tax: {
      async listTemplates({ jurisdiction }) {
        return [{ id: "private-de", jurisdiction, audience: "private_individual" }];
      },
      async previewExport({ year }) {
        return { year, lineCount: 0 };
      },
      async listMissingEvidence(_input) {
        return [{ postingId: "post_demo", account: "Expenses:TaxAdvice" }];
      },
      async generatePackage({ year }) {
        return {
          year,
          manifest: ["summary.md", "tax-categories.csv", "missing-evidence.csv"],
        };
      },
    },
    assets: {
      async list() {
        return [{ id: "asset_demo", kind: "real_estate", description: "Example rental unit" }];
      },
    },
    agents: {
      async listPortalTasks() {
        return [
          {
            id: "amazon-de-invoices",
            name: "Amazon Germany invoice fetcher",
            risk: "read_only_document_fetch",
          },
        ];
      },
      async runPortalTask({ connectionId }) {
        return { runId: `run_${connectionId}`, status: "queued" };
      },
    },
  };
}
