import { Readable } from "node:stream";
import { inspect } from "node:util";
import {
  createSecretValue,
  InMemorySecretStore,
  type SecretRef,
  type SecretStore,
} from "@sona/core";
import type {
  DownloadObject,
  FetchMessageObject,
  ImapFlowOptions,
  MessageStructureObject,
} from "imapflow";
import { describe, expect, it } from "vitest";
import { AttachmentUnavailableError, ImapClientError } from "./errors.js";
import {
  collectAttachmentParts,
  createImapFlowClient,
  type ImapConnectionSettings,
  type ImapFlowLike,
  summarizeFetchedMessage,
  toSequenceSet,
} from "./imap-client.js";

const USERNAME = "mailbox-user@mailbox.test";
const PASSWORD = "synthetic-app-password-1234";
const context = { workspaceId: "ws_1" } as const;

interface FlowScript {
  connectError?: Error;
  searchResult?: number[] | false;
  messages?: FetchMessageObject[];
  download?: Record<string, { content?: Buffer | null }>;
  logoutError?: Error;
}

interface FakeFlow {
  flow: ImapFlowLike;
  calls: string[];
  options: ImapFlowOptions;
}

function fakeFlow(options: ImapFlowOptions, script: FlowScript): FakeFlow {
  const calls: string[] = [];
  let mailbox: ImapFlowLike["mailbox"] = false;
  const flow: ImapFlowLike = {
    get mailbox() {
      return mailbox;
    },
    connect: async () => {
      calls.push("connect");
      if (script.connectError !== undefined) {
        throw script.connectError;
      }
    },
    logout: async () => {
      calls.push("logout");
      if (script.logoutError !== undefined) {
        throw script.logoutError;
      }
    },
    close: () => {
      calls.push("close");
    },
    list: async () => {
      calls.push("list");
      return [
        {
          path: "INBOX",
          pathAsListed: "INBOX",
          name: "INBOX",
          delimiter: "/",
          parent: [],
          parentPath: "",
          flags: new Set<string>(),
          specialUse: "\\Inbox",
          listed: true,
          subscribed: true,
        },
      ];
    },
    getMailboxLock: async (path, lockOptions) => {
      calls.push(`lock ${path} readOnly=${String(lockOptions?.readOnly)}`);
      mailbox = {
        path,
        delimiter: "/",
        flags: new Set<string>(),
        uidValidity: 1710000000n,
        uidNext: 106,
        exists: 5,
        readOnly: true,
      };
      return {
        path,
        release: () => {
          calls.push(`release ${path}`);
          mailbox = false;
        },
      };
    },
    search: async (query, searchOptions) => {
      calls.push(
        `search uid=${String(query.uid)} since=${query.since instanceof Date ? query.since.toISOString() : String(query.since)} byUid=${String(searchOptions?.uid)}`,
      );
      return script.searchResult ?? [];
    },
    fetchAll: async (range, query, fetchOptions) => {
      calls.push(
        `fetchAll ${range} ${Object.keys(query).sort().join(",")} byUid=${String(fetchOptions?.uid)}`,
      );
      return script.messages ?? [];
    },
    download: async (range, part, downloadOptions) => {
      calls.push(
        `download ${range} ${String(part)} byUid=${String(downloadOptions?.uid)} maxBytes=${String(downloadOptions?.maxBytes)}`,
      );
      const content = part === undefined ? undefined : script.download?.[part]?.content;
      // imapflow resolves `{}` (no meta/content) for parts it cannot find.
      return (
        content === undefined || content === null
          ? {}
          : { meta: {}, content: Readable.from([content]) }
      ) as DownloadObject;
    },
  };
  return { flow, calls, options };
}

