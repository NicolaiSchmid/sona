import { InMemoryDocumentStorage, type RawSourceRecord, sha256Hex } from "@sona/core";
import { describe, expect, it } from "vitest";
import { PaperlessReadOnlyViolationError } from "./errors.js";
import { FakePaperlessClient, type FakePaperlessClientOptions } from "./fake-client.js";
import {
  ARCHIVE_FIXTURE,
  CORRESPONDENTS,
  DOCUMENT_TYPES,
  DUPLICATE_INVOICE_DOCUMENT,
  INVOICE_DOCUMENT,
  INVOICE_PDF,
  MISLABELLED_DOCUMENT,
  PRIVATE_PHOTO_DOCUMENT,
  RECEIPT_DOCUMENT,
  TAGS,
} from "./fixtures.js";
import {
  type IngestedPaperlessDocument,
  type PaperlessDocumentStore,
  type PaperlessRawRecordStore,
  type PaperlessSyncCursor,
  type PaperlessSyncRunStore,
  type PaperlessSyncSummary,
  runPaperlessSync,
  type SyncEnv,
} from "./sync.js";
import type { PaperlessClient, PaperlessSourcePolicy } from "./types.js";

interface Stores {
  raws: RawSourceRecord[];
  documents: IngestedPaperlessDocument[];
  rawStore: PaperlessRawRecordStore;
  documentStore: PaperlessDocumentStore;
  documentStorage: InMemoryDocumentStorage;
  runEvents: Array<{ kind: "start" | "error" | "finish"; payload: unknown }>;
  cursors: PaperlessSyncCursor[];
  runStore: PaperlessSyncRunStore;
  env: SyncEnv;
}

function createStores(): Stores {
  const raws: RawSourceRecord[] = [];
  const documents: IngestedPaperlessDocument[] = [];
  const runEvents: Stores["runEvents"] = [];
  const cursors: PaperlessSyncCursor[] = [];
  let counter = 0;
  let tick = 0;
  return {
    raws,
    documents,
    runEvents,
    cursors,
    rawStore: {
      append: async (record) => {
        if (!raws.some((r) => r.payloadHash === record.payloadHash)) {
          raws.push(record);
        }
      },
      findByExternalId: async (workspaceId, sourceId, externalId) =>
        [...raws]
          .reverse()
          .find(
            (r) =>
              r.workspaceId === workspaceId &&
              r.sourceId === sourceId &&
              r.externalId === externalId,
          ),
    },
    documentStore: {
      findByContentHash: async (workspaceId, contentHash) =>
        documents.find((d) => d.workspaceId === workspaceId && d.contentHash === contentHash),
      save: async (document) => {
        const existing = documents.find(
          (d) => d.workspaceId === document.workspaceId && d.contentHash === document.contentHash,
        );
        if (existing !== undefined) {
          return { id: existing.id };
        }
        documents.push(document);
        return { id: document.id };
      },
    },
    documentStorage: new InMemoryDocumentStorage(),
    runStore: {
      start: async (run) => {
        runEvents.push({ kind: "start", payload: run });
      },
      recordError: async (error) => {
        runEvents.push({ kind: "error", payload: error });
      },
      finish: async (run) => {
        runEvents.push({ kind: "finish", payload: run });
        if (run.summary.cursor !== undefined) {
          cursors.push(run.summary.cursor);
        }
      },
      latestCursor: async () => cursors.at(-1),
    },
    env: {
      ids: () => `id_${counter++}`,
      nowIso: () => `2026-04-01T00:00:${String(tick++).padStart(2, "0")}Z`,
    },
  };
}

const base = { workspaceId: "ws_1", sourceId: "src_paperless_1" };
const STEUER_ONLY: PaperlessSourcePolicy = { requiredTagNames: ["steuer"] };

function archiveClient(overrides: Partial<FakePaperlessClientOptions> = {}): FakePaperlessClient {
  return new FakePaperlessClient({
    workspaceId: base.workspaceId,
    documents: ARCHIVE_FIXTURE,
    tags: TAGS,
    correspondents: CORRESPONDENTS,
    documentTypes: DOCUMENT_TYPES,
    ...overrides,
  });
}

async function sync(
  stores: Stores,
  client: PaperlessClient,
  policy: PaperlessSourcePolicy = STEUER_ONLY,
  pageSize?: number,
): Promise<PaperlessSyncSummary> {
  return runPaperlessSync({ ...base, client, policy, ...stores, pageSize });
}

function finishStatus(stores: Stores): string[] {
  return stores.runEvents
    .filter((e) => e.kind === "finish")
    .map((e) => (e.payload as { status: string }).status);
}

