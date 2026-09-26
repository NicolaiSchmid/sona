import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type ExtractionProvider,
  FakeExtractionProvider,
  hashDocumentContent,
  PdfTextExtractionProvider,
} from "@sona/receipts";
import { describe, expect, it } from "vitest";
import {
  countRows,
  createTestHarness,
  stageUpload,
  type TestHarness,
  WS_1,
} from "../test-support.js";
import { documentIdForHash } from "./document-ingest.js";
import { extractionId, extractionReviewItemId } from "./extraction.js";

const PDF_BYTES = new TextEncoder().encode("%PDF-1.4 synthetic receipt bytes for extraction");

const SCANNED_IMAGE_ONLY_PDF = readFileSync(
  fileURLToPath(
    new URL("../../../../packages/receipts/fixtures/pdfs/scanned-image-only.pdf", import.meta.url),
  ),
);

/** Ingests bytes and returns the document id, leaving the extraction job queued. */
async function ingested(h: TestHarness, bytes: Uint8Array = PDF_BYTES): Promise<string> {
  await stageUpload(h, h.context, { id: "upload_1", bytes });
  await h.worker.queue.enqueue(h.context, "document_ingest", { uploadId: "upload_1" });
  await h.worker.runOnce({ kinds: ["document_ingest"] });
  return documentIdForHash(WS_1, hashDocumentContent(bytes));
}

describe("extraction job failure handling", () => {
  it("retries when the provider throws and writes no extraction, review item, or follow-up", async () => {
    const h = await createTestHarness();
    try {
      let calls = 0;
      h.provider.current = {
        name: "flaky",
        version: "1",
        extract: async (input) => {
          calls += 1;
          if (calls === 1) {
            throw new Error("provider unavailable; Authorization: Bearer llm-token-synthetic");
          }
          return new FakeExtractionProvider().extract(input);
        },
      };
      const documentId = await ingested(h);
      const [first] = await h.worker.runOnce({ kinds: ["extraction"] });
      expect(first).toMatchObject({ state: "retry_scheduled", attempt: 1 });
      expect(first?.error).toContain("provider unavailable");
      expect(first?.error).not.toContain("llm-token-synthetic");
      expect(countRows(h.db, "document_extractions", WS_1)).toBe(0);
      expect(countRows(h.db, "review_items", WS_1)).toBe(0);
      expect(await h.worker.queue.list(h.context, { kinds: ["reconciliation"] })).toEqual([]);

      // The retry runs the provider again and completes normally.
      h.clock.advance(1_000);
      const [second] = await h.worker.runOnce({ kinds: ["extraction"] });
      expect(second).toMatchObject({ state: "succeeded", attempt: 2 });
      expect(calls).toBe(2);
      expect(
        await h.worker.repositories.extractions.getById(WS_1, extractionId(documentId, h.provider)),
      ).toMatchObject({ totalAmount: "42.50" });
      expect(await h.worker.queue.list(h.context, { kinds: ["reconciliation"] })).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("rejects a provider result for a different document without persisting it", async () => {
    const h = await createTestHarness();
    try {
      const mismatching: ExtractionProvider = {
        name: "mismatch",
        version: "1",
        extract: async (input) => ({
          ...(await new FakeExtractionProvider().extract(input)),
          documentId: "doc_somebody_else",
        }),
      };
      h.provider.current = mismatching;
      await ingested(h);
      const [outcome] = await h.worker.runOnce({ kinds: ["extraction"] });
      expect(outcome?.state).toBe("retry_scheduled");
      expect(outcome?.error).toMatch(/returned documentId doc_somebody_else/);
      expect(countRows(h.db, "document_extractions", WS_1)).toBe(0);
      expect(await h.worker.queue.list(h.context, { kinds: ["reconciliation"] })).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("queues an image-only pdf for review as needs_ocr and does not start reconciliation", async () => {
    const h = await createTestHarness();
    try {
      h.provider.current = new PdfTextExtractionProvider();
      const documentId = await ingested(h, SCANNED_IMAGE_ONLY_PDF);
      const { job } =
        (await h.worker.queue.list(h.context, { kinds: ["extraction"] })).map((job) => ({
          job,
        }))[0] ?? fail("no extraction job");
      const [outcome] = await h.worker.runOnce({ kinds: ["extraction"] });
      expect(outcome?.state).toBe("succeeded");

      const id = extractionId(documentId, h.provider);
      const extraction = await h.worker.repositories.extractions.getById(WS_1, id);
      expect(extraction).toMatchObject({ confidence: 0, totalAmount: undefined });
      const item = await h.worker.repositories.reviewQueue.getById(
        WS_1,
        extractionReviewItemId(id),
      );
      expect(item).toMatchObject({ state: "suggested", targetType: "document_extraction" });
      const reasons = (item?.reason as { reasons: string[] }).reasons;
      // Review is forced by the missing amount and zero confidence. The
      // `needs_ocr` status and the provider warning are not among the reasons
      // because they are not persisted; see the `it.fails` case below.
      expect(reasons).toContain("no total amount extracted");
      expect(reasons.some((reason) => reason.startsWith("confidence 0 below"))).toBe(true);

      // Nothing to reconcile against without an amount.
      expect(await h.worker.queue.list(h.context, { kinds: ["reconciliation"] })).toEqual([]);
      expect((await h.worker.queue.listRuns(h.context, job.id))[0]?.result).toMatchObject({
        reviewItemId: extractionReviewItemId(id),
        reconciliationJobId: null,
      });
      expect(outcome?.produced).toEqual([
        { type: "document_extraction", id },
        { type: "review_item", id: extractionReviewItemId(id) },
      ]);
    } finally {
      h.close();
    }
  });

  // BUG (review gate): `extractDocument` derives the review reasons from the
  // row returned by `SqliteDocumentExtractionRepository.save`, but the
  // `document_extractions` table (migration 0002) has no `status` or
  // `warnings` columns, so both are dropped on persistence. A provider result
  // with `status: "needs_review"` (or "failed") and provider warnings, but a
  // confident total, therefore bypasses review entirely and goes straight to
  // reconciliation; the run result also reports `status: null`. Fix by
  // persisting status/warnings (schema + repository) or by computing the
  // reasons from the validated provider result before saving.
  it("queues a provider result flagged needs_review for review even when the fields look confident", async () => {
    const h = await createTestHarness();
    try {
      h.provider.current = {
        name: "flagged",
        version: "1",
        extract: async (input) => ({
          ...(await new FakeExtractionProvider({ confidence: 0.95 }).extract(input)),
          status: "needs_review",
          warnings: ["multiple conflicting total amounts"],
        }),
      };
      const documentId = await ingested(h);
      const [outcome] = await h.worker.runOnce({ kinds: ["extraction"] });
      expect(outcome?.state).toBe("succeeded");
      const id = extractionId(documentId, h.provider);
      // The row itself carries neither status nor warnings (no columns); the
      // review decision is taken from the provider's validated result instead.
      expect(await h.worker.repositories.extractions.getById(WS_1, id)).toMatchObject({
        confidence: 0.95,
      });
      const item = await h.worker.repositories.reviewQueue.getById(
        WS_1,
        extractionReviewItemId(id),
      );
      expect(item?.state).toBe("suggested");
      expect((item?.reason as { reasons: string[] }).reasons).toEqual([
        "extraction status needs_review",
        "warning: multiple conflicting total amounts",
      ]);
      expect(outcome?.produced).toContainEqual({
        type: "review_item",
        id: extractionReviewItemId(id),
      });
    } finally {
      h.close();
    }
  });
});

function fail(message: string): never {
  throw new Error(message);
}
