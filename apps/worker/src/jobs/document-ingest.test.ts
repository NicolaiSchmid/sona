import { FakeExtractionProvider, hashDocumentContent } from "@sona/receipts";
import { describe, expect, it } from "vitest";
import { countRows, createTestHarness, stageUpload, WS_1, WS_2 } from "../test-support.js";
import { documentIdForHash, documentStorageUri } from "./document-ingest.js";
import { extractionId, extractionReviewItemId } from "./extraction.js";

const PDF_BYTES = new TextEncoder().encode("%PDF-1.4 synthetic receipt bytes");

describe("document_ingest job", () => {
  it("stores the original under the document id, writes the row, and queues extraction", async () => {
    const h = await createTestHarness();
    try {
      await stageUpload(h, h.context, { id: "upload_1", bytes: PDF_BYTES, filename: "r.pdf" });
      const { job } = await h.worker.queue.enqueue(h.context, "document_ingest", {
        uploadId: "upload_1",
        sourceMetadata: { origin: "test" },
      });
      const [outcome] = await h.worker.runOnce({ kinds: ["document_ingest"] });
      expect(outcome?.state).toBe("succeeded");

      const hash = hashDocumentContent(PDF_BYTES);
      const documentId = documentIdForHash(WS_1, hash);
      const document = await h.worker.repositories.documents.getById(WS_1, documentId);
      expect(document).toMatchObject({
        contentHash: hash,
        mimeType: "application/pdf",
        originalFilename: "r.pdf",
        storageUri: documentStorageUri(WS_1, documentId),
        sourceKind: "upload",
        sourceMetadata: { origin: "test" },
        retentionState: "active",
      });
      const stored = await h.storage.get({ context: h.context, id: documentId });
      expect(stored.document.contentHash).toBe(hash);
      // The staging copy is gone; the original lives under the document id.
      await expect(h.storage.get({ context: h.context, id: "upload_1" })).rejects.toThrow();

      expect(outcome?.produced).toEqual([{ type: "document", id: documentId }]);
      const followUps = await h.worker.queue.list(h.context, { kinds: ["extraction"] });
      expect(followUps.map((j) => j.payload)).toEqual([{ documentId }]);
      expect((await h.worker.queue.listRuns(h.context, job.id))[0]?.result).toMatchObject({
        documentId,
        created: true,
        extractionJobId: followUps[0]?.id,
      });
    } finally {
      h.close();
    }
  });

  it("deduplicates identical bytes per workspace and never shares documents across workspaces", async () => {
    const h = await createTestHarness();
    try {
      await stageUpload(h, h.context, { id: "upload_a", bytes: PDF_BYTES });
      await stageUpload(h, h.context, { id: "upload_b", bytes: PDF_BYTES, filename: "copy.pdf" });
      await stageUpload(h, h.otherContext, { id: "upload_c", bytes: PDF_BYTES });
      await h.worker.queue.enqueue(h.context, "document_ingest", { uploadId: "upload_a" });
      await h.worker.queue.enqueue(h.context, "document_ingest", { uploadId: "upload_b" });
      await h.worker.queue.enqueue(h.otherContext, "document_ingest", { uploadId: "upload_c" });

      const outcomes = await h.worker.runOnce({ kinds: ["document_ingest"] });
      expect(outcomes.map((o) => o.state)).toEqual(["succeeded", "succeeded", "succeeded"]);
      expect(countRows(h.db, "documents", WS_1)).toBe(1);
      expect(countRows(h.db, "documents", WS_2)).toBe(1);
      const results = await Promise.all(
        outcomes.map(async (o) => {
          const context = o.workspaceId === WS_1 ? h.context : h.otherContext;
          return (await h.worker.queue.listRuns(context, o.jobId))[0]?.result;
        }),
      );
      expect(results.map((r) => (r as { created: boolean }).created)).toEqual([true, false, true]);
      // One extraction job per document, not per upload.
      expect(await h.worker.queue.list(h.context, { kinds: ["extraction"] })).toHaveLength(1);
      expect(await h.worker.queue.list(h.otherContext, { kinds: ["extraction"] })).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("redacts credential-shaped keys and values in caller-supplied provenance", async () => {
    const h = await createTestHarness();
    try {
      await stageUpload(h, h.context, { id: "upload_meta", bytes: PDF_BYTES });
      await h.worker.queue.enqueue(h.context, "document_ingest", {
        uploadId: "upload_meta",
        sourceKind: "portal",
        sourceMetadata: {
          portal: "shop.example",
          sessionId: "sess_should_not_persist",
          nested: { authorization: "Bearer abc.def", note: "iban DE89 3704 0044 0532 0130 00" },
          tags: ["ok", "api_key=ak_synthetic"],
        },
      });
      await h.worker.runOnce({ kinds: ["document_ingest"] });
      const document = await h.worker.repositories.documents.getById(
        WS_1,
        documentIdForHash(WS_1, hashDocumentContent(PDF_BYTES)),
      );
      expect(document?.sourceMetadata).toEqual({
        portal: "shop.example",
        sessionId: "[redacted]",
        nested: { authorization: "[redacted]", note: "iban [iban redacted]" },
        tags: ["ok", "api_key=[redacted]"],
      });
    } finally {
      h.close();
    }
  });

  it("dead-letters an ingest whose staged upload is missing or empty", async () => {
    const h = await createTestHarness();
    try {
      await stageUpload(h, h.otherContext, { id: "elsewhere", bytes: PDF_BYTES });
      await h.worker.queue.enqueue(h.context, "document_ingest", { uploadId: "elsewhere" });
      const [outcome] = await h.worker.runOnce();
      expect(outcome).toMatchObject({ state: "dead" });
      expect(outcome?.error).toMatch(/not readable/);
      expect(countRows(h.db, "documents", WS_1)).toBe(0);
    } finally {
      h.close();
    }
  });
});

describe("extraction job", () => {
  async function ingested(h: Awaited<ReturnType<typeof createTestHarness>>): Promise<string> {
    await stageUpload(h, h.context, { id: "upload_1", bytes: PDF_BYTES });
    await h.worker.queue.enqueue(h.context, "document_ingest", { uploadId: "upload_1" });
    await h.worker.runOnce({ kinds: ["document_ingest"] });
    return documentIdForHash(WS_1, hashDocumentContent(PDF_BYTES));
  }

  it("persists a confident extraction without review and queues reconciliation", async () => {
    const h = await createTestHarness();
    try {
      const documentId = await ingested(h);
      const [outcome] = await h.worker.runOnce({ kinds: ["extraction"] });
      expect(outcome?.state).toBe("succeeded");
      const id = extractionId(documentId, h.provider);
      expect(outcome?.produced).toEqual([{ type: "document_extraction", id }]);
      expect(h.provider.calls).toEqual([documentId]);

      const extraction = await h.worker.repositories.extractions.getById(WS_1, id);
      expect(extraction).toMatchObject({ totalAmount: "42.50", confidence: 0.98 });
      expect(await h.worker.repositories.reviewQueue.listByState(WS_1, "suggested")).toEqual([]);
      expect(
        (await h.worker.queue.list(h.context, { kinds: ["reconciliation"] })).map((j) => j.payload),
      ).toEqual([{ documentId }]);
    } finally {
      h.close();
    }
  });

  it("queues low-confidence or failed extractions for review and keeps the result", async () => {
    const h = await createTestHarness();
    try {
      h.provider.current = new FakeExtractionProvider({ confidence: 0.4, totalAmount: "10.00" });
      const documentId = await ingested(h);
      const [outcome] = await h.worker.runOnce({ kinds: ["extraction"] });
      expect(outcome?.state).toBe("succeeded");
      const id = extractionId(documentId, h.provider);
      expect(outcome?.produced).toEqual([
        { type: "document_extraction", id },
        { type: "review_item", id: extractionReviewItemId(id) },
      ]);
      const items = await h.worker.repositories.reviewQueue.listByState(WS_1, "suggested");
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        targetType: "document_extraction",
        targetId: id,
        reason: {
          kind: "extraction_review",
          documentId,
          reasons: ["confidence 0.4 below 0.8"],
        },
      });
      // Reconciliation still runs; the low confidence is carried as a scoring warning.
      expect(await h.worker.queue.list(h.context, { kinds: ["reconciliation"] })).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("is idempotent: a second extraction job for the same document reuses the stored row", async () => {
    const h = await createTestHarness();
    try {
      const documentId = await ingested(h);
      await h.worker.runOnce({ kinds: ["extraction"] });
      const again = await h.worker.queue.enqueue(
        h.context,
        "extraction",
        { documentId },
        { idempotencyKey: "extraction:manual-rerun" },
      );
      expect(again.created).toBe(true);
      const [outcome] = await h.worker.runOnce({ kinds: ["extraction"] });
      expect(outcome?.state).toBe("succeeded");
      expect(h.provider.calls).toEqual([documentId]);
      expect(countRows(h.db, "document_extractions", WS_1)).toBe(1);
      expect((await h.worker.queue.listRuns(h.context, again.job.id))[0]?.result).toMatchObject({
        created: false,
      });
    } finally {
      h.close();
    }
  });

  it("dead-letters extraction of a document that is not in the workspace", async () => {
    const h = await createTestHarness();
    try {
      const documentId = await ingested(h);
      await h.worker.queue.enqueue(h.otherContext, "extraction", { documentId });
      const outcomes = await h.worker.runOnce({ kinds: ["extraction"] });
      const cross = outcomes.find((o) => o.workspaceId === WS_2);
      expect(cross?.state).toBe("dead");
      expect(cross?.error).toMatch(/not found in workspace/);
      expect(countRows(h.db, "document_extractions", WS_2)).toBe(0);
    } finally {
      h.close();
    }
  });
});
