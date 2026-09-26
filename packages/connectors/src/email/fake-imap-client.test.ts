import { describe, expect, it } from "vitest";
import { FakeImapClient } from "./fake-imap-client.js";
import { INBOX_FIXTURE, INVOICE_PDF, UID_VALIDITY } from "./fixtures.js";

function client(): FakeImapClient {
  return new FakeImapClient({
    workspaceId: "ws_1",
    folders: { INBOX: INBOX_FIXTURE, Empty: { uidValidity: "42", messages: [] } },
  });
}

describe("FakeImapClient", () => {
  it("requires a connection and the selected folder before serving reads", async () => {
    const fake = client();
    await expect(fake.listFolders()).rejects.toThrow(/not connected/);
    await expect(fake.openFolder("INBOX")).rejects.toThrow(/not connected/);
    await expect(fake.fetchMessagesSince({ folder: "INBOX", sinceUid: 0 })).rejects.toThrow(
      /not connected/,
    );

    await fake.connect();
    await expect(fake.fetchMessagesSince({ folder: "INBOX", sinceUid: 0 })).rejects.toThrow(
      "Folder INBOX is not selected",
    );
    await fake.openFolder("INBOX");
    await expect(fake.fetchMessagesSince({ folder: "Empty", sinceUid: 0 })).rejects.toThrow(
      "Folder Empty is not selected",
    );
    await expect(
      fake.fetchAttachment({ folder: "Empty", uid: 101, partId: "2", maxBytes: 10 }),
    ).rejects.toThrow("Folder Empty is not selected");

    // Disconnecting drops the selection as a real LOGOUT would.
    await fake.disconnect();
    expect(fake.connected).toBe(false);
    await expect(fake.fetchMessagesSince({ folder: "INBOX", sinceUid: 0 })).rejects.toThrow(
      /not connected/,
    );
    expect(fake.commands).toEqual(["CONNECT", "EXAMINE INBOX", "LOGOUT"]);
  });

  it("rejects unknown mailboxes and parts but still records the attempted command", async () => {
    const fake = client();
    await fake.connect();
    await expect(fake.openFolder("Nope")).rejects.toThrow("Mailbox does not exist: Nope");
    await fake.openFolder("INBOX");
    await expect(
      fake.fetchAttachment({ folder: "INBOX", uid: 101, partId: "9", maxBytes: 1024 }),
    ).rejects.toThrow("No such part 9 on UID 101");
    await expect(
      fake.fetchAttachment({ folder: "INBOX", uid: 999, partId: "2", maxBytes: 1024 }),
    ).rejects.toThrow("No such part 2 on UID 999");
    expect(fake.commands).toEqual([
      "CONNECT",
      "EXAMINE Nope",
      "EXAMINE INBOX",
      "UID FETCH 101 BODY[9]",
      "UID FETCH 999 BODY[2]",
    ]);
  });

  it("enforces the download byte cap and hands out copies of the stored bytes", async () => {
    const fake = client();
    await fake.connect();
    await fake.openFolder("INBOX");
    const request = { folder: "INBOX", uid: 101, partId: "2" };
    await expect(
      fake.fetchAttachment({ ...request, maxBytes: INVOICE_PDF.byteLength - 1 }),
    ).rejects.toThrow(`Part 2 on UID 101 exceeds ${INVOICE_PDF.byteLength - 1} bytes`);

    const bytes = await fake.fetchAttachment({ ...request, maxBytes: INVOICE_PDF.byteLength });
    expect(bytes).toEqual(INVOICE_PDF);
    bytes.fill(0);
    expect(await fake.fetchAttachment({ ...request, maxBytes: INVOICE_PDF.byteLength })).toEqual(
      INVOICE_PDF,
    );
  });

  it("lists folders with special-use flags and reports UIDNEXT and message counts", async () => {
    const fake = client();
    await fake.connect();
    expect(await fake.listFolders()).toEqual([
      { path: "INBOX", specialUse: "\\Inbox" },
      { path: "Empty", specialUse: undefined },
    ]);
    expect(await fake.openFolder("INBOX")).toEqual({
      folder: "INBOX",
      uidValidity: UID_VALIDITY,
      uidNext: 106,
      messageCount: 5,
    });
    expect(await fake.openFolder("Empty")).toEqual({
      folder: "Empty",
      uidValidity: "42",
      uidNext: 1,
      messageCount: 0,
    });
  });

  it("filters by UID and internal date, issuing a FETCH only when something matched", async () => {
    const fake = client();
    await fake.connect();
    await fake.openFolder("INBOX");

    const recent = await fake.fetchMessagesSince({
      folder: "INBOX",
      sinceUid: 0,
      sinceDate: "2026-01-18T00:00:00.000Z",
    });
    expect(recent.map((m) => m.uid)).toEqual([104, 105]);
    expect(fake.commands.slice(-2)).toEqual([
      "UID SEARCH UID 1:* SINCE 2026-01-18T00:00:00.000Z",
      "UID FETCH 104,105 (ENVELOPE BODYSTRUCTURE)",
    ]);

    expect(await fake.fetchMessagesSince({ folder: "INBOX", sinceUid: 105 })).toEqual([]);
    expect(fake.commands.at(-1)).toBe("UID SEARCH UID 106:*");

    // Summaries are envelope-only copies: no part bytes, and not the fixture objects.
    const [first] = await fake.fetchMessagesSince({ folder: "INBOX", sinceUid: 100 });
    expect(first).not.toHaveProperty("parts");
    expect(first).not.toHaveProperty("internalDate");
    expect(first?.attachments[0]).not.toBe(INBOX_FIXTURE.messages[0]?.attachments[0]);
  });

  it("pages by limit from the lowest UID and exposes its workspace", async () => {
    const fake = client();
    expect(fake.workspaceId).toBe("ws_1");
    await fake.connect();
    await fake.openFolder("INBOX");

    const firstPage = await fake.fetchMessagesSince({ folder: "INBOX", sinceUid: 0, limit: 2 });
    expect(firstPage.map((m) => m.uid)).toEqual([101, 102]);
    expect(fake.commands.slice(-2)).toEqual([
      "UID SEARCH UID 1:*",
      "UID FETCH 101,102 (ENVELOPE BODYSTRUCTURE)",
    ]);

    const secondPage = await fake.fetchMessagesSince({ folder: "INBOX", sinceUid: 102, limit: 2 });
    expect(secondPage.map((m) => m.uid)).toEqual([103, 104]);
    const lastPage = await fake.fetchMessagesSince({ folder: "INBOX", sinceUid: 104, limit: 2 });
    expect(lastPage.map((m) => m.uid)).toEqual([105]);

    // No limit returns everything; a limit larger than the folder is harmless.
    const all = await fake.fetchMessagesSince({ folder: "INBOX", sinceUid: 0 });
    expect(all.map((m) => m.uid)).toEqual([101, 102, 103, 104, 105]);
    const capped = await fake.fetchMessagesSince({ folder: "INBOX", sinceUid: 0, limit: 50 });
    expect(capped).toHaveLength(5);
  });

  it("records no LOGOUT when disconnecting without a connection", async () => {
    const fake = client();
    await fake.disconnect();
    expect(fake.commands).toEqual([]);
  });
});
