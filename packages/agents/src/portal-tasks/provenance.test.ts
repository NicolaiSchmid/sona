import { describe, expect, it } from "vitest";
import { type FetchedDocument, toStoredDocument } from "./provenance.js";

function makeFetched(overrides: Partial<FetchedDocument> = {}): FetchedDocument {
  return {
    filename: "amazon-de-invoices-invoice.pdf",
    mimeType: "application/pdf",
    contentHash: "a".repeat(64),
    sourceUrl: "https://amazon.de/invoices/demo",
    content: { kind: "bytes", bytes: new Uint8Array([1, 2, 3]) },
    provenance: {
      sourcePortal: "amazon.de",
      taskId: "amazon-de-invoices",
      taskVersion: 1,
      runId: "run_1",
      sourceUrl: "https://amazon.de/invoices/demo?session=SECRET&sig=abc#frag",
      downloadedFilename: "amazon-de-invoices-invoice.pdf",
      contentHash: "a".repeat(64),
      fetchedAt: "2026-02-01T00:00:00Z",
      browserProvider: "fake",
      workspaceId: "ws_1",
      extractionStatus: "pending",
    },
    ...overrides,
  };
}

describe("toStoredDocument", () => {
  it("maps a fetched document into receipts document metadata", () => {
    const stored = toStoredDocument({
      document: makeFetched(),
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

  it("strips query and fragment from the persisted source URL", () => {
    const stored = toStoredDocument({
      document: makeFetched(),
      id: "doc_1",
      storageUri: "s3://sona/ws_1/doc_1.pdf",
      createdAt: "2026-02-01T00:00:01Z",
    });
    const meta = stored.sourceMetadata as { sourceUrl: string };
    expect(meta.sourceUrl).toBe("https://amazon.de/invoices/demo");
    expect(meta.sourceUrl).not.toContain("SECRET");
  });

  it("rejects a document whose hash disagrees with its provenance", () => {
    const bad = makeFetched({ contentHash: "b".repeat(64) });
    expect(() =>
      toStoredDocument({
        document: bad,
        id: "doc_1",
        storageUri: "s3://sona/ws_1/doc_1.pdf",
        createdAt: "2026-02-01T00:00:01Z",
      }),
    ).toThrow(/hash mismatch/i);
  });
});