async function harness(script: FlowScript = {}, connection: Partial<ImapConnectionSettings> = {}) {
  const secrets = new InMemorySecretStore();
  const passwordSecret: SecretRef = await secrets.putSecret({
    context,
    label: "imap-password",
    value: createSecretValue(PASSWORD),
  });
  let fake: FakeFlow | undefined;
  let getSecretCalls = 0;
  const countingSecrets: SecretStore = {
    putSecret: (input) => secrets.putSecret(input),
    getSecret: async (input) => {
      getSecretCalls += 1;
      return secrets.getSecret(input);
    },
    rotateSecret: (input) => secrets.rotateSecret(input),
    listSecrets: (input) => secrets.listSecrets(input),
  };
  const client = createImapFlowClient({
    connection: {
      host: "imap.mailbox.test",
      username: USERNAME,
      passwordSecret,
      ...connection,
    },
    secrets: countingSecrets,
    context,
    createImapFlow: (options) => {
      fake = fakeFlow(options, script);
      return fake.flow;
    },
  });
  return {
    client,
    get fake(): FakeFlow {
      if (fake === undefined) {
        throw new Error("flow not created yet");
      }
      return fake;
    },
    get getSecretCalls(): number {
      return getSecretCalls;
    },
  };
}

const message = (overrides: Partial<FetchMessageObject> = {}): FetchMessageObject => ({
  seq: 1,
  uid: 101,
  envelope: {
    date: new Date("2026-01-15T09:30:00Z"),
    subject: "Ihre Rechnung",
    messageId: "<invoice-1@vendor.example>",
    from: [{ name: " Vendor Billing ", address: "Billing@Vendor.Example" }],
    to: [{ address: USERNAME }],
  },
  bodyStructure: {
    type: "multipart/mixed",
    childNodes: [
      { part: "1", type: "text/plain", size: 120 },
      {
        part: "2",
        type: "APPLICATION/PDF",
        size: 4321,
        disposition: "ATTACHMENT",
        dispositionParameters: { filename: "Rechnung.pdf" },
      },
    ],
  },
  ...overrides,
});

