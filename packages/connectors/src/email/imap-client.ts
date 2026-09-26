/**
 * Real {@link ImapClient} backed by `imapflow`.
 *
 * - The mailbox password is resolved from the {@link SecretStore} inside
 *   `connect()` and handed straight to the IMAP library; it is never held on
 *   the client, logged, or placed in errors.
 * - Folders are opened read-only (IMAP `EXAMINE`), so even a library bug could
 *   not set flags or expunge.
 * - Only server-parsed envelopes and body structures are fetched, in pages;
 *   bodies are never read. The ENVELOPE does carry recipient lists on the
 *   wire; {@link summarizeFetchedMessage} keeps sender, subject, date, and
 *   Message-ID and discards the rest before anything is stored. Attachment
 *   parts are streamed individually and aborted past the byte cap.
 * - Every error is re-thrown as an {@link ImapClientError} with a redacted
 *   message (no addresses, no username, no password) and no `cause` chain, so
 *   nothing upstream can leak the raw server response by accident.
 */
import type { Readable } from "node:stream";
import type { SecretRef, SecretStore, WorkspaceContext } from "@sona/core";
import {
  type DownloadObject,
  type DownloadOptions,
  type FetchMessageObject,
  type FetchOptions,
  type FetchQueryObject,
  ImapFlow,
  type ImapFlowOptions,
  type ListResponse,
  type MailboxLockObject,
  type MailboxLockOptions,
  type MailboxObject,
  type MessageAddressObject,
  type MessageRangeOptions,
  type MessageStructureObject,
  type SearchObject,
} from "imapflow";
import { AttachmentUnavailableError, ImapClientError, type ImapOperation } from "./errors.js";
import { errorMessageRedacted } from "./normalize.js";
import type {
  AttachmentDisposition,
  EmailAddress,
  EmailAttachmentPart,
  EmailFolder,
  EmailMessageSummary,
  FetchAttachmentInput,
  FetchMessagesSinceInput,
  ImapClient,
  OpenedFolder,
} from "./types.js";

export interface ImapConnectionSettings {
  host: string;
  /** Default 993. */
  port?: number;
  /**
   * Implicit TLS. Default `true`. When `false`, the connection MUST upgrade via
   * STARTTLS before authenticating; servers without STARTTLS are refused so the
   * password is never sent in the clear.
   */
  secure?: boolean;
  username: string;
  /** Secret-store reference to the mailbox (app) password. */
  passwordSecret: SecretRef;
}

/** Subset of `imapflow`'s client that this adapter uses; tests substitute a fake. */
export interface ImapFlowLike {
  readonly mailbox: MailboxObject | false;
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
  list(): Promise<ListResponse[]>;
  getMailboxLock(path: string, options?: MailboxLockOptions): Promise<MailboxLockObject>;
  search(query: SearchObject, options?: MessageRangeOptions): Promise<number[] | false | undefined>;
  fetchAll(
    range: string,
    query: FetchQueryObject,
    options?: FetchOptions,
  ): Promise<FetchMessageObject[]>;
  download(range: string, part?: string, options?: DownloadOptions): Promise<DownloadObject>;
}

export type ImapFlowFactory = (options: ImapFlowOptions) => ImapFlowLike;

export interface ImapFlowClientInput {
  connection: ImapConnectionSettings;
  secrets: SecretStore;
  /** Workspace the credentials belong to; the client is bound to it. */
  context: WorkspaceContext;
  /** Injectable library factory; defaults to `new ImapFlow(options)`. */
  createImapFlow?: ImapFlowFactory;
  /** Connect/greeting budget in ms. Default 30s. */
  connectionTimeoutMs?: number;
}

const DEFAULT_PORT = 993;
const DEFAULT_CONNECTION_TIMEOUT_MS = 30_000;

const ENVELOPE_QUERY = {
  uid: true,
  envelope: true,
  bodyStructure: true,
  internalDate: true,
} as const satisfies FetchQueryObject;

const defaultFactory: ImapFlowFactory = (options) => new ImapFlow(options);

