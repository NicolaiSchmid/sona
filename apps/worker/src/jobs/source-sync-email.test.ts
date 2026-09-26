import { email } from "@sona/connectors";
import { FakeExtractionProvider, hashDocumentContent } from "@sona/receipts";
import { describe, expect, it } from "vitest";
import {
  countRows,
  createTestHarness,
  SRC_1,
  stageUpload,
  syntheticSource,
  WS_1,
} from "../test-support.js";
import { documentIdForHash } from "./document-ingest.js";

const INVOICE_PDF = new TextEncoder().encode("%PDF-1.4 synthetic emailed invoice 2026-0042");

function mailbox(
  options: Partial<Omit<email.FakeImapClientOptions, "workspaceId" | "folders">> = {},
): email.FakeImapClient {
  return new email.FakeImapClient({
    workspaceId: WS_1,
    ...options,
    folders: {
      INBOX: {
        uidValidity: "1710000000",
        specialUse: "\\Inbox",
        messages: [
          {
            folder: "INBOX",
            uid: 101,
            uidValidity: "1710000000",
            messageId: "<invoice-2026-0042@billing.vendor.example>",
            subject: "Ihre Rechnung 2026-0042",
            date: "2026-01-15T09:30:00.000Z",
            internalDate: "2026-01-15T09:31:02.000Z",
            from: { name: "Vendor Billing", address: "billing@vendor.example" },
            attachments: [
              {
                partId: "2",
                filename: "Rechnung-2026-0042.pdf",
                mimeType: "application/pdf",
                size: INVOICE_PDF.byteLength,
                disposition: "attachment",
                contentId: undefined,
              },
            ],
            parts: { "2": INVOICE_PDF },
          },
          {
            folder: "INBOX",
            uid: 102,
            uidValidity: "1710000000",
            messageId: "<promo-1@promo.other.test>",
            subject: "Deals",
            date: "2026-01-16T06:00:00.000Z",
            internalDate: "2026-01-16T06:00:10.000Z",
            from: { name: "Promo", address: "news@promo.other.test" },
            attachments: [
              {
                partId: "2",
                filename: "catalog.pdf",
                mimeType: "application/pdf",
                size: 12,
                disposition: "attachment",
                contentId: undefined,
              },
            ],
            parts: { "2": new TextEncoder().encode("%PDF catalog") },
          },
        ],
      },
    },
  });
}