describe("createImapFlowClient", () => {
  it("resolves the password from the secret store only at connect time and never logs", async () => {
    const h = await harness();
    await h.client.connect();

    expect(h.fake.options).toMatchObject({
      host: "imap.mailbox.test",
      port: 993,
      secure: true,
      logger: false,
      disableAutoIdle: true,
      auth: { user: USERNAME, pass: PASSWORD },
    });
    expect(h.fake.calls).toEqual(["connect"]);
    // Nothing enumerable on the client object carries the credential.
    expect(inspect(h.client)).not.toContain(PASSWORD);
    expect(JSON.stringify(h.client)).not.toContain(PASSWORD);
  });

  it("redacts username, password, and addresses from connection errors and drops the cause", async () => {
    const h = await harness({
      connectError: Object.assign(
        new Error(`Invalid credentials for ${USERNAME} with password ${PASSWORD}`),
        { code: "AUTHENTICATIONFAILED" },
      ),
    });
    const error = await h.client.connect().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ImapClientError);
    const clientError = error as ImapClientError;
    expect(clientError.message).toBe(
      "IMAP connect failed: Invalid credentials for [redacted] with password [redacted]",
    );
    expect(clientError.code).toBe("AUTHENTICATIONFAILED");
    expect(clientError.operation).toBe("connect");
    expect(clientError.cause).toBeUndefined();
    expect(inspect(clientError)).not.toContain(PASSWORD);
    expect(inspect(clientError)).not.toContain(USERNAME);
    // The half-open socket is closed.
    expect(h.fake.calls).toEqual(["connect", "close"]);
  });

  it("opens folders read-only and reports UIDVALIDITY as a string", async () => {
    const h = await harness();
    await h.client.connect();
    const opened = await h.client.openFolder("INBOX");

    expect(opened).toEqual({
      folder: "INBOX",
      uidValidity: "1710000000",
      uidNext: 106,
      messageCount: 5,
    });
    expect(h.fake.calls).toContain("lock INBOX readOnly=true");
    expect(await h.client.listFolders()).toEqual([{ path: "INBOX", specialUse: "\\Inbox" }]);
  });

  it("searches past the cursor, filters the `n:*` edge case, and fetches envelopes only", async () => {
    const h = await harness({
      searchResult: [105, 101, 103, 50],
      messages: [message(), message({ uid: 50 })],
    });
    await h.client.connect();
    await h.client.openFolder("INBOX");

    const messages = await h.client.fetchMessagesSince({
      folder: "INBOX",
      sinceUid: 100,
      sinceDate: "2026-01-01",
    });

    expect(h.fake.calls).toContain("search uid=101:* since=2026-01-01T00:00:00.000Z byUid=true");
    expect(h.fake.calls).toContain(
      "fetchAll 101,103,105 bodyStructure,envelope,internalDate,uid byUid=true",
    );
    // UID 50 (returned because `*` always matches the last message) is dropped.
    expect(messages.map((m) => m.uid)).toEqual([101]);
    expect(messages[0]).toEqual({
      folder: "INBOX",
      uid: 101,
      uidValidity: "1710000000",
      messageId: "<invoice-1@vendor.example>",
      subject: "Ihre Rechnung",
      date: "2026-01-15T09:30:00.000Z",
      from: { name: "Vendor Billing", address: "billing@vendor.example" },
      attachments: [
        {
          partId: "2",
          filename: "Rechnung.pdf",
          mimeType: "application/pdf",
          size: 4321,
          disposition: "attachment",
          contentId: undefined,
        },
      ],
    });
    // No body, source, or header fetch was requested.
    expect(h.fake.calls.some((c) => /source|bodyParts|headers/.test(c))).toBe(false);
  });

  it("skips the FETCH entirely when nothing is past the cursor", async () => {
    const h = await harness({ searchResult: [100] });
    await h.client.connect();
    await h.client.openFolder("INBOX");
    expect(await h.client.fetchMessagesSince({ folder: "INBOX", sinceUid: 100 })).toEqual([]);
    expect(h.fake.calls.some((c) => c.startsWith("fetchAll"))).toBe(false);
  });

  it("refuses to fetch from a folder that is not open", async () => {
    const h = await harness();
    await h.client.connect();
    await expect(h.client.fetchMessagesSince({ folder: "Archive", sinceUid: 0 })).rejects.toThrow(
      /folder is not open/,
    );
    await expect(
      h.client.fetchAttachment({ folder: "INBOX", uid: 1, partId: "2", maxBytes: 10 }),
    ).rejects.toThrow(/folder is not open/);
  });

  it("downloads single parts by UID with a byte cap", async () => {
    const bytes = Buffer.from("%PDF-1.4 synthetic");
    const h = await harness({ download: { "2": { content: bytes } } });
    await h.client.connect();
    await h.client.openFolder("INBOX");

    const result = await h.client.fetchAttachment({
      folder: "INBOX",
      uid: 101,
      partId: "2",
      maxBytes: 1024,
    });
    expect(Buffer.from(result).equals(bytes)).toBe(true);
    expect(h.fake.calls).toContain("download 101 2 byUid=true maxBytes=1025");

    await expect(
      h.client.fetchAttachment({ folder: "INBOX", uid: 101, partId: "2", maxBytes: 4 }),
    ).rejects.toThrow(/exceeds 4 bytes/);
    await expect(
      h.client.fetchAttachment({ folder: "INBOX", uid: 101, partId: "9", maxBytes: 1024 }),
    ).rejects.toThrow(/part 9 of UID 101 was not returned/);
  });

  it("releases the lock and logs out on disconnect, closing the socket if LOGOUT fails", async () => {
    const h = await harness({ logoutError: new Error("connection reset") });
    await h.client.connect();
    await h.client.openFolder("INBOX");
    await h.client.disconnect();

    expect(h.fake.calls.slice(-3)).toEqual(["release INBOX", "logout", "close"]);
    await expect(h.client.listFolders()).rejects.toThrow(/not connected/);
    // Disconnecting twice is harmless.
    await expect(h.client.disconnect()).resolves.toBeUndefined();
  });

  it("wraps server errors from every operation as redacted ImapClientErrors", async () => {
    const h = await harness();
    await h.client.connect();
    await h.client.openFolder("INBOX");
    h.fake.flow.search = async () => {
      throw new Error(`Command failed for ${USERNAME}`);
    };
    await expect(h.client.fetchMessagesSince({ folder: "INBOX", sinceUid: 0 })).rejects.toThrow(
      "IMAP fetch failed: Command failed for [redacted]",
    );
  });

  it("requires a STARTTLS upgrade when implicit TLS is disabled", async () => {
    const h = await harness({}, { secure: false, port: 143 });
    await h.client.connect();
    expect(h.fake.options).toMatchObject({ secure: false, port: 143, doSTARTTLS: true });

    const implicit = await harness();
    await implicit.client.connect();
    expect(implicit.fake.options).not.toHaveProperty("doSTARTTLS");
  });
});

