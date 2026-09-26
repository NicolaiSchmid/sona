/**
 * End-to-end pipeline over real SQLite repositories with fakes for every
 * external system: bank sync → draft postings → upload → extraction →
 * reconciliation → review item / auto match → export. Replaying the whole
 * pipeline must leave the database in the same state.
 */
import { SUSPENSE_ACCOUNTS, sumDecimals } from "@sona/core";
import { FakeExtractionProvider, hashDocumentContent } from "@sona/receipts";
import { describe, expect, it } from "vitest";
import { documentIdForHash } from "./jobs/document-ingest.js";
import { candidateId, matchReviewItemId } from "./jobs/reconciliation.js";
import {
  countRows,
  createTestHarness,
  drain,
  SRC_1,
  stageUpload,
  type TestHarness,
  WS_1,
  WS_2,
} from "./test-support.js";

const HANDWERK_BYTES = new TextEncoder().encode("%PDF-1.4 handwerk invoice 2026-0042");
const BLURRY_BYTES = new TextEncoder().encode("%PDF-1.4 blurry phone photo of a receipt");
const HANDWERK_TX = "bank_transaction:src_1:idhash_synth_1:txn_synth_handwerk";

function snapshot(h: TestHarness): Record<string, number> {
  const tables = [
    "raw_source_records",
    "bank_transactions",
    "ledger_transactions",
    "ledger_postings",
    "evidence_links",
    "documents",
    "document_extractions",
    "match_candidates",
    "match_decisions",
    "review_items",
  ];
  return Object.fromEntries(tables.map((table) => [table, countRows(h.db, table, WS_1)]));
}

async function runPipeline(h: TestHarness, window: string): Promise<void> {
  await h.worker.queue.enqueue(h.context, "source_sync", { sourceId: SRC_1, window });
  await stageUpload(h, h.context, { id: `up_handwerk_${window}`, bytes: HANDWERK_BYTES });
  await stageUpload(h, h.context, { id: `up_blurry_${window}`, bytes: BLURRY_BYTES });
  await h.worker.queue.enqueue(h.context, "document_ingest", { uploadId: `up_handwerk_${window}` });
  await h.worker.queue.enqueue(h.context, "document_ingest", { uploadId: `up_blurry_${window}` });
  await h.worker.queue.enqueue(
    h.context,
    "export_generation",
    { year: 2026 },
    { idempotencyKey: `export:${window}` },
  );
  await drain(h.worker);
}

describe("worker pipeline", () => {
  it("runs sync → drafts → ingest → extraction → reconciliation → export, and replays to identical state", async () => {
    const h = await createTestHarness();
    try {
      // Two receipts: one clean match for the Handwerk outflow, one blurry photo.
      const handwerkId = documentIdForHash(WS_1, hashDocumentContent(HANDWERK_BYTES));
      const blurryId = documentIdForHash(WS_1, hashDocumentContent(BLURRY_BYTES));
      h.provider.current = {
        name: "routing",
        version: "1",
        extract: async (input) => {
          const provider =
            input.metadata.documentId === handwerkId
              ? new FakeExtractionProvider({
                  vendorName: "Example Handwerk GmbH",
                  documentDate: "2026-01-16",
                  totalAmount: "84.23",
                  currency: "EUR",
                  invoiceNumber: "2026-0042",
                })
              : new FakeExtractionProvider({
                  vendorName: "Unknown Shop",
                  documentDate: "2026-01-20",
                  totalAmount: "84.23",
                  currency: "EUR",
                  confidence: 0.45,
                });
          return provider.extract(input);
        },
      };

      await runPipeline(h, "w1");
      const first = snapshot(h);

      // Drafts: two balanced draft transactions in suspense.
      const drafts = await h.worker.repositories.ledger.listTransactions(WS_1);
      expect(drafts).toHaveLength(2);
      for (const draft of drafts) {
        expect(draft.reviewState).toBe("draft");
        expect(sumDecimals(draft.postings.map((p) => p.amount.amount))).toMatch(/^-?0(\.0+)?$/);
        expect(draft.postings.some((p) => p.account === SUSPENSE_ACCOUNTS.unclassified)).toBe(true);
      }

      // Documents and extractions.
      expect(first["documents"]).toBe(2);
      expect(first["document_extractions"]).toBe(2);

      // Reconciliation: the clean receipt scores highest but the blurry one is a
      // plausible competitor for the same transaction, so whichever is
      // reconciled second is held for review and nothing auto-applies twice.
      const handwerkCandidate = await h.worker.repositories.matchCandidates.getById(
        WS_1,
        candidateId(handwerkId, HANDWERK_TX),
      );
      const blurryCandidate = await h.worker.repositories.matchCandidates.getById(
        WS_1,
        candidateId(blurryId, HANDWERK_TX),
      );
      expect(handwerkCandidate?.outcome).toBe("auto_match");
      expect(blurryCandidate?.outcome).toBe("review");
      const links = await h.worker.repositories.evidenceLinks.listForDocument(WS_1, handwerkId);
      expect(links.map((l) => [l.kind, l.toType])).toEqual([
        ["substantiates", "ledger_transaction"],
      ]);
      expect(await h.worker.repositories.evidenceLinks.listForDocument(WS_1, blurryId)).toEqual([]);

      // Review queue: the blurry extraction itself plus its uncertain match.
      const review = await h.worker.repositories.reviewQueue.listByState(WS_1, "suggested");
      expect(review.map((item) => item.id).sort()).toEqual(
        [
          `review:extraction:${blurryId}:swappable@1`,
          matchReviewItemId(candidateId(blurryId, HANDWERK_TX)),
        ].sort(),
      );

      // Export: drafts never reach even a draft export; the bundle exists.
      const exportJobs = await h.worker.queue.list(h.context, { kinds: ["export_generation"] });
      const exportRun = (await h.worker.queue.listRuns(h.context, exportJobs[0]?.id ?? ""))[0];
      expect(exportRun?.status).toBe("succeeded");
      expect(exportRun?.result).toMatchObject({ lineCount: 0, postingCount: 4 });

      // Every job succeeded and every run has an audit event.
      const jobs = await h.worker.queue.list(h.context);
      expect(jobs.map((j) => j.status)).toEqual(jobs.map(() => "succeeded"));
      const audit = await h.worker.repositories.auditEvents.list(WS_1, { limit: 1000 });
      const runAudits = audit.events.filter((e) => e.action.startsWith("job.run."));
      expect(runAudits).toHaveLength(jobs.length);
      expect(runAudits.every((e) => e.action === "job.run.succeeded")).toBe(true);

      // Replay everything in a later window: identical domain state.
      h.clock.advance(60 * 60_000);
      await runPipeline(h, "w2");
      expect(snapshot(h)).toEqual(first);
      expect(h.provider.calls).toHaveLength(2);
      expect(await h.worker.repositories.ledger.listTransactions(WS_1)).toHaveLength(2);

      // The other workspace saw nothing.
      expect(countRows(h.db, "documents", WS_2)).toBe(0);
      expect(countRows(h.db, "ledger_transactions", WS_2)).toBe(0);
      expect(countRows(h.db, "review_items", WS_2)).toBe(0);
    } finally {
      h.close();
    }
  });
});