describe("source_sync job for email sources", () => {
  it("stores allowlisted attachments as documents and queues their extraction, idempotently", async () => {
    const client = mailbox();
    const h = await createTestHarness({
      mailboxes: { src_mail: { client, policy: { allowedSenders: ["vendor.example"] } } },
    });
    try {
      await h.worker.repositories.sources.create({
        ...syntheticSource(WS_1, "src_mail"),
        kind: "email",
        displayName: "Synthetic Mailbox",
      });
      const { job } = await h.worker.queue.enqueue(h.context, "source_sync", {
        sourceId: "src_mail",
        window: "w1",
      });
      const [outcome] = await h.worker.runOnce({ kinds: ["source_sync"] });
      expect(outcome?.state).toBe("succeeded");
      expect(h.gatewayCalls).toEqual([{ workspaceId: WS_1, sourceId: "src_mail" }]);

      const documents = h.db
        .prepare("SELECT id, source_kind, original_filename FROM documents WHERE workspace_id = ?")
        .all(WS_1) as Array<{ id: string; source_kind: string; original_filename: string }>;
      expect(documents).toHaveLength(1);
      expect(documents[0]).toMatchObject({
        source_kind: "email",
        original_filename: "Rechnung-2026-0042.pdf",
      });
      const documentId = documents[0]?.id ?? "";
      // The original is retrievable through storage, under this workspace only.
      const stored = await h.storage.get({ context: h.context, id: documentId });
      expect(stored.bytes).toEqual(INVOICE_PDF);
      await expect(h.storage.get({ context: h.otherContext, id: documentId })).rejects.toThrow();

      expect(outcome?.produced).toEqual([
        { type: "source_sync_run", id: expect.any(String) },
        { type: "document", id: documentId },
      ]);
      expect(
        (await h.worker.queue.list(h.context, { kinds: ["extraction"] })).map((j) => j.payload),
      ).toEqual([{ documentId }]);
      expect((await h.worker.queue.listRuns(h.context, job.id))[0]?.result).toMatchObject({
        kind: "email",
        syncStatus: "succeeded",
        messagesSeen: 2,
        messagesIngested: 1,
        attachmentsStored: 1,
        documentsStored: 1,
        errors: [],
      });
      // The non-allowlisted PDF was never downloaded.
      expect(client.commands).not.toContain("UID FETCH 102 BODY[2]");

      // The extraction runs against the emailed bytes like any upload.
      const [extraction] = await h.worker.runOnce({ kinds: ["extraction"] });
      expect(extraction?.state).toBe("succeeded");
      expect(h.provider.calls).toEqual([documentId]);

      // A later window re-syncs from the cursor: nothing new is stored or queued.
      h.clock.advance(60 * 60_000);
      const again = await h.worker.queue.enqueue(h.context, "source_sync", {
        sourceId: "src_mail",
        window: "w2",
      });
      await h.worker.runOnce({ kinds: ["source_sync"] });
      expect((await h.worker.queue.listRuns(h.context, again.job.id))[0]?.result).toMatchObject({
        messagesSeen: 0,
        documentsStored: 0,
      });
      expect(countRows(h.db, "documents", WS_1)).toBe(1);
      expect(await h.worker.queue.list(h.context, { kinds: ["extraction"] })).toHaveLength(1);
    } finally {
      h.close();
    }
  });
});