export function createImapFlowClient(input: ImapFlowClientInput): ImapClient {
  const { connection, secrets, context } = input;
  const createImapFlow = input.createImapFlow ?? defaultFactory;
  const redactions = [connection.username];

  let flow: ImapFlowLike | undefined;
  let lock: MailboxLockObject | undefined;
  let opened: OpenedFolder | undefined;

  function requireFlow(operation: ImapOperation): ImapFlowLike {
    if (flow === undefined) {
      throw new ImapClientError(operation, "not connected", undefined);
    }
    return flow;
  }

  function requireOpened(operation: ImapOperation, folder: string): OpenedFolder {
    if (opened === undefined || opened.folder !== folder) {
      throw new ImapClientError(operation, "folder is not open", undefined);
    }
    return opened;
  }

  async function guarded<T>(
    operation: ImapOperation,
    extraRedactions: readonly string[],
    action: () => Promise<T>,
  ): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof ImapClientError) {
        throw error;
      }
      throw new ImapClientError(
        operation,
        errorMessageRedacted(error, [...redactions, ...extraRedactions]),
        errorCode(error),
      );
    }
  }

  function releaseLock(): void {
    lock?.release();
    lock = undefined;
    opened = undefined;
  }

  return {
    workspaceId: context.workspaceId,

    async connect() {
      if (flow !== undefined) {
        return;
      }
      const password = await secrets.getSecret({ context, ref: connection.passwordSecret });
      const plaintext = password.reveal();
      const secure = connection.secure ?? true;
      const candidate = createImapFlow({
        host: connection.host,
        port: connection.port ?? DEFAULT_PORT,
        secure,
        // Without implicit TLS, require the STARTTLS upgrade instead of falling
        // back to a cleartext LOGIN when the server lacks it.
        ...(secure ? {} : { doSTARTTLS: true }),
        auth: { user: connection.username, pass: plaintext },
        logger: false,
        disableAutoIdle: true,
        connectionTimeout: input.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
        clientInfo: { name: "sona", vendor: "sona" },
      });
      await guarded("connect", [plaintext], async () => {
        try {
          await candidate.connect();
        } catch (error) {
          candidate.close();
          throw error;
        }
      });
      flow = candidate;
    },

    async listFolders() {
      const client = requireFlow("list");
      return guarded("list", [], async () => {
        const folders = await client.list();
        return folders.map(
          (folder): EmailFolder => ({ path: folder.path, specialUse: folder.specialUse }),
        );
      });
    },

    async openFolder(folder) {
      const client = requireFlow("examine");
      return guarded("examine", [], async () => {
        releaseLock();
        lock = await client.getMailboxLock(folder, { readOnly: true });
        const mailbox = client.mailbox;
        if (mailbox === false) {
          throw new Error("mailbox did not open");
        }
        opened = {
          folder,
          uidValidity: mailbox.uidValidity.toString(),
          uidNext: mailbox.uidNext,
          messageCount: mailbox.exists,
        };
        return opened;
      });
    },

    async fetchMessagesSince(request: FetchMessagesSinceInput) {
      const client = requireFlow("fetch");
      const folderState = requireOpened("fetch", request.folder);
      return guarded("fetch", [], async () => {
        // UIDs only grow, so nothing can exist at or past UIDNEXT as of EXAMINE;
        // this also avoids `UID SEARCH n:*` on an empty mailbox, which some
        // servers reject.
        if (request.sinceUid + 1 >= folderState.uidNext) {
          return [];
        }
        const query: SearchObject = { uid: `${request.sinceUid + 1}:*` };
        if (request.sinceDate !== undefined) {
          query.since = new Date(request.sinceDate);
        }
        const found = await client.search(query, { uid: true });
        if (!Array.isArray(found)) {
          // imapflow swallows SEARCH command errors and resolves `false`; an
          // empty mailbox is `[]`, so anything else is a failed command, not
          // "nothing new".
          throw new Error("UID SEARCH failed");
        }
        // `n:*` always includes the highest UID even when it is below `n`, so the
        // server result must be filtered client-side as well. SEARCH returns
        // numbers only, so the full result is cheap; the envelope FETCH is paged.
        const uids = found
          .filter((uid) => uid > request.sinceUid)
          .sort((a, b) => a - b)
          .slice(0, request.limit);
        if (uids.length === 0) {
          return [];
        }
        const messages = await client.fetchAll(toSequenceSet(uids), ENVELOPE_QUERY, {
          uid: true,
        });
        return messages
          .filter((message) => message.uid > request.sinceUid)
          .map((message) =>
            summarizeFetchedMessage(message, folderState.folder, folderState.uidValidity),
          );
      });
    },

    async fetchAttachment(request: FetchAttachmentInput) {
      const client = requireFlow("download");
      requireOpened("download", request.folder);
      return guarded("download", [], async () => {
        const label = `part ${request.partId} of UID ${request.uid}`;
        // `download()` streams and enforces `maxBytes`; ask for one byte more so
        // an over-cap part is detected here rather than silently truncated.
        // imapflow resolves `{}` (still typed `DownloadObject`) when the message
        // or part does not exist, hence the `Partial`.
        const result: Partial<DownloadObject> = await client.download(
          String(request.uid),
          request.partId,
          { uid: true, maxBytes: request.maxBytes + 1 },
        );
        if (result.content === undefined) {
          if (client.mailbox === false) {
            // imapflow also resolves `{}` once the connection dropped and the
            // mailbox closed; that is transient and must not be recorded as a
            // permanently missing part.
            throw new Error(`${label}: mailbox is no longer open`);
          }
          throw new AttachmentUnavailableError("part_unavailable", `${label} was not returned`);
        }
        return readCapped(result.content, request.maxBytes, label);
      });
    },

    async disconnect() {
      const client = flow;
      flow = undefined;
      if (client === undefined) {
        return;
      }
      releaseLock();
      try {
        await client.logout();
      } catch {
        client.close();
      }
    },
  };
}

