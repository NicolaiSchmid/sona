import { describe, expect, it } from "vitest";
import { type FetchedDocument, toStoredDocument } from "./provenance.js";

const fetched: FetchedDocument = {
  filename: "amazon-de-invoices-invoice.pdf",
  mimeType: "application/pdf",
  contentHash: "a".repeat(64),
  sourceUrl: "https://amazon.de/invoices/demo",
  provenance: {
    sourcePortal: "amazon.de",
    taskId: "amazon-de-invoices",
    taskVersion: 1,
    runId: "run_1",
    sourceUrl: "https://amazon.de/invoices/demo",
    downloadedFilename: "amazon-de-invoices-invoice.pdf",
    contentHash: "a".repeat(64),
    fetchedAt: "2026-02-01T00:00:00Z",
    browserProvider: "fake",
    workspaceId: "ws_1",
    extractionStatus: "pending",
  },
};

describe("toStoredDocument", () => {
  it("maps a fetched document into receipts document metadata", () => {
    const stored = toStoredDocument({
      document: fetched,
      id: "doc_1",
      storageUri: "s3://sona/ws_1/doc_1.pdf",
      createdAt: "2026-02-01T00:00:01Z",
    });

    expect(stored.id).toBe("doc_1");
    expect(stored.workspaceId).toBe("ws_1");
    expect(stored.sourceKind).toBe("portal");
    expect(stored.contentHash).toBe("a".repeat(64));
    expect(stored.retentionState).toBe("active");
    expect(stored.sourceMetadata).toMatchObject({
      taskId: "amazon-de-invoices",
      sourcePortal: "amazon.de",
      runId: "run_1",
    });
  });
});
