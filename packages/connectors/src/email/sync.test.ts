import {
  type DocumentStorage,
  InMemoryDocumentStorage,
  type RawSourceRecord,
  sha256Hex,
} from "@sona/core";
import { describe, expect, it } from "vitest";
import {
  type FakeFolder,
  FakeImapClient,
  type FakeImapClientOptions,
  ImapReadOnlyViolationError,
} from "./fake-imap-client.js";
import {
  FORWARDED_INVOICE_MESSAGE,
  INBOX_FIXTURE,
  INVOICE_MESSAGE,
  INVOICE_PDF,
  NEWSLETTER_MESSAGE,
  NO_MESSAGE_ID_MESSAGE,
  PHOTO_MESSAGE,
  RECEIPT_PHOTO,
  SECOND_INVOICE_PDF,
  SIGNATURE_LOGO,
  UID_VALIDITY,
  VENDOR_ALLOWLIST,
} from "./fixtures.js";
import {
  type EmailDocumentStore,
  type EmailRawRecordStore,
  type EmailSyncCursor,
  type EmailSyncRunStore,
  type EmailSyncSummary,
  type IngestedEmailDocument,
  runEmailSync,
  type SyncEnv,
} from "./sync.js";
import type { EmailAttachmentPart, EmailSourcePolicy, ImapClient } from "./types.js";

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** In-memory stores shared across runs so idempotency can be observed. */
interface Stores {
  raws: RawSourceRecord[];
  documents: IngestedEmailDocument[];
  rawStore: EmailRawRecordStore;
  documentStore: EmailDocumentStore;
  documentStorage: InMemoryDocumentStorage;
  runEvents: Array<{ kind: "start" | "error" | "finish"; payload: unknown }>;
  cursors: EmailSyncCursor[];
  runStore: EmailSyncRunStore;
  env: SyncEnv;
}