/** Buffers a stream, aborting as soon as it exceeds `maxBytes`. */
async function readCapped(stream: Readable, maxBytes: number, label: string): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  // imapflow download streams yield binary chunks only (no `setEncoding`).
  for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) {
      stream.destroy();
      throw new AttachmentUnavailableError(
        "above_size_limit",
        `${label} exceeds ${maxBytes} bytes`,
      );
    }
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks, total));
}

/** Compresses sorted UIDs into an IMAP sequence set, e.g. `101:104,110`. */
export function toSequenceSet(sortedUids: readonly number[]): string {
  const ranges: Array<[start: number, end: number]> = [];
  for (const uid of sortedUids) {
    const last = ranges.at(-1);
    if (last !== undefined && uid === last[1] + 1) {
      last[1] = uid;
    } else {
      ranges.push([uid, uid]);
    }
  }
  return ranges.map(([start, end]) => (start === end ? `${start}` : `${start}:${end}`)).join(",");
}

/** Maps an `imapflow` FETCH result to Sona's envelope-only summary. */
export function summarizeFetchedMessage(
  message: FetchMessageObject,
  folder: string,
  uidValidity: string,
): EmailMessageSummary {
  const envelope = message.envelope;
  return {
    folder,
    uid: message.uid,
    uidValidity,
    messageId: envelope?.messageId,
    subject: envelope?.subject,
    date: toIsoDate(envelope?.date) ?? toIsoDate(message.internalDate),
    from: firstAddress(envelope?.from),
    attachments:
      message.bodyStructure === undefined ? [] : collectAttachmentParts(message.bodyStructure),
  };
}

function firstAddress(
  addresses: readonly MessageAddressObject[] | undefined,
): EmailAddress | undefined {
  const first = addresses?.find((entry) => entry.address !== undefined && entry.address !== "");
  if (first?.address === undefined) {
    return undefined;
  }
  const name = first.name?.trim();
  return {
    name: name === undefined || name.length === 0 ? undefined : name,
    address: first.address.trim().toLowerCase(),
  };
}

function toIsoDate(value: Date | string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Walks a BODYSTRUCTURE tree and returns every leaf that can carry a document:
 * anything that is not a bare text body. Text parts with a filename (e.g.
 * `terms.txt`) are still reported so the policy layer can count them as
 * skipped.
 */
export function collectAttachmentParts(root: MessageStructureObject): EmailAttachmentPart[] {
  const parts: EmailAttachmentPart[] = [];
  const visit = (node: MessageStructureObject, isRoot: boolean): void => {
    const type = node.type.toLowerCase();
    if (node.childNodes !== undefined && node.childNodes.length > 0) {
      for (const child of node.childNodes) {
        visit(child, false);
      }
      return;
    }
    if (type.startsWith("multipart/")) {
      return;
    }
    const partId = node.part ?? (isRoot ? "1" : undefined);
    if (partId === undefined) {
      return;
    }
    const disposition = toDisposition(node.disposition);
    const filename = node.dispositionParameters?.["filename"] ?? node.parameters?.["name"];
    const isCandidate =
      disposition === "attachment" || filename !== undefined || !type.startsWith("text/");
    if (!isCandidate) {
      return;
    }
    parts.push({
      partId,
      filename,
      mimeType: type,
      size: node.size,
      disposition,
      contentId: node.id === undefined ? undefined : node.id.replace(/^<|>$/g, ""),
    });
  };
  visit(root, true);
  return parts;
}

function toDisposition(value: string | undefined): AttachmentDisposition | undefined {
  const lower = value?.toLowerCase();
  return lower === "attachment" || lower === "inline" ? lower : undefined;
}

function errorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    return typeof error.code === "string" ? error.code : undefined;
  }
  return undefined;
}