describe("createImapFlowClient lifecycle", () => {
  it("reads the secret once: a repeated connect() is a no-op, a failed one is retried", async () => {
    const h = await harness();
    await h.client.connect();
    await h.client.connect();
    expect(h.getSecretCalls).toBe(1);
    expect(h.fake.calls).toEqual(["connect"]);

    const failing = await harness({ connectError: new Error("greeting timeout") });
    await expect(failing.client.connect()).rejects.toThrow(/greeting timeout/);
    await expect(failing.client.connect()).rejects.toThrow(/greeting timeout/);
    // Each attempt builds a fresh connection and resolves the credential again.
    expect(failing.getSecretCalls).toBe(2);
    expect(failing.fake.calls).toEqual(["connect", "close"]);
  });

  it("releases the previous folder lock before opening another folder", async () => {
    const h = await harness();
    await h.client.connect();
    await h.client.openFolder("INBOX");
    const archive = await h.client.openFolder("Archive");

    expect(archive.folder).toBe("Archive");
    expect(h.fake.calls).toEqual([
      "connect",
      "lock INBOX readOnly=true",
      "release INBOX",
      "lock Archive readOnly=true",
    ]);
    await expect(h.client.fetchMessagesSince({ folder: "INBOX", sinceUid: 0 })).rejects.toThrow(
      /folder is not open/,
    );
    expect(await h.client.fetchMessagesSince({ folder: "Archive", sinceUid: 0 })).toEqual([]);

    await h.client.disconnect();
    expect(h.fake.calls.filter((c) => c.startsWith("release"))).toEqual([
      "release INBOX",
      "release Archive",
    ]);
    expect(h.fake.calls.at(-1)).toBe("logout");
  });

  it("releases a lock acquired for a mailbox that did not open", async () => {
    const h = await harness();
    await h.client.connect();
    h.fake.flow.getMailboxLock = async (path) => ({
      path,
      release: () => {
        h.fake.calls.push(`release-dangling ${path}`);
      },
    });
    await expect(h.client.openFolder("INBOX")).rejects.toThrow(
      "IMAP examine failed: mailbox did not open",
    );
    await expect(h.client.fetchMessagesSince({ folder: "INBOX", sinceUid: 0 })).rejects.toThrow(
      /folder is not open/,
    );
    await h.client.disconnect();
    expect(h.fake.calls).toContain("release-dangling INBOX");
  });

  it("treats a `false` search result as a failed command, not an empty mailbox", async () => {
    const h = await harness({ searchResult: false });
    await h.client.connect();
    await h.client.openFolder("INBOX");
    // imapflow swallows SEARCH errors and resolves `false`; reporting that as
    // "nothing new" would mark a broken sync as succeeded.
    await expect(h.client.fetchMessagesSince({ folder: "INBOX", sinceUid: 0 })).rejects.toThrow(
      "IMAP fetch failed: UID SEARCH failed",
    );
    expect(h.fake.calls.some((c) => c.startsWith("fetchAll"))).toBe(false);
  });

  it("treats an empty download after the mailbox closed as transient, not as a missing part", async () => {
    const h = await harness();
    await h.client.connect();
    await h.client.openFolder("INBOX");
    // imapflow resolves `{}` both for a missing part and once the connection
    // dropped; only the former may be skipped permanently.
    h.fake.flow.download = async () => ({}) as DownloadObject;
    Object.defineProperty(h.fake.flow, "mailbox", { value: false });

    const error = await h.client
      .fetchAttachment({ folder: "INBOX", uid: 101, partId: "2", maxBytes: 10 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImapClientError);
    expect(error).not.toBeInstanceOf(AttachmentUnavailableError);
    expect((error as ImapClientError).message).toContain("mailbox is no longer open");
  });

  it("reports a missing part as permanently unavailable while the mailbox is open", async () => {
    const h = await harness();
    await h.client.connect();
    await h.client.openFolder("INBOX");
    h.fake.flow.download = async () => ({}) as DownloadObject;

    const error = await h.client
      .fetchAttachment({ folder: "INBOX", uid: 101, partId: "2", maxBytes: 10 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AttachmentUnavailableError);
    expect((error as AttachmentUnavailableError).reason).toBe("part_unavailable");
    expect((error as AttachmentUnavailableError).code).toBe("PART_UNAVAILABLE");
  });

  it("does not double-wrap its own precondition errors and wraps server errors exactly once", async () => {
    const h = await harness();
    const notConnected = (await h.client.listFolders().catch((e: unknown) => e)) as ImapClientError;
    expect(notConnected).toBeInstanceOf(ImapClientError);
    expect(notConnected.message).toBe("IMAP list failed: not connected");
    expect(notConnected.operation).toBe("list");
    expect(notConnected.code).toBeUndefined();

    await h.client.connect();
    const notOpen = (await h.client
      .fetchAttachment({ folder: "INBOX", uid: 1, partId: "2", maxBytes: 1 })
      .catch((e: unknown) => e)) as ImapClientError;
    expect(notOpen.message).toBe("IMAP download failed: folder is not open");
    expect(notOpen.operation).toBe("download");

    await h.client.openFolder("INBOX");
    h.fake.flow.download = async () => {
      throw Object.assign(new Error(`NO [LIMIT] too large for ${USERNAME}`), { code: "LIMIT" });
    };
    const download = (await h.client
      .fetchAttachment({ folder: "INBOX", uid: 101, partId: "2", maxBytes: 10 })
      .catch((e: unknown) => e)) as ImapClientError;
    expect(download.message).toBe("IMAP download failed: NO [LIMIT] too large for [redacted]");
    expect(download.code).toBe("LIMIT");
    expect(download.cause).toBeUndefined();
  });

  it("is bound to the workspace of the context it was created with", async () => {
    const h = await harness();
    expect(h.client.workspaceId).toBe(context.workspaceId);
    await h.client.connect();
    expect(h.client.workspaceId).toBe("ws_1");
  });

  it("aborts a streamed download as soon as the chunks cross the cap and destroys the stream", async () => {
    const h = await harness();
    await h.client.connect();
    await h.client.openFolder("INBOX");
    let stream: Readable | undefined;
    let requestedMaxBytes: number | undefined;
    h.fake.flow.download = async (_range, _part, downloadOptions) => {
      requestedMaxBytes = downloadOptions?.maxBytes;
      stream = Readable.from([Buffer.from("%PDF-"), Buffer.from("1.4 "), Buffer.from("payload")]);
      return { meta: {}, content: stream } as DownloadObject;
    };

    // 5 + 4 = 9 bytes fit; the third chunk (7 bytes) would exceed 12.
    const error = (await h.client
      .fetchAttachment({ folder: "INBOX", uid: 101, partId: "2", maxBytes: 12 })
      .catch((e: unknown) => e)) as ImapClientError;
    expect(error).toBeInstanceOf(ImapClientError);
    expect(error.message).toBe("IMAP download failed: part 2 of UID 101 exceeds 12 bytes");
    expect(stream?.destroyed).toBe(true);
    // The library-side cap is one byte above ours so an over-cap part is detected, not truncated.
    expect(requestedMaxBytes).toBe(13);
  });

  it("concatenates a multi-chunk download that stays under the cap", async () => {
    const h = await harness();
    await h.client.connect();
    await h.client.openFolder("INBOX");
    let stream: Readable | undefined;
    h.fake.flow.download = async () => {
      // Mixed chunk types: imapflow may hand out Buffers or raw Uint8Arrays.
      stream = Readable.from([
        Buffer.from("%PDF-"),
        new Uint8Array([0x31, 0x2e, 0x34]),
        Buffer.from(" synthetic"),
      ]);
      return { meta: {}, content: stream } as DownloadObject;
    };

    const bytes = await h.client.fetchAttachment({
      folder: "INBOX",
      uid: 101,
      partId: "2",
      maxBytes: 18,
    });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(bytes).toString("latin1")).toBe("%PDF-1.4 synthetic");
    expect(bytes.byteLength).toBe(18);
    expect(stream?.destroyed).toBe(true);
  });

  it("fails clearly when the library resolves without content", async () => {
    const h = await harness({ download: { "2": { content: null } } });
    await h.client.connect();
    await h.client.openFolder("INBOX");
    await expect(
      h.client.fetchAttachment({ folder: "INBOX", uid: 101, partId: "2", maxBytes: 1024 }),
    ).rejects.toThrow("IMAP download failed: part 2 of UID 101 was not returned");
  });

  it("fetches only the lowest `limit` UIDs past the cursor", async () => {
    const h = await harness({
      searchResult: [105, 101, 104, 102, 103, 50],
      messages: [message({ uid: 101 }), message({ uid: 102 })],
    });
    await h.client.connect();
    await h.client.openFolder("INBOX");

    const page = await h.client.fetchMessagesSince({ folder: "INBOX", sinceUid: 100, limit: 2 });
    expect(page.map((m) => m.uid)).toEqual([101, 102]);
    expect(h.fake.calls.filter((c) => c.startsWith("fetchAll"))).toEqual([
      "fetchAll 101:102 bodyStructure,envelope,internalDate,uid byUid=true",
    ]);
  });

  it("skips the SEARCH when the cursor is already at or past UIDNEXT", async () => {
    const h = await harness({ searchResult: [105] });
    await h.client.connect();
    await h.client.openFolder("INBOX");
    // Fake mailbox reports UIDNEXT 106: nothing can exist past UID 105.
    expect(await h.client.fetchMessagesSince({ folder: "INBOX", sinceUid: 105 })).toEqual([]);
    expect(await h.client.fetchMessagesSince({ folder: "INBOX", sinceUid: 900 })).toEqual([]);
    expect(h.fake.calls.some((c) => c.startsWith("search"))).toBe(false);
    expect(h.fake.calls.some((c) => c.startsWith("fetchAll"))).toBe(false);

    // One below UIDNEXT still asks the server.
    expect((await h.client.fetchMessagesSince({ folder: "INBOX", sinceUid: 104 })).length).toBe(0);
    expect(h.fake.calls.filter((c) => c.startsWith("search"))).toEqual([
      "search uid=105:* since=undefined byUid=true",
    ]);
  });
});

describe("toSequenceSet", () => {
  it("compresses consecutive runs", () => {
    expect(toSequenceSet([])).toBe("");
    expect(toSequenceSet([5])).toBe("5");
    expect(toSequenceSet([1, 2, 3, 7, 9, 10])).toBe("1:3,7,9:10");
  });
});

describe("collectAttachmentParts", () => {
  it("returns non-text leaves and named text parts, with normalized fields", () => {
    const structure: MessageStructureObject = {
      type: "multipart/mixed",
      childNodes: [
        {
          type: "multipart/related",
          childNodes: [
            { part: "1.1", type: "text/html", size: 900 },
            {
              part: "1.2",
              type: "image/png",
              size: 3000,
              disposition: "inline",
              id: "<logo@vendor.example>",
              parameters: { name: "logo.png" },
            },
          ],
        },
        {
          part: "2",
          type: "text/plain",
          size: 20,
          dispositionParameters: { filename: "terms.txt" },
        },
        { part: "3", type: "application/octet-stream", size: 10 },
      ],
    };
    expect(collectAttachmentParts(structure)).toEqual([
      {
        partId: "1.2",
        filename: "logo.png",
        mimeType: "image/png",
        size: 3000,
        disposition: "inline",
        contentId: "logo@vendor.example",
      },
      {
        partId: "2",
        filename: "terms.txt",
        mimeType: "text/plain",
        size: 20,
        disposition: undefined,
        contentId: undefined,
      },
      {
        partId: "3",
        filename: undefined,
        mimeType: "application/octet-stream",
        size: 10,
        disposition: undefined,
        contentId: undefined,
      },
    ]);
  });

  it("descends into attached message/rfc822 parts and ignores empty containers", () => {
    const structure: MessageStructureObject = {
      type: "multipart/mixed",
      childNodes: [
        { part: "1", type: "text/plain", size: 10 },
        {
          part: "2",
          type: "message/rfc822",
          size: 9000,
          disposition: "attachment",
          dispositionParameters: { filename: "forwarded.eml" },
          childNodes: [
            { part: "2.1", type: "text/plain", size: 50 },
            {
              part: "2.2",
              type: "application/pdf",
              size: 8000,
              disposition: "attachment",
              dispositionParameters: { filename: "invoice.pdf" },
            },
          ],
        },
        { part: "3", type: "multipart/alternative", childNodes: [] },
        // A leaf the server did not number cannot be downloaded, so it is not reported.
        { type: "application/pdf", size: 5 },
      ],
    };
    expect(collectAttachmentParts(structure)).toEqual([
      {
        partId: "2.2",
        filename: "invoice.pdf",
        mimeType: "application/pdf",
        size: 8000,
        disposition: "attachment",
        contentId: undefined,
      },
    ]);
  });

  it("reports an opaque message/rfc822 leaf so the policy layer counts it as skipped", () => {
    expect(
      collectAttachmentParts({
        type: "multipart/mixed",
        childNodes: [{ part: "2", type: "MESSAGE/RFC822", size: 100 }],
      }),
    ).toEqual([
      {
        partId: "2",
        filename: undefined,
        mimeType: "message/rfc822",
        size: 100,
        disposition: undefined,
        contentId: undefined,
      },
    ]);
  });

  it("treats a single-part PDF message as part 1 and ignores bare text bodies", () => {
    expect(collectAttachmentParts({ type: "application/pdf", size: 5 })).toEqual([
      {
        partId: "1",
        filename: undefined,
        mimeType: "application/pdf",
        size: 5,
        disposition: undefined,
        contentId: undefined,
      },
    ]);
    expect(collectAttachmentParts({ type: "text/plain", size: 5 })).toEqual([]);
  });
});

describe("summarizeFetchedMessage", () => {
  it("falls back to the internal date and tolerates missing envelope data", () => {
    const summary = summarizeFetchedMessage(
      {
        seq: 1,
        uid: 7,
        internalDate: "2026-01-20T10:00:00Z",
        envelope: { from: [{ name: "No Address" }] },
      },
      "INBOX",
      "1",
    );
    expect(summary).toEqual({
      folder: "INBOX",
      uid: 7,
      uidValidity: "1",
      messageId: undefined,
      subject: undefined,
      date: "2026-01-20T10:00:00.000Z",
      from: undefined,
      attachments: [],
    });
  });

  it("uses the first sender entry that carries an address", () => {
    const summary = summarizeFetchedMessage(
      {
        seq: 1,
        uid: 9,
        envelope: {
          from: [{ name: "Group only" }, { address: "" }, { name: "  ", address: "A@B.Example" }],
        },
      },
      "INBOX",
      "1",
    );
    expect(summary.from).toEqual({ name: undefined, address: "a@b.example" });
  });

  it("drops unparseable dates instead of throwing", () => {
    const summary = summarizeFetchedMessage(
      { seq: 1, uid: 8, envelope: { date: "not a date" } },
      "INBOX",
      "1",
    );
    expect(summary.date).toBeUndefined();
  });
});