function createStores(): Stores {
  const raws: RawSourceRecord[] = [];
  const documents: IngestedEmailDocument[] = [];
  const runEvents: Stores["runEvents"] = [];
  const cursors: EmailSyncCursor[] = [];
  let counter = 0;
  let tick = 0;
  return {
    raws,
    documents,
    runEvents,
    cursors,
    rawStore: {
      append: async (record) => {
        // Mirror the `uq_raw_records_dedup` index: same payload hash is a no-op.
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
      latestCursor: async ({ folder }) => cursors.filter((c) => c.folder === folder).at(-1),
    },
    env: {
      ids: () => `id_${counter++}`,
      nowIso: () => `2026-02-01T00:00:${String(tick++).padStart(2, "0")}Z`,
    },
  };
}

const base = { workspaceId: "ws_1", sourceId: "src_email_1" };

function inboxClient(
  overrides: Partial<FakeImapClientOptions> = {},
  folder: FakeFolder = INBOX_FIXTURE,
): FakeImapClient {
  return new FakeImapClient({
    workspaceId: base.workspaceId,
    folders: { INBOX: folder },
    ...overrides,
  });
}

async function sync(
  stores: Stores,
  client: ImapClient,
  policy: EmailSourcePolicy = { allowedSenders: [...VENDOR_ALLOWLIST] },
): Promise<EmailSyncSummary> {
  return runEmailSync({ ...base, client, policy, ...stores });
}

describe("runEmailSync", () => {
  it("ingests allowlisted attachments, dedupes by content, and records redacted metadata", async () => {
    const stores = createStores();
    const client = inboxClient();
    const summary = await sync(stores, client);

    expect(summary).toMatchObject({
      messagesSeen: 5,
      messagesIngested: 4,
      messagesSkippedNotAllowlisted: 1,
      messagesSkippedDuplicate: 0,
      messagesWithoutDocuments: 0,
      attachmentsStored: 3,
      attachmentsDeduplicated: 1,
      attachmentsSkipped: 2,
      cursorReset: undefined,
      cursor: { folder: "INBOX", uidValidity: UID_VALIDITY, lastUid: 105 },
      errors: [],
    });

    // Three distinct documents: invoice PDF, receipt photo, second invoice PDF.
    expect(stores.documents.map((d) => d.contentHash).sort()).toEqual(
      [sha256Hex(INVOICE_PDF), sha256Hex(RECEIPT_PHOTO), sha256Hex(SECOND_INVOICE_PDF)].sort(),
    );
    const invoiceDoc = stores.documents.find((d) => d.contentHash === sha256Hex(INVOICE_PDF));
    expect(invoiceDoc).toMatchObject({
      workspaceId: "ws_1",
      mimeType: "application/pdf",
      originalFilename: "Rechnung-2026-0042.pdf",
      sourceKind: "email",
      retentionState: "active",
      storageUri: `sona-document://ws_1/${invoiceDoc?.id}`,
      sourceMetadata: {
        sourceId: "src_email_1",
        messageExternalId: "msgid:invoice-2026-0042@billing.vendor.example",
        folder: "INBOX",
        uid: 101,
        partId: "2",
      },
    });
    // Bytes are retrievable through the storage boundary under the workspace.
    const stream = await stores.documentStorage.get({
      context: { workspaceId: "ws_1" },
      id: invoiceDoc?.id ?? "",
    });
    expect(stream.document.contentHash).toBe(sha256Hex(INVOICE_PDF));

    // One raw record per ingested message (the forwarded duplicate still gets
    // its own provenance record pointing at the same content hash).
    expect(stores.raws).toHaveLength(4);
    expect(stores.raws.map((r) => r.externalId)).toEqual([
      "msgid:invoice-2026-0042@billing.vendor.example",
      "msgid:photo-1@shop.vendor.example",
      "msgid:fwd-1@vendor.example",
      "uid:INBOX:1710000000:105",
    ]);
    const forwarded = stores.raws[2];
    expect(forwarded?.recordType).toBe("document");
    expect(forwarded?.observedAt).toBe(FORWARDED_INVOICE_MESSAGE.date);
    expect(forwarded?.payloadJson).toMatchObject({
      kind: "email_message",
      uid: 104,
      fromAddress: "support@vendor.example",
      attachments: [{ partId: "2", contentHash: sha256Hex(INVOICE_PDF) }],
    });
    // Message without a Date header falls back to the sync time.
    expect(stores.raws[3]?.observedAt).toMatch(/^2026-02-01T/);

    // The newsletter's PDF was never downloaded or stored.
    expect(client.commands).not.toContain(`UID FETCH ${NEWSLETTER_MESSAGE.uid} BODY[2]`);
    expect(stores.raws.some((r) => r.externalId?.includes("newsletter"))).toBe(false);
    // Skipped parts of the photo message were not downloaded either.
    expect(client.commands).not.toContain(`UID FETCH ${PHOTO_MESSAGE.uid} BODY[1.2]`);
    expect(client.commands).not.toContain(`UID FETCH ${PHOTO_MESSAGE.uid} BODY[3]`);
  });

  it("writes the raw record after the documents so a partial failure is retried, not hidden", async () => {
    const stores = createStores();
    const order: string[] = [];
    const rawStore: EmailRawRecordStore = {
      ...stores.rawStore,
      append: async (record) => {
        order.push("raw");
        await stores.rawStore.append(record);
      },
    };
    const documentStore: EmailDocumentStore = {
      ...stores.documentStore,
      save: async (document) => {
        order.push("document");
        return stores.documentStore.save(document);
      },
    };
    await runEmailSync({
      ...base,
      ...stores,
      rawStore,
      documentStore,
      client: inboxClient({}, { uidValidity: UID_VALIDITY, messages: [INVOICE_MESSAGE] }),
    });
    expect(order).toEqual(["document", "raw"]);
  });

  it("is idempotent: a second run ingests nothing new and only queries past the cursor", async () => {
    const stores = createStores();
    const client = inboxClient();
    await sync(stores, client);
    const rawCount = stores.raws.length;
    const docCount = stores.documents.length;

    const commandsBefore = client.commands.length;
    const second = await sync(stores, client);

    expect(second.messagesSeen).toBe(0);
    expect(second.messagesIngested).toBe(0);
    expect(second.cursor).toMatchObject({
      folder: "INBOX",
      uidValidity: UID_VALIDITY,
      lastUid: 105,
    });
    expect(stores.raws).toHaveLength(rawCount);
    expect(stores.documents).toHaveLength(docCount);
    expect(client.commands.slice(commandsBefore)).toEqual([
      "CONNECT",
      "EXAMINE INBOX",
      "UID SEARCH UID 106:*",
      "LOGOUT",
    ]);
  });

  it("dedupes by message-id when the cursor is lost or UIDVALIDITY changes", async () => {
    const stores = createStores();
    await sync(stores, inboxClient());
    const rawCount = stores.raws.length;
    const docCount = stores.documents.length;

    // Same messages, renumbered folder: the old UID cursor is invalid.
    const renumbered: FakeFolder = {
      uidValidity: "1720000000",
      messages: INBOX_FIXTURE.messages.map((m, i) => ({
        ...m,
        uid: 1 + i,
        uidValidity: "1720000000",
      })),
    };
    const summary = await sync(stores, inboxClient({}, renumbered));

    expect(summary.cursorReset).toBe("uid_validity_changed");
    expect(summary.messagesSeen).toBe(5);
    expect(summary.messagesSkippedNotAllowlisted).toBe(1);
    // Three messages carry a Message-ID and are skipped without download; the
    // scan without one gets a new UID identity, so it is re-processed but its
    // bytes dedupe at the document level.
    expect(summary.messagesSkippedDuplicate).toBe(3);
    expect(summary.messagesIngested).toBe(1);
    expect(summary.attachmentsStored).toBe(0);
    expect(summary.attachmentsDeduplicated).toBe(1);
    expect(stores.documents).toHaveLength(docCount);
    expect(stores.raws).toHaveLength(rawCount + 1);
    expect(summary.cursor).toMatchObject({
      folder: "INBOX",
      uidValidity: "1720000000",
      lastUid: 5,
    });
  });

  it("counts non-allowlisted mail without storing anything, and accepts all when no allowlist", async () => {
    const stores = createStores();
    const strict = await sync(stores, inboxClient(), { allowedSenders: ["nobody.example"] });
    expect(strict.messagesSkippedNotAllowlisted).toBe(5);
    expect(strict.messagesIngested).toBe(0);
    expect(stores.raws).toHaveLength(0);
    expect(stores.documents).toHaveLength(0);
    expect(strict.cursor?.lastUid).toBe(105);

    const open = createStores();
    const summary = await sync(open, inboxClient(), {});
    expect(summary.messagesSkippedNotAllowlisted).toBe(0);
    expect(summary.messagesIngested).toBe(5);
  });

  it("does not record metadata for messages that yield no document", async () => {
    const stores = createStores();
    const summary = await sync(stores, inboxClient(), {
      allowedSenders: [...VENDOR_ALLOWLIST],
      allowedMimeTypes: ["image/jpeg"],
    });
    expect(summary.messagesWithoutDocuments).toBe(3);
    expect(summary.messagesIngested).toBe(1);
    expect(stores.raws.map((r) => r.externalId)).toEqual(["msgid:photo-1@shop.vendor.example"]);
  });

  it("bounds the first sync with initialSinceDate and ignores it once a cursor exists", async () => {
    const stores = createStores();
    const client = inboxClient();
    const policy: EmailSourcePolicy = {
      allowedSenders: [...VENDOR_ALLOWLIST],
      initialSinceDate: "2026-01-17T00:00:00.000Z",
    };
    const first = await sync(stores, client, policy);
    expect(first.messagesSeen).toBe(3);
    expect(client.commands).toContain("UID SEARCH UID 1:* SINCE 2026-01-17T00:00:00.000Z");

    const second = await sync(stores, client, policy);
    expect(client.commands.at(-2)).toBe("UID SEARCH UID 106:*");
    expect(second.messagesSeen).toBe(0);
  });

  it("pins the cursor at the first failed message but keeps ingesting newer mail", async () => {
    const stores = createStores();
    const client = inboxClient({ failAttachment: { uid: PHOTO_MESSAGE.uid, partId: "2" } });
    const summary = await sync(stores, client);

    expect(summary.errors).toEqual([
      { uid: 103, message: "Simulated download failure for UID 103 part 2" },
    ]);
    // Every message is still visited, so one poisoned message cannot block newer invoices.
    expect(summary.messagesSeen).toBe(5);
    expect(summary.messagesIngested).toBe(3);
    expect(summary.cursor).toMatchObject({
      folder: "INBOX",
      uidValidity: UID_VALIDITY,
      lastUid: 102,
    });
    expect(stores.raws.map((r) => r.externalId)).toEqual([
      "msgid:invoice-2026-0042@billing.vendor.example",
      "msgid:fwd-1@vendor.example",
      "uid:INBOX:1710000000:105",
    ]);
    expect(stores.documents).toHaveLength(2);

    const finish = stores.runEvents.find((e) => e.kind === "finish");
    expect(finish?.payload).toMatchObject({
      status: "completed_with_errors",
      summary: { cursor: { lastUid: 102 } },
    });
    expect(stores.runEvents.filter((e) => e.kind === "error")).toHaveLength(1);
    expect(client.commands.at(-1)).toBe("LOGOUT");

    // The retry resumes at the failed message; the already-ingested newer
    // messages are recognised by identity and not downloaded again.
    const retryClient = inboxClient();
    const retry = await sync(stores, retryClient);
    expect(retry.errors).toEqual([]);
    expect(retry.messagesSeen).toBe(3);
    expect(retry.messagesIngested).toBe(1);
    expect(retry.messagesSkippedDuplicate).toBe(2);
    expect(retry.cursor?.lastUid).toBe(105);
    expect(stores.documents).toHaveLength(3);
    expect(retryClient.commands.filter((c) => c.includes("BODY["))).toEqual([
      "UID FETCH 103 BODY[2]",
    ]);
  });

  it("skips attachments whose bytes do not match the declared type and stores nothing", async () => {
    const stores = createStores();
    const spoofed: FakeFolder = {
      uidValidity: UID_VALIDITY,
      messages: [
        {
          ...INVOICE_MESSAGE,
          parts: { "2": new TextEncoder().encode("<html><script>alert(1)</script></html>") },
        },
      ],
    };
    const summary = await sync(stores, inboxClient({}, spoofed));

    expect(summary.errors).toEqual([]);
    expect(summary.attachmentsSkipped).toBe(1);
    expect(summary.attachmentsStored).toBe(0);
    expect(summary.messagesWithoutDocuments).toBe(1);
    expect(summary.messagesIngested).toBe(0);
    expect(summary.cursor?.lastUid).toBe(101);
    expect(stores.documents).toEqual([]);
    expect(stores.raws).toEqual([]);
  });

  it("keeps the run terminal even when recording an error fails", async () => {
    const stores = createStores();
    const runStore: EmailSyncRunStore = {
      ...stores.runStore,
      recordError: async () => {
        throw new Error("sync run store unavailable");
      },
    };
    const summary = await runEmailSync({
      ...base,
      ...stores,
      runStore,
      client: inboxClient({ failAttachment: { uid: PHOTO_MESSAGE.uid, partId: "2" } }),
    });

    expect(summary.errors.map((e) => e.message)).toEqual([
      "Simulated download failure for UID 103 part 2",
      "recording the error failed: sync run store unavailable",
    ]);
    expect(stores.runEvents.find((e) => e.kind === "finish")?.payload).toMatchObject({
      status: "completed_with_errors",
    });
  });

  it("fails the run without a cursor when the mailbox cannot be opened", async () => {
    const stores = createStores();
    const client = inboxClient({
      connectError: new Error("AUTHENTICATIONFAILED for user@mailbox.test"),
    });

    await expect(sync(stores, client)).rejects.toThrow(/AUTHENTICATIONFAILED/);

    const finish = stores.runEvents.find((e) => e.kind === "finish");
    expect(finish?.payload).toMatchObject({ status: "failed", summary: { cursor: undefined } });
    const error = stores.runEvents.find((e) => e.kind === "error");
    expect(error?.payload).toMatchObject({
      uid: undefined,
      message: "AUTHENTICATIONFAILED for [email]",
    });
    expect(stores.cursors).toEqual([]);
    expect(client.commands).toEqual(["CONNECT"]);
  });

  it("keeps addresses and credentials out of run records and the summary", async () => {
    const stores = createStores();
    const leaky: ImapClient = {
      workspaceId: base.workspaceId,
      connect: async () => undefined,
      listFolders: async () => [],
      openFolder: async () => ({
        folder: "INBOX",
        uidValidity: UID_VALIDITY,
        uidNext: 200,
        messageCount: 1,
      }),
      fetchMessagesSince: async () => [INVOICE_MESSAGE],
      fetchAttachment: async () => {
        throw new Error("server said: NO for billing@vendor.example <billing@vendor.example>");
      },
      disconnect: async () => undefined,
    };
    const summary = await runEmailSync({ ...base, ...stores, client: leaky });

    const serialized = JSON.stringify({ summary, events: stores.runEvents });
    expect(serialized).not.toMatch(EMAIL_PATTERN);
    expect(summary.errors[0]?.message).toBe("server said: NO for [email] <[email]>");
  });

  it("issues only read-only IMAP commands and the fake rejects any mutation", async () => {
    const stores = createStores();
    const client = inboxClient();
    await sync(stores, client, {});

    expect(client.mutatingCommands()).toEqual([]);
    for (const command of client.commands) {
      expect(command).toMatch(/^(CONNECT|LIST|EXAMINE |UID SEARCH |UID FETCH |LOGOUT)/);
    }

    await client.connect();
    await expect(client.setFlags(101, ["\\Seen"])).rejects.toBeInstanceOf(
      ImapReadOnlyViolationError,
    );
    await expect(client.moveMessage(101, "Archive")).rejects.toThrow(/MOVE must never be issued/);
    await expect(client.deleteMessage(101)).rejects.toThrow(/EXPUNGE/);
    await expect(client.copyMessage(101, "Archive")).rejects.toThrow(/COPY/);
    await expect(client.appendMessage("INBOX")).rejects.toThrow(/APPEND/);
    expect(client.mutatingCommands()).toHaveLength(5);
  });

  it("refuses a client bound to another workspace before touching any store", async () => {
    const stores = createStores();
    const foreign = inboxClient({ workspaceId: "ws_other" });
    await expect(sync(stores, foreign)).rejects.toThrow(/different workspace/);
    expect(stores.runEvents).toEqual([]);
    expect(foreign.commands).toEqual([]);
  });

  it("scans large folders in pages without changing the outcome", async () => {
    const stores = createStores();
    const client = inboxClient();
    const summary = await runEmailSync({
      ...base,
      ...stores,
      client,
      policy: { allowedSenders: [...VENDOR_ALLOWLIST] },
      batchSize: 2,
    });

    expect(summary).toMatchObject({
      messagesSeen: 5,
      messagesIngested: 4,
      attachmentsStored: 3,
      cursor: { lastUid: 105 },
      errors: [],
    });
    expect(client.commands.filter((c) => c.startsWith("UID SEARCH"))).toEqual([
      "UID SEARCH UID 1:*",
      "UID SEARCH UID 103:*",
      "UID SEARCH UID 105:*",
      "UID SEARCH UID 106:*",
    ]);
    // Paging keeps the cursor semantics: a failure in an earlier page still
    // pins the cursor while later pages are processed.
    const paged = createStores();
    const failing = inboxClient({ failAttachment: { uid: PHOTO_MESSAGE.uid, partId: "2" } });
    const pagedSummary = await runEmailSync({
      ...base,
      ...paged,
      client: failing,
      policy: { allowedSenders: [...VENDOR_ALLOWLIST] },
      batchSize: 2,
    });
    expect(pagedSummary.messagesSeen).toBe(5);
    expect(pagedSummary.cursor?.lastUid).toBe(102);
  });

  it("rescans from the start when the ingestion policy changes, deduplicating on the way", async () => {
    const stores = createStores();
    const client = inboxClient();
    await sync(stores, client, { allowedSenders: [...VENDOR_ALLOWLIST] });
    const documentsBefore = stores.documents.length;

    // Widening the allowlist must revisit the previously skipped newsletter.
    const widened = await sync(stores, client, {});
    expect(widened.cursorReset).toBe("policy_changed");
    expect(widened.messagesSeen).toBe(5);
    expect(widened.messagesSkippedDuplicate).toBe(4);
    expect(widened.messagesIngested).toBe(1);
    expect(stores.documents).toHaveLength(documentsBefore + 1);
    expect(stores.raws.map((r) => r.externalId)).toContain("msgid:newsletter-77@promo.other.test");

    // The same policy again reuses the cursor: nothing is rescanned.
    const steady = await sync(stores, client, {});
    expect(steady.cursorReset).toBeUndefined();
    expect(steady.messagesSeen).toBe(0);
  });

  it("re-checks the image size floor on the downloaded bytes when the size was not declared", async () => {
    const stores = createStores();
    const undeclaredImage: FakeFolder = {
      uidValidity: UID_VALIDITY,
      messages: [
        {
          ...PHOTO_MESSAGE,
          attachments: PHOTO_MESSAGE.attachments.map((a) => ({ ...a, size: undefined })),
          parts: { ...PHOTO_MESSAGE.parts, "2": SIGNATURE_LOGO },
        },
      ],
    };
    const summary = await sync(stores, inboxClient({}, undeclaredImage));

    expect(summary.errors).toEqual([]);
    expect(summary.attachmentsStored).toBe(0);
    expect(summary.messagesWithoutDocuments).toBe(1);
    expect(stores.documents).toEqual([]);
  });

  it("skips parts the server does not return instead of failing the message", async () => {
    const stores = createStores();
    const missingPart: FakeFolder = {
      uidValidity: UID_VALIDITY,
      messages: [{ ...INVOICE_MESSAGE, parts: {} }],
    };
    const summary = await sync(stores, inboxClient({}, missingPart));

    // Surfaced as an error (an advertised part vanished) without pinning the cursor.
    expect(summary.errors).toEqual([
      { uid: 101, message: "part 2 was not returned by the server; skipped" },
    ]);
    expect(summary.attachmentsSkipped).toBe(1);
    expect(summary.messagesWithoutDocuments).toBe(1);
    expect(summary.cursor?.lastUid).toBe(101);
    expect(stores.documents).toEqual([]);
    expect(stores.runEvents.at(-1)?.payload).toMatchObject({ status: "completed_with_errors" });
  });

  it("fetches only newly admitted parts of a recorded message and supersedes its raw record", async () => {
    const stores = createStores();
    const photoPart: EmailAttachmentPart = {
      partId: "3",
      filename: "IMG_0042.jpeg",
      mimeType: "image/jpeg",
      size: RECEIPT_PHOTO.byteLength,
      disposition: "attachment",
      contentId: undefined,
    };
    const mixed: FakeFolder = {
      uidValidity: UID_VALIDITY,
      messages: [
        {
          ...INVOICE_MESSAGE,
          attachments: [...INVOICE_MESSAGE.attachments, photoPart],
          parts: { ...INVOICE_MESSAGE.parts, "3": RECEIPT_PHOTO },
        },
      ],
    };
    const pdfOnly: EmailSourcePolicy = {
      allowedSenders: [...VENDOR_ALLOWLIST],
      allowedMimeTypes: ["application/pdf"],
    };
    const first = await sync(stores, inboxClient({}, mixed), pdfOnly);
    expect(first.attachmentsStored).toBe(1);
    expect(stores.raws).toHaveLength(1);

    // Widening to images must fetch the photo only, not the PDF again, and
    // append a superseding raw record that lists both attachments.
    const widenedPolicy: EmailSourcePolicy = {
      allowedSenders: [...VENDOR_ALLOWLIST],
      allowedMimeTypes: ["application/pdf", "image/jpeg"],
    };
    const widenedClient = inboxClient({}, mixed);
    const widened = await sync(stores, widenedClient, widenedPolicy);
    expect(widened.cursorReset).toBe("policy_changed");
    expect(widened.messagesIngested).toBe(1);
    expect(widened.messagesSkippedDuplicate).toBe(0);
    expect(widened.attachmentsStored).toBe(1);
    expect(widenedClient.commands.filter((c) => c.includes("BODY["))).toEqual([
      "UID FETCH 101 BODY[3]",
    ]);
    expect(stores.documents).toHaveLength(2);
    expect(stores.raws).toHaveLength(2);
    expect(stores.raws[1]?.supersedesRecordId).toBe(stores.raws[0]?.id);
    expect(stores.raws[1]?.payloadJson).toMatchObject({
      attachments: [
        { partId: "2", mimeType: "application/pdf" },
        { partId: "3", mimeType: "image/jpeg" },
      ],
    });

    // The same policy again sees nothing new; a rescan of it dedupes by identity.
    const steady = await sync(stores, inboxClient({}, mixed), widenedPolicy);
    expect(steady.messagesSeen).toBe(0);
  });

  it("drops its blob and counts a dedupe when a concurrent import saved the same content first", async () => {
    const stores = createStores();
    const putIds: string[] = [];
    const documentStorage: DocumentStorage = {
      put: async (input) => {
        putIds.push(input.id);
        return stores.documentStorage.put(input);
      },
      get: (input) => stores.documentStorage.get(input),
      delete: (input) => stores.documentStorage.delete(input),
    };
    let raced = false;
    const documentStore: EmailDocumentStore = {
      ...stores.documentStore,
      // Another writer inserts the same content between our hash lookup and save.
      save: async (document) => {
        if (!raced) {
          raced = true;
          await stores.documentStore.save({ ...document, id: "doc_from_other_writer" });
        }
        return stores.documentStore.save(document);
      },
    };
    const summary = await runEmailSync({
      ...base,
      ...stores,
      documentStore,
      documentStorage,
      client: inboxClient({}, { uidValidity: UID_VALIDITY, messages: [INVOICE_MESSAGE] }),
    });

    expect(summary.attachmentsStored).toBe(0);
    expect(summary.attachmentsDeduplicated).toBe(1);
    expect(summary.messagesIngested).toBe(1);
    expect(summary.errors).toEqual([]);
    expect(stores.documents.map((d) => d.id)).toEqual(["doc_from_other_writer"]);
    // Our own blob was removed because no row references it.
    expect(putIds).toHaveLength(1);
    await expect(
      stores.documentStorage.get({ context: { workspaceId: "ws_1" }, id: putIds[0] ?? "" }),
    ).rejects.toThrow(/not found/);
  });

  it("refuses to run without a valid workspace context", async () => {
    const stores = createStores();
    await expect(
      runEmailSync({
        ...base,
        workspaceId: " ",
        ...stores,
        client: inboxClient({ workspaceId: " " }),
      }),
    ).rejects.toThrow(/workspaceId/);
    expect(stores.runEvents).toEqual([]);
  });

  it("skips attachments declared above maxAttachmentBytes without ever downloading them", async () => {
    const stores = createStores();
    const client = inboxClient(
      {},
      { uidValidity: UID_VALIDITY, messages: [INVOICE_MESSAGE, FORWARDED_INVOICE_MESSAGE] },
    );
    const summary = await sync(stores, client, {
      allowedSenders: [...VENDOR_ALLOWLIST],
      maxAttachmentBytes: INVOICE_PDF.byteLength - 1,
    });

    expect(summary).toMatchObject({
      messagesSeen: 2,
      messagesIngested: 0,
      messagesWithoutDocuments: 2,
      attachmentsSkipped: 2,
      attachmentsStored: 0,
      attachmentsDeduplicated: 0,
      errors: [],
      cursor: { folder: "INBOX", uidValidity: UID_VALIDITY, lastUid: 104 },
    });
    expect(client.commands.filter((c) => c.includes("BODY["))).toEqual([]);
    expect(stores.raws).toEqual([]);
    expect(stores.documents).toEqual([]);
  });

  it("skips an over-cap attachment whose size was not declared instead of failing the message", async () => {
    const stores = createStores();
    const undeclared: FakeFolder = {
      uidValidity: UID_VALIDITY,
      messages: [
        {
          ...INVOICE_MESSAGE,
          attachments: INVOICE_MESSAGE.attachments.map((a) => ({ ...a, size: undefined })),
        },
      ],
    };
    const summary = await sync(stores, inboxClient({}, undeclared), {
      allowedSenders: [...VENDOR_ALLOWLIST],
      maxAttachmentBytes: INVOICE_PDF.byteLength - 1,
    });

    // The part can never be fetched under this policy, so it is counted as
    // skipped and the cursor moves on rather than retrying forever.
    expect(summary.errors).toEqual([]);
    expect(summary.attachmentsStored).toBe(0);
    expect(summary.attachmentsSkipped).toBe(1);
    expect(summary.messagesWithoutDocuments).toBe(1);
    expect(summary.cursor?.lastUid).toBe(101);
    expect(stores.documents).toEqual([]);
    expect(stores.raws).toEqual([]);
  });

  it("leaves no raw record or cursor advance when the document row cannot be saved, then recovers", async () => {
    const stores = createStores();
    let failNextSave = true;
    const documentStore: EmailDocumentStore = {
      ...stores.documentStore,
      save: async (document) => {
        if (failNextSave) {
          failNextSave = false;
          throw new Error("documents table is locked");
        }
        return stores.documentStore.save(document);
      },
    };
    const folder: FakeFolder = {
      uidValidity: UID_VALIDITY,
      messages: [INVOICE_MESSAGE, FORWARDED_INVOICE_MESSAGE],
    };
    const policy: EmailSourcePolicy = { allowedSenders: [...VENDOR_ALLOWLIST] };

    const first = await runEmailSync({
      ...base,
      ...stores,
      documentStore,
      client: inboxClient({}, folder),
      policy,
    });
    expect(first.errors).toEqual([
      { uid: 101, message: "storing part 2 of UID 101 failed: documents table is locked" },
    ]);
    // The failed message leaves nothing behind; the forwarded copy after it is
    // still ingested, but the cursor stays pinned before the failure.
    expect(first.messagesSeen).toBe(2);
    expect(first.messagesIngested).toBe(1);
    expect(first.attachmentsStored).toBe(1);
    expect(first.cursor).toMatchObject({ folder: "INBOX", uidValidity: UID_VALIDITY, lastUid: 0 });
    expect(stores.raws.map((r) => r.externalId)).toEqual(["msgid:fwd-1@vendor.example"]);
    expect(stores.documents).toHaveLength(1);

    const retryClient = inboxClient({}, folder);
    const retry = await runEmailSync({
      ...base,
      ...stores,
      documentStore,
      client: retryClient,
      policy,
    });
    expect(retry.errors).toEqual([]);
    expect(retry.messagesSeen).toBe(2);
    expect(retry.messagesIngested).toBe(1);
    expect(retry.messagesSkippedDuplicate).toBe(1);
    // The failed message is downloaded again and dedupes on content against the
    // forwarded copy stored in the first run.
    expect(retryClient.commands.filter((c) => c.includes("BODY["))).toEqual([
      "UID FETCH 101 BODY[2]",
    ]);
    expect(retry.attachmentsStored).toBe(0);
    expect(retry.attachmentsDeduplicated).toBe(1);
    expect(retry.cursor?.lastUid).toBe(104);
    expect(stores.documents).toHaveLength(1);
    expect(stores.raws.map((r) => r.externalId)).toEqual([
      "msgid:fwd-1@vendor.example",
      "msgid:invoice-2026-0042@billing.vendor.example",
    ]);
  });

  it("keeps cursors per folder and reports the same cursor to the run store and the caller", async () => {
    const stores = createStores();
    const client = new FakeImapClient({
      workspaceId: base.workspaceId,
      folders: {
        INBOX: INBOX_FIXTURE,
        Invoices: {
          uidValidity: "1730000000",
          messages: [
            {
              ...INVOICE_MESSAGE,
              folder: "Invoices",
              uid: 7,
              uidValidity: "1730000000",
              messageId: "<invoices-folder-1@billing.vendor.example>",
            },
          ],
        },
      },
    });
    await sync(stores, client);
    const commandsBefore = client.commands.length;

    const invoices = await sync(stores, client, {
      allowedSenders: [...VENDOR_ALLOWLIST],
      folder: "Invoices",
    });

    // The INBOX cursor (lastUid 105) must not be applied to another folder.
    expect(client.commands.slice(commandsBefore, commandsBefore + 3)).toEqual([
      "CONNECT",
      "EXAMINE Invoices",
      "UID SEARCH UID 1:*",
    ]);
    expect(invoices).toMatchObject({
      cursorReset: undefined,
      messagesSeen: 1,
      messagesIngested: 1,
      attachmentsStored: 0,
      attachmentsDeduplicated: 1,
      cursor: { folder: "Invoices", uidValidity: "1730000000", lastUid: 7 },
    });
    expect(await stores.runStore.latestCursor({ ...base, folder: "INBOX" })).toMatchObject({
      folder: "INBOX",
      uidValidity: UID_VALIDITY,
      lastUid: 105,
    });

    const finish = stores.runEvents.filter((e) => e.kind === "finish").at(-1);
    expect(finish?.payload).toMatchObject({
      runId: invoices.runId,
      status: "succeeded",
      summary: invoices,
    });
  });

  it("records the run start before connecting and logs out when the search fails", async () => {
    const stores = createStores();
    const order: string[] = [];
    const runStore: EmailSyncRunStore = {
      ...stores.runStore,
      start: async (run) => {
        order.push("start");
        await stores.runStore.start(run);
      },
    };
    const inner = inboxClient();
    const client: ImapClient = {
      workspaceId: base.workspaceId,
      connect: async () => {
        order.push("connect");
        await inner.connect();
      },
      listFolders: () => inner.listFolders(),
      openFolder: (folder) => inner.openFolder(folder),
      fetchMessagesSince: async () => {
        throw new Error("BAD [SERVERBUG] search rejected for user@mailbox.test");
      },
      fetchAttachment: (request) => inner.fetchAttachment(request),
      disconnect: () => inner.disconnect(),
    };

    await expect(runEmailSync({ ...base, ...stores, runStore, client })).rejects.toThrow(
      /SERVERBUG/,
    );

    expect(order).toEqual(["start", "connect"]);
    expect(inner.commands).toEqual(["CONNECT", "EXAMINE INBOX", "LOGOUT"]);
    expect(inner.connected).toBe(false);
    expect(stores.runEvents.map((e) => e.kind)).toEqual(["start", "error", "finish"]);
    expect(stores.runEvents[2]?.payload).toMatchObject({
      status: "failed",
      summary: {
        messagesSeen: 0,
        cursor: undefined,
        errors: [{ uid: undefined, message: "BAD [SERVERBUG] search rejected for [email]" }],
      },
    });
    expect(stores.cursors).toEqual([]);
  });

  it("fails and logs out when the configured folder does not exist", async () => {
    const stores = createStores();
    const client = inboxClient();
    await expect(sync(stores, client, { folder: "Missing" })).rejects.toThrow(
      /Mailbox does not exist: Missing/,
    );
    expect(client.commands).toEqual(["CONNECT", "EXAMINE Missing", "LOGOUT"]);
    expect(stores.runEvents.at(-1)?.payload).toMatchObject({
      status: "failed",
      summary: { errors: [{ uid: undefined }] },
    });
  });

  it("keeps addresses out of the summary and run records on the happy path too", async () => {
    const stores = createStores();
    await sync(stores, inboxClient(), {});
    // The raw vault legitimately holds sender addresses; the run/summary side must not.
    expect(stores.raws.some((r) => JSON.stringify(r.payloadJson).match(EMAIL_PATTERN))).toBe(true);
    expect(JSON.stringify({ events: stores.runEvents })).not.toMatch(EMAIL_PATTERN);
    const finish = stores.runEvents.find((e) => e.kind === "finish");
    expect(JSON.stringify(finish?.payload)).not.toMatch(/Rechnung|Quittung|Scan|\.pdf|\.jpeg/);
  });

  it("uses the message's UID and part id for the filename when the part has none", async () => {
    const stores = createStores();
    const unnamed: FakeFolder = {
      uidValidity: UID_VALIDITY,
      messages: [
        {
          ...NO_MESSAGE_ID_MESSAGE,
          attachments: NO_MESSAGE_ID_MESSAGE.attachments.map((a) => ({
            ...a,
            filename: undefined,
          })),
        },
      ],
    };
    await sync(stores, inboxClient({}, unnamed));
    expect(stores.documents[0]?.originalFilename).toBe("email-105-part-2.pdf");
    expect(stores.raws[0]?.payloadJson).toMatchObject({
      attachments: [{ partId: "2", mimeType: "application/pdf" }],
    });
  });

  it("keeps page-1 progress and finishes with errors when a later page cannot be fetched", async () => {
    const stores = createStores();
    const inner = inboxClient();
    let searches = 0;
    const client: ImapClient = {
      workspaceId: base.workspaceId,
      connect: () => inner.connect(),
      listFolders: () => inner.listFolders(),
      openFolder: (folder) => inner.openFolder(folder),
      fetchMessagesSince: async (request) => {
        searches += 1;
        if (searches === 2) {
          throw new Error("NO [UNAVAILABLE] search failed for user@mailbox.test");
        }
        return inner.fetchMessagesSince(request);
      },
      fetchAttachment: (request) => inner.fetchAttachment(request),
      disconnect: () => inner.disconnect(),
    };

    const summary = await runEmailSync({
      ...base,
      ...stores,
      client,
      policy: { allowedSenders: [...VENDOR_ALLOWLIST] },
      batchSize: 2,
    });

    // Page 1 (UIDs 101, 102) was processed; the failed page stops the scan.
    expect(summary).toMatchObject({
      messagesSeen: 2,
      messagesIngested: 1,
      messagesSkippedNotAllowlisted: 1,
      cursor: { folder: "INBOX", uidValidity: UID_VALIDITY, lastUid: 102 },
      errors: [{ uid: undefined, message: "NO [UNAVAILABLE] search failed for [email]" }],
    });
    expect(searches).toBe(2);
    expect(inner.commands.filter((c) => c.startsWith("UID SEARCH"))).toEqual([
      "UID SEARCH UID 1:*",
    ]);
    expect(inner.commands.at(-1)).toBe("LOGOUT");
    expect(inner.connected).toBe(false);

    const finish = stores.runEvents.filter((e) => e.kind === "finish").at(-1);
    expect(finish?.payload).toMatchObject({
      runId: summary.runId,
      status: "completed_with_errors",
      summary: { cursor: { lastUid: 102 } },
    });
    expect(stores.runEvents.map((e) => e.kind)).toEqual(["start", "error", "finish"]);
    expect(stores.cursors).toEqual([summary.cursor]);
    expect(JSON.stringify(stores.runEvents)).not.toMatch(EMAIL_PATTERN);

    // The next run resumes from the pinned cursor and picks up the rest.
    const resumed = await sync(stores, inner);
    expect(inner.commands.filter((c) => c.startsWith("UID SEARCH")).slice(-2)).toEqual([
      "UID SEARCH UID 103:*",
      "UID SEARCH UID 106:*",
    ]);
    expect(resumed).toMatchObject({
      messagesSeen: 3,
      messagesIngested: 3,
      cursor: { lastUid: 105 },
      errors: [],
    });
  });

  it("issues one trailing empty SEARCH when the page size exactly divides the message count", async () => {
    const stores = createStores();
    const client = inboxClient();
    const summary = await runEmailSync({
      ...base,
      ...stores,
      client,
      policy: { allowedSenders: [...VENDOR_ALLOWLIST] },
      batchSize: 5,
    });

    expect(summary).toMatchObject({
      messagesSeen: 5,
      messagesIngested: 4,
      cursor: { lastUid: 105 },
      errors: [],
    });
    // A full page cannot prove the folder is exhausted, so one more (empty) page is fetched.
    expect(client.commands.filter((c) => c.startsWith("UID SEARCH"))).toEqual([
      "UID SEARCH UID 1:*",
      "UID SEARCH UID 106:*",
    ]);
    expect(client.commands.filter((c) => c.includes("(ENVELOPE BODYSTRUCTURE)"))).toHaveLength(1);
    expect(client.commands.at(-1)).toBe("LOGOUT");
  });

  it("passes initialSinceDate to every page of the first scan", async () => {
    const stores = createStores();
    const client = inboxClient();
    const since = "2026-01-15T00:00:00.000Z";
    const summary = await runEmailSync({
      ...base,
      ...stores,
      client,
      policy: { allowedSenders: [...VENDOR_ALLOWLIST], initialSinceDate: since },
      batchSize: 2,
    });

    expect(summary.messagesSeen).toBe(5);
    expect(client.commands.filter((c) => c.startsWith("UID SEARCH"))).toEqual([
      `UID SEARCH UID 1:* SINCE ${since}`,
      `UID SEARCH UID 103:* SINCE ${since}`,
      `UID SEARCH UID 105:* SINCE ${since}`,
      `UID SEARCH UID 106:* SINCE ${since}`,
    ]);

    // Once a cursor exists, no page is date-bounded any more.
    await runEmailSync({
      ...base,
      ...stores,
      client,
      policy: { allowedSenders: [...VENDOR_ALLOWLIST], initialSinceDate: since },
      batchSize: 2,
    });
    expect(client.commands.filter((c) => c.startsWith("UID SEARCH")).slice(4)).toEqual([
      "UID SEARCH UID 106:*",
    ]);
  });

  it("reports uid_validity_changed when both UIDVALIDITY and the policy changed", async () => {
    const stores = createStores();
    await sync(stores, inboxClient(), { allowedSenders: [...VENDOR_ALLOWLIST] });
    const previous = stores.cursors.at(-1);
    expect(previous).toBeDefined();

    const renumbered: FakeFolder = {
      uidValidity: "1720000000",
      messages: INBOX_FIXTURE.messages.map((m, i) => ({
        ...m,
        uid: 1 + i,
        uidValidity: "1720000000",
      })),
    };
    // Widened allowlist (new policy hash) on a renumbered folder (new UIDVALIDITY).
    const summary = await sync(stores, inboxClient({}, renumbered), {});

    expect(summary.cursor?.policyHash).not.toBe(previous?.policyHash);
    expect(summary.cursor?.uidValidity).not.toBe(previous?.uidValidity);
    expect(summary.cursorReset).toBe("uid_validity_changed");
    expect(summary.messagesSeen).toBe(5);
    expect(summary.cursor).toMatchObject({ uidValidity: "1720000000", lastUid: 5 });

    // With UIDVALIDITY stable again, only the policy difference remains.
    const steady = await sync(stores, inboxClient({}, renumbered), {});
    expect(steady.cursorReset).toBeUndefined();
    expect(steady.messagesSeen).toBe(0);
    const narrowed = await sync(stores, inboxClient({}, renumbered), {
      allowedSenders: [...VENDOR_ALLOWLIST],
    });
    expect(narrowed.cursorReset).toBe("policy_changed");
    expect(narrowed.messagesSeen).toBe(5);
  });
});
