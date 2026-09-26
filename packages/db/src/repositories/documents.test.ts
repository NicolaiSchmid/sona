import type { StoredDocument } from "@sona/receipts";
import { describe, expect, it } from "vitest";
import { SqliteDocumentExtractionRepository, SqliteDocumentRepository } from "./documents.js";
import { SqliteEvidenceLinkRepository } from "./evidence-links.js";
import { SqliteLedgerRepository } from "./ledger.js";
import { createTestDatabase, type TestDatabase } from "./test-support.js";

const AT = "2026-02-01T00:00:00.000Z";

function document(input: Partial<StoredDocument> & { id: string }): StoredDocument {
  return {
    workspaceId: "ws_1",
    contentHash: `hash_${input.id}`,
    mimeType: "application/pdf",
    originalFilename: "synthetic-receipt.pdf",
    storageUri: `object://synthetic/${input.id}`,
    sourceKind: "upload",
    sourceMetadata: undefined,
    retentionState: "active",
    createdAt: AT,
    ...input,
  };
}

/** A balanced draft ledger transaction a document can substantiate. */
async function ledgerTransaction(t: TestDatabase, workspaceId: string, id: string): Promise<void> {
  const ledger = new SqliteLedgerRepository(t.db);
  await ledger.ensureDefaultAccounts(workspaceId, {
    createdAt: AT,
    accountIdFor: (path) => `acct:${workspaceId}:${path}`,
  });
  await ledger.createTransaction(workspaceId, {
    id,
    bookedOn: "2026-01-15",
    description: `Synthetic ${id}`,
    postings: [
      { account: "Assets:Bank", amount: { amount: "-10.00", commodity: "EUR" } },
      { account: "Suspense:Unclassified", amount: { amount: "10.00", commodity: "EUR" } },
    ],
    createdAt: AT,
  });
}