describe("runPaperlessSync", () => {
  it("imports tagged documents with metadata mapped and originals copied into Sona storage", async () => {
    const stores = createStores();
    const client = archiveClient();
    const summary = await sync(stores, client);

    expect(summary).toMatchObject({
      documentsSeen: 3,
      documentsIngested: 2,
      documentsSkippedNotAllowlisted: 1,
      documentsStored: 2,
      documentsDeduplicated: 0,
      errors: [],
    });
    expect(finishStatus(stores)).toEqual(["succeeded"]);

    const invoiceRaw = stores.raws.find((r) => r.externalId === "paperless:101");
    expect(invoiceRaw?.recordType).toBe("document");
    expect(invoiceRaw?.observedAt).toBe(INVOICE_DOCUMENT.modified);
    expect(invoiceRaw?.payloadJson).toEqual({
      kind: "paperless_document",
      instanceHost: "paperless.test",
      paperlessId: 101,
      title: "Broadband invoice March",
      created: INVOICE_DOCUMENT.created,
      modified: INVOICE_DOCUMENT.modified,
      added: INVOICE_DOCUMENT.added,
      correspondent: "Example Telecom",
      documentType: "Invoice",
      tags: ["Steuer", "Rechnung"],
      archiveSerialNumber: 7,
      originalFileName: "invoice-2026-03.pdf",
      document: {
        contentHash: sha256Hex(INVOICE_PDF),
        byteLength: INVOICE_PDF.byteLength,
        mimeType: "application/pdf",
      },
    });

    const invoiceDoc = stores.documents.find((d) => d.contentHash === sha256Hex(INVOICE_PDF));
    expect(invoiceDoc).toMatchObject({
      workspaceId: "ws_1",
      sourceKind: "paperless",
      mimeType: "application/pdf",
      originalFilename: "invoice-2026-03.pdf",
      retentionState: "active",
    });
    expect(invoiceDoc?.sourceMetadata).toMatchObject({
      paperlessId: 101,
      paperlessExternalId: "paperless:101",
      instanceHost: "paperless.test",
      tags: ["Steuer", "Rechnung"],
      correspondent: "Example Telecom",
    });
    const stored = await stores.documentStorage.get({
      context: { workspaceId: "ws_1" },
      id: invoiceDoc?.id ?? "",
    });
    expect(Buffer.from(stored.bytes).equals(INVOICE_PDF)).toBe(true);

    // A document without an original filename gets a stable synthetic one.
    const receiptDoc = stores.documents.find((d) => d.originalFilename === "paperless-102.pdf");
    expect(receiptDoc).toBeDefined();
    expect(stores.raws.some((r) => r.externalId === "paperless:103")).toBe(false);
  });

  it("only ever issues GET requests", async () => {
    const stores = createStores();
    const client = archiveClient();
    await sync(stores, client);
    expect(client.requests.length).toBeGreaterThan(0);
    expect(client.requests.every((r) => r.startsWith("GET "))).toBe(true);
    await expect(client.updateDocument(101)).rejects.toBeInstanceOf(
      PaperlessReadOnlyViolationError,
    );
  });

  it("re-syncing an unchanged archive imports nothing new", async () => {
    const stores = createStores();
    await sync(stores, archiveClient());
    const rawsBefore = stores.raws.length;
    const docsBefore = stores.documents.length;

    const client = archiveClient();
    const again = await sync(stores, client);
    expect(again.documentsSeen).toBe(0);
    expect(again.documentsIngested).toBe(0);
    expect(stores.raws).toHaveLength(rawsBefore);
    expect(stores.documents).toHaveLength(docsBefore);
    expect(client.requests.some((r) => r.includes("/download/"))).toBe(false);
    expect(
      client.requests.some((r) => r.includes(`modified__gte=${PRIVATE_PHOTO_DOCUMENT.modified}`)),
    ).toBe(true);
  });

  it("skips the boundary document already covered by the cursor without downloading", async () => {
    const stores = createStores();
    await sync(stores, archiveClient());
    // The cursor's own document is returned again by `modified__gte`; it must be a no-op.
    const client = archiveClient();
    const again = await sync(stores, client);
    expect(again.documentsSeen).toBe(0);
    expect(again.documentsSkippedDuplicate).toBe(0);
    expect(client.requests.filter((r) => r.includes("/download/"))).toEqual([]);
  });

  it("deduplicates identical bytes under a second Paperless id and records both provenances", async () => {
    const stores = createStores();
    await sync(stores, archiveClient());
    const summary = await sync(
      stores,
      archiveClient({ documents: [...ARCHIVE_FIXTURE, DUPLICATE_INVOICE_DOCUMENT] }),
    );
    expect(summary).toMatchObject({
      documentsSeen: 1,
      documentsIngested: 1,
      documentsStored: 0,
      documentsDeduplicated: 1,
    });
    expect(stores.documents.filter((d) => d.contentHash === sha256Hex(INVOICE_PDF))).toHaveLength(
      1,
    );
    expect(stores.raws.filter((r) => r.externalId === "paperless:104")).toHaveLength(1);
  });

  it("appends a superseding raw record when metadata changed and bytes did not", async () => {
    const stores = createStores();
    await sync(stores, archiveClient());
    const retagged = { ...INVOICE_DOCUMENT, tagIds: [1], modified: "2026-03-09T09:00:00Z" };
    const summary = await sync(
      stores,
      archiveClient({ documents: [retagged, RECEIPT_DOCUMENT, PRIVATE_PHOTO_DOCUMENT] }),
    );
    expect(summary).toMatchObject({
      documentsIngested: 1,
      documentsDeduplicated: 1,
      documentsStored: 0,
    });
    const records = stores.raws.filter((r) => r.externalId === "paperless:101");
    expect(records).toHaveLength(2);
    expect(records[1]?.supersedesRecordId).toBe(records[0]?.id);
    expect(records[1]?.payloadJson).toMatchObject({ tags: ["Steuer"] });
    expect(records[0]?.payloadJson).toMatchObject({ tags: ["Steuer", "Rechnung"] });
  });

  it("refuses bytes that do not match the declared type", async () => {
    const stores = createStores();
    const summary = await sync(stores, archiveClient({ documents: [MISLABELLED_DOCUMENT] }));
    expect(summary).toMatchObject({
      documentsSeen: 1,
      documentsIngested: 0,
      documentsSkippedPolicy: 1,
    });
    expect(stores.documents).toEqual([]);
    expect(stores.raws).toEqual([]);
  });

  it("skips originals above the byte cap and listed types outside the policy", async () => {
    const stores = createStores();
    const summary = await sync(stores, archiveClient(), {
      requiredTagNames: [],
      maxDocumentBytes: RECEIPT_DOCUMENT.bytes.byteLength - 1,
      allowedMimeTypes: ["application/pdf"],
    });
    // The PNG is refused by its listed type before download; both PDFs exceed the cap.
    expect(summary).toMatchObject({
      documentsSeen: 3,
      documentsIngested: 0,
      documentsSkippedPolicy: 3,
    });
  });

  it("imports everything when no tags are required and pages through the archive", async () => {
    const stores = createStores();
    const client = archiveClient();
    const summary = await sync(stores, client, { requiredTagNames: [] }, 1);
    expect(summary).toMatchObject({ documentsSeen: 3, documentsIngested: 3 });
    expect(client.requests.filter((r) => r.includes("api/documents/?"))).toHaveLength(3);
    expect(summary.cursor).toEqual({
      lastModified: PRIVATE_PHOTO_DOCUMENT.modified,
      lastDocumentId: PRIVATE_PHOTO_DOCUMENT.id,
      policyHash: expect.any(String),
    });
  });

  it("rescans when the policy changes and reports the reset", async () => {
    const stores = createStores();
    await sync(stores, archiveClient());
    const widened = await sync(stores, archiveClient(), { requiredTagNames: [] });
    expect(widened.cursorReset).toBe("policy_changed");
    // Already-imported documents are recognised as duplicates; the photo is new.
    expect(widened).toMatchObject({
      documentsSeen: 3,
      documentsSkippedDuplicate: 2,
      documentsIngested: 1,
      documentsStored: 1,
    });
  });

  it("fails cleanly with no partial state when Paperless is down", async () => {
    const stores = createStores();
    await expect(
      sync(
        stores,
        archiveClient({
          listError: new Error("connect ECONNREFUSED https://paperless.test/api/?token=abc"),
        }),
      ),
    ).rejects.toThrow(
      /Paperless sync failed: connect ECONNREFUSED https:\/\/paperless.test\/api\/\?\[redacted\]/,
    );
    expect(finishStatus(stores)).toEqual(["failed"]);
    expect(stores.raws).toEqual([]);
    expect(stores.documents).toEqual([]);
    expect(stores.cursors).toEqual([]);
  });

  it("pins the cursor on a failed download and keeps processing later documents", async () => {
    const stores = createStores();
    const summary = await sync(stores, archiveClient({ failDownloadIds: [101] }));
    expect(finishStatus(stores)).toEqual(["completed_with_errors"]);
    expect(summary.errors).toEqual([
      { documentId: 101, message: expect.stringContaining("connection reset") },
    ]);
    expect(summary.documentsIngested).toBe(1);
    expect(summary.cursor).toBeUndefined();

    // The next run retries the failed document from scratch.
    const retry = await sync(stores, archiveClient());
    expect(retry.documentsIngested).toBe(1);
    expect(retry.documentsSkippedDuplicate).toBe(1);
    expect(stores.raws.some((r) => r.externalId === "paperless:101")).toBe(true);
  });

  it("refuses a client bound to another workspace", async () => {
    const stores = createStores();
    await expect(sync(stores, archiveClient({ workspaceId: "ws_2" }))).rejects.toThrow(
      /different workspace/,
    );
    expect(stores.runEvents).toEqual([]);
  });

  it("keeps titles and filenames out of error records", async () => {
    const stores = createStores();
    const failing: PaperlessDocumentStore = {
      ...stores.documentStore,
      save: async () => {
        throw new Error(`disk full while writing ${INVOICE_DOCUMENT.originalFileName}`);
      },
    };
    const summary = await runPaperlessSync({
      ...base,
      client: archiveClient({ documents: [INVOICE_DOCUMENT] }),
      policy: STEUER_ONLY,
      ...stores,
      documentStore: failing,
    });
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]?.message).not.toContain("invoice-2026-03.pdf");
    expect(summary.errors[0]?.message).not.toContain("Broadband");
    expect(summary.errors[0]?.message).toContain("[redacted]");
  });
});