describe("source_sync job for failing email sources", () => {
  async function emailSource(h: Awaited<ReturnType<typeof createTestHarness>>): Promise<void> {
    await h.worker.repositories.sources.create({
      ...syntheticSource(WS_1, "src_mail"),
      kind: "email",
      displayName: "Synthetic Mailbox",
    });
  }

  it("retries a mailbox that refuses the connection, recording a failed run with the address redacted", async () => {
    const client = mailbox({
      connectError: new Error(
        "LOGIN failed for billing-inbox@mail.example.test: invalid credentials",
      ),
    });
    const h = await createTestHarness({ mailboxes: { src_mail: { client } } });
    try {
      await emailSource(h);
      const { job } = await h.worker.queue.enqueue(h.context, "source_sync", {
        sourceId: "src_mail",
      });
      const [outcome] = await h.worker.runOnce({ kinds: ["source_sync"] });
      expect(outcome).toMatchObject({ state: "retry_scheduled", attempt: 1 });
      expect(outcome?.error).toMatch(/Email sync failed/);
      expect(outcome?.error).toMatch(/invalid credentials/);
      // Neither the job nor the run stores the mailbox address.
      expect(outcome?.error).not.toContain("@");
      expect(outcome?.error).not.toContain("billing-inbox");
      const persisted = await h.worker.queue.get(h.context, job.id);
      expect(persisted?.lastError).not.toContain("@");

      const runs = h.db
        .prepare("SELECT status, error_json FROM source_sync_runs WHERE workspace_id = ?")
        .all(WS_1) as Array<{ status: string; error_json: string | null }>;
      expect(runs.map((r) => r.status)).toEqual(["failed"]);
      expect(runs[0]?.error_json ?? "").not.toContain("@");
      expect(runs[0]?.error_json ?? "").toContain("invalid credentials");

      expect(countRows(h.db, "documents", WS_1)).toBe(0);
      expect(await h.worker.queue.list(h.context, { kinds: ["extraction"] })).toEqual([]);
      // Nothing was listed or fetched after the refused login.
      expect(client.commands.filter((c) => c !== "CONNECT" && c !== "LOGOUT")).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("completes with a uid-scoped, address-free error when one attachment cannot be downloaded", async () => {
    const client = mailbox({ failAttachment: { uid: 101, partId: "2" } });
    const h = await createTestHarness({
      mailboxes: { src_mail: { client, policy: { allowedSenders: ["vendor.example"] } } },
    });
    try {
      await emailSource(h);
      const { job } = await h.worker.queue.enqueue(h.context, "source_sync", {
        sourceId: "src_mail",
      });
      const [outcome] = await h.worker.runOnce({ kinds: ["source_sync"] });
      // A per-message failure is not a job failure: the run finished and the
      // cursor logic retries that message next time.
      expect(outcome?.state).toBe("succeeded");
      const result = (await h.worker.queue.listRuns(h.context, job.id))[0]?.result as {
        syncStatus: string;
        messagesSeen: number;
        documentsStored: number;
        errors: Array<{ scope: string; message: string }>;
      };
      expect(result.syncStatus).toBe("completed_with_errors");
      expect(result.messagesSeen).toBe(2);
      // The failed attachment is not stored; the non-allowlisted one is never fetched.
      expect(result.documentsStored).toBe(0);
      expect(countRows(h.db, "documents", WS_1)).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.scope).toBe("uid:101");
      expect(result.errors[0]?.message).toMatch(/UID 101/);
      expect(result.errors[0]?.message).not.toContain("@");
      expect(JSON.stringify(result.errors)).not.toMatch(/vendor\.example|Rechnung-2026-0042/);
      expect(outcome?.produced.filter((ref) => ref.type === "document")).toEqual([]);
      expect(await h.worker.queue.list(h.context, { kinds: ["extraction"] })).toEqual([]);
    } finally {
      h.close();
    }
  });
});

describe("source_sync re-queues waiting receipts", () => {
  it("re-queues only this workspace's waiting documents, and nothing when no draft changed", async () => {
    const h = await createTestHarness();
    try {
      const receipt = async (
        workspaceId: string,
        id: string,
        totalAmount: string | null = "10.00",
      ): Promise<void> => {
        await h.worker.repositories.documents.save({
          id,
          workspaceId,
          contentHash: `hash_${id}`,
          mimeType: "application/pdf",
          originalFilename: `${id}.pdf`,
          storageUri: `sona-document://${workspaceId}/${id}`,
          sourceKind: "upload",
          sourceMetadata: undefined,
          retentionState: "active",
          createdAt: h.clock.now(),
        });
        await h.worker.repositories.extractions.save(workspaceId, {
          id: `extraction:${id}`,
          extraction: {
            documentId: id,
            vendorName: undefined,
            documentDate: undefined,
            dueDate: undefined,
            totalAmount: totalAmount ?? undefined,
            taxAmount: undefined,
            currency: "EUR",
            invoiceNumber: undefined,
            paymentReference: undefined,
            extractedText: undefined,
            confidence: 0.9,
            extractorVersion: "fake@1",
          },
          createdAt: h.clock.now(),
        });
      };
      // Two waiting receipts here, one in the other workspace, and one whose
      // extraction found no total (nothing reconciliation could do with it).
      await receipt(WS_1, "doc_ws1_a");
      await receipt(WS_1, "doc_ws1_b");
      await receipt(WS_1, "doc_ws1_no_total", null);
      await receipt("ws_2", "doc_ws2");

      const { job } = await h.worker.queue.enqueue(h.context, "source_sync", { sourceId: SRC_1 });
      await h.worker.runOnce({ kinds: ["source_sync"] });
      const result = (await h.worker.queue.listRuns(h.context, job.id))[0]?.result as {
        syncRunId: string;
        reconciliationsQueued: number;
      };
      expect(result.reconciliationsQueued).toBe(2);
      const trigger = `sync:${result.syncRunId}`;
      expect(
        (await h.worker.queue.list(h.context, { kinds: ["reconciliation"] })).map((j) => j.payload),
      ).toEqual([
        { documentId: "doc_ws1_a", trigger },
        { documentId: "doc_ws1_b", trigger },
      ]);
      expect(await h.worker.queue.list(h.otherContext, { kinds: ["reconciliation"] })).toEqual([]);

      // Same bank data in a later window: no draft was created or superseded,
      // so the still-waiting receipts are not queued again.
      h.clock.advance(60 * 60_000);
      const again = await h.worker.queue.enqueue(h.context, "source_sync", {
        sourceId: SRC_1,
        window: "w2",
      });
      await h.worker.runOnce({ kinds: ["source_sync"] });
      expect((await h.worker.queue.listRuns(h.context, again.job.id))[0]?.result).toMatchObject({
        drafts: { created: 0, superseded: 0, unchanged: 2 },
        reconciliationsQueued: 0,
      });
      expect(await h.worker.queue.list(h.context, { kinds: ["reconciliation"] })).toHaveLength(2);
    } finally {
      h.close();
    }
  });

  it("reconciles a receipt that arrived before its bank transaction once the sync brings it in", async () => {
    const h = await createTestHarness();
    try {
      // Receipt first: nothing to match yet, so reconciliation finds nothing.
      h.provider.current = new FakeExtractionProvider({
        vendorName: "Example Handwerk GmbH",
        documentDate: "2026-01-15",
        totalAmount: "84.23",
        currency: "EUR",
        invoiceNumber: "2026-0042",
      });
      const bytes = new TextEncoder().encode("%PDF-1.4 early receipt");
      await stageUpload(h, h.context, { id: "upload_early", bytes });
      await h.worker.queue.enqueue(h.context, "document_ingest", { uploadId: "upload_early" });
      await h.worker.runOnce({ kinds: ["document_ingest"] });
      await h.worker.runOnce({ kinds: ["extraction"] });
      const [first] = await h.worker.runOnce({ kinds: ["reconciliation"] });
      expect(
        (await h.worker.queue.listRuns(h.context, first?.jobId ?? ""))[0]?.result,
      ).toMatchObject({ scored: 0, autoMatched: 0 });
      const documentId = documentIdForHash(WS_1, hashDocumentContent(bytes));

      // Then the bank sync: the sync itself re-queues the waiting receipt.
      const { job } = await h.worker.queue.enqueue(h.context, "source_sync", { sourceId: SRC_1 });
      await h.worker.runOnce({ kinds: ["source_sync"] });
      const syncResult = (await h.worker.queue.listRuns(h.context, job.id))[0]?.result as {
        syncRunId: string;
        reconciliationsQueued: number;
      };
      expect(syncResult.reconciliationsQueued).toBe(1);
      const requeued = await h.worker.queue.list(h.context, { kinds: ["reconciliation"] });
      expect(requeued.map((j) => j.idempotencyKey)).toEqual([
        `reconciliation:${documentId}`,
        `reconciliation:${documentId}:sync:${syncResult.syncRunId}`,
      ]);

      const [second] = await h.worker.runOnce({ kinds: ["reconciliation"] });
      expect(
        (await h.worker.queue.listRuns(h.context, second?.jobId ?? ""))[0]?.result,
      ).toMatchObject({ autoMatched: 1 });
      expect(
        await h.worker.repositories.evidenceLinks.listForDocument(WS_1, documentId),
      ).toHaveLength(1);

      // Once substantiated, the next sync leaves it alone.
      h.clock.advance(60 * 60_000);
      const again = await h.worker.queue.enqueue(h.context, "source_sync", {
        sourceId: SRC_1,
        window: "w2",
      });
      await h.worker.runOnce({ kinds: ["source_sync"] });
      expect((await h.worker.queue.listRuns(h.context, again.job.id))[0]?.result).toMatchObject({
        reconciliationsQueued: 0,
      });
    } finally {
      h.close();
    }
  });
});