describe("SqliteDocumentRepository.listUnsubstantiated", () => {
  it("returns only active documents without an outgoing substantiates link, oldest first", async () => {
    const t = createTestDatabase();
    try {
      const documents = new SqliteDocumentRepository(t.db);
      const links = new SqliteEvidenceLinkRepository(t.db);
      await ledgerTransaction(t, "ws_1", "tx_1");
      await ledgerTransaction(t, "ws_1", "tx_2");

      // Waiting, in deliberately unsorted insertion order to check the ordering.
      await documents.save(document({ id: "doc_late", createdAt: "2026-02-03T00:00:00.000Z" }));
      await documents.save(document({ id: "doc_b" }));
      await documents.save(document({ id: "doc_a" }));
      // Substantiates a ledger transaction: settled.
      await documents.save(document({ id: "doc_settled" }));
      await links.link({
        id: "link_settled",
        workspaceId: "ws_1",
        fromType: "document",
        fromId: "doc_settled",
        toType: "ledger_transaction",
        toId: "tx_1",
        kind: "substantiates",
        createdAt: AT,
      });
      // Other link kinds do not count as substantiation.
      await documents.save(document({ id: "doc_imported" }));
      await links.link({
        id: "link_imported",
        workspaceId: "ws_1",
        fromType: "document",
        fromId: "doc_imported",
        toType: "ledger_transaction",
        toId: "tx_2",
        kind: "imported_as",
        createdAt: AT,
      });
      await links.link({
        id: "link_reviewed",
        workspaceId: "ws_1",
        fromType: "document",
        fromId: "doc_imported",
        toType: "ledger_transaction",
        toId: "tx_2",
        kind: "reviewed_by",
        createdAt: AT,
      });
      // A substantiates edge pointing *at* the document is not the document substantiating anything.
      await documents.save(document({ id: "doc_target" }));
      await links.link({
        id: "link_target",
        workspaceId: "ws_1",
        fromType: "ledger_transaction",
        fromId: "tx_2",
        toType: "document",
        toId: "doc_target",
        kind: "substantiates",
        createdAt: AT,
      });
      // Not active: never re-queued, whatever its links.
      for (const retentionState of ["archived", "delete_requested", "deleted"] as const) {
        await documents.save(document({ id: `doc_${retentionState}`, retentionState }));
      }

      const waiting = await documents.listUnsubstantiated("ws_1");
      expect(waiting.map((d) => d.id)).toEqual([
        "doc_a",
        "doc_b",
        "doc_imported",
        "doc_target",
        "doc_late",
      ]);
      expect(waiting.every((d) => d.retentionState === "active")).toBe(true);
    } finally {
      t.close();
    }
  });

  it("honours the limit and rejects a non-positive or fractional one", async () => {
    const t = createTestDatabase();
    try {
      const documents = new SqliteDocumentRepository(t.db);
      await documents.save(document({ id: "doc_1" }));
      await documents.save(document({ id: "doc_2" }));
      await documents.save(document({ id: "doc_3" }));

      expect((await documents.listUnsubstantiated("ws_1", 2)).map((d) => d.id)).toEqual([
        "doc_1",
        "doc_2",
      ]);
      expect(await documents.listUnsubstantiated("ws_1", 1)).toHaveLength(1);
      for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(documents.listUnsubstantiated("ws_1", limit)).rejects.toThrow(
          /positive integer/,
        );
      }
    } finally {
      t.close();
    }
  });

  it("lists documents awaiting reconciliation only when an extraction with a total exists", async () => {
    const t = createTestDatabase();
    try {
      const documents = new SqliteDocumentRepository(t.db);
      const extractions = new SqliteDocumentExtractionRepository(t.db);
      const links = new SqliteEvidenceLinkRepository(t.db);
      await documents.save(document({ id: "doc_ready" }));
      await documents.save(document({ id: "doc_no_total" }));
      await documents.save(document({ id: "doc_unextracted" }));
      await documents.save(document({ id: "doc_done" }));
      const extraction = (documentId: string, totalAmount: string | undefined) => ({
        documentId,
        vendorName: undefined,
        documentDate: undefined,
        dueDate: undefined,
        totalAmount,
        taxAmount: undefined,
        currency: "EUR",
        invoiceNumber: undefined,
        paymentReference: undefined,
        extractedText: undefined,
        confidence: 0.9,
        extractorVersion: "fake@1",
      });
      await extractions.save("ws_1", {
        id: "x_ready",
        extraction: extraction("doc_ready", "10.00"),
        createdAt: AT,
      });
      await extractions.save("ws_1", {
        id: "x_no_total",
        extraction: extraction("doc_no_total", undefined),
        createdAt: AT,
      });
      await extractions.save("ws_1", {
        id: "x_done",
        extraction: extraction("doc_done", "10.00"),
        createdAt: AT,
      });
      await ledgerTransaction(t, "ws_1", "tx_done");
      await links.link({
        id: "el_done",
        workspaceId: "ws_1",
        fromType: "document",
        fromId: "doc_done",
        toType: "ledger_transaction",
        toId: "tx_done",
        kind: "substantiates",
        createdAt: AT,
      });

      expect((await documents.listAwaitingReconciliation("ws_1")).map((d) => d.id)).toEqual([
        "doc_ready",
      ]);
      // Same timestamp for all three, so the id breaks the tie.
      expect((await documents.listUnsubstantiated("ws_1")).map((d) => d.id)).toEqual([
        "doc_no_total",
        "doc_ready",
        "doc_unextracted",
      ]);
      await expect(documents.listAwaitingReconciliation("ws_1", 0)).rejects.toThrow(
        /positive integer/,
      );
      expect(await documents.listAwaitingReconciliation("ws_2")).toEqual([]);
    } finally {
      t.close();
    }
  });

  it("never lists another workspace's documents", async () => {
    const t = createTestDatabase();
    try {
      const documents = new SqliteDocumentRepository(t.db);
      const links = new SqliteEvidenceLinkRepository(t.db);
      await ledgerTransaction(t, "ws_1", "tx_1");
      // ws_1's only document is substantiated; ws_2's two are waiting.
      await documents.save(document({ id: "doc_ws1" }));
      await documents.save(document({ id: "doc_ws2_a", workspaceId: "ws_2" }));
      await documents.save(document({ id: "doc_ws2_b", workspaceId: "ws_2" }));
      await links.link({
        id: "link_1",
        workspaceId: "ws_1",
        fromType: "document",
        fromId: "doc_ws1",
        toType: "ledger_transaction",
        toId: "tx_1",
        kind: "substantiates",
        createdAt: AT,
      });

      expect(await documents.listUnsubstantiated("ws_1")).toEqual([]);
      expect((await documents.listUnsubstantiated("ws_2")).map((d) => d.id)).toEqual([
        "doc_ws2_a",
        "doc_ws2_b",
      ]);
      expect(await documents.listUnsubstantiated("ws_unknown")).toEqual([]);
    } finally {
      t.close();
    }
  });
});
