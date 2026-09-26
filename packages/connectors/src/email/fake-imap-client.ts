/**
 * Deterministic in-memory {@link ImapClient} for tests.
 *
 * Every IMAP-level command is appended to {@link FakeImapClient.commands} so a
 * test can assert exactly which commands a sync issued. The fake also exposes
 * the mutating IMAP operations a real server would accept (STORE, COPY, MOVE,
 * EXPUNGE, APPEND) — each one records the command and throws, so any code path
 * that tries to change mailbox state fails loudly instead of silently mutating
 * a user's inbox.
 */
import { AttachmentUnavailableError } from "./errors.js";
import type {
  EmailFolder,
  EmailMessageSummary,
  FetchAttachmentInput,
  FetchMessagesSinceInput,
  ImapClient,
  OpenedFolder,
} from "./types.js";

export interface FakeMessage extends EmailMessageSummary {
  /** Part bytes keyed by `partId`. Parts missing here fail to download. */
  parts: Readonly<Record<string, Uint8Array>>;
  /** Server-side internal date, ISO-8601, used for `sinceDate` filtering. */
  internalDate: string;
}

export interface FakeFolder {
  uidValidity: string;
  specialUse?: string;
  messages: FakeMessage[];
}

export type FakeImapCommand =
  | "CONNECT"
  | "LIST"
  | `EXAMINE ${string}`
  | `UID SEARCH ${string}`
  | `UID FETCH ${string}`
  | `STORE ${string}`
  | `COPY ${string}`
  | `MOVE ${string}`
  | `EXPUNGE ${string}`
  | `APPEND ${string}`
  | "LOGOUT";

const MUTATING_COMMANDS = ["STORE", "COPY", "MOVE", "EXPUNGE", "APPEND"] as const;

export type MutatingImapCommand = (typeof MUTATING_COMMANDS)[number];

export class ImapReadOnlyViolationError extends Error {
  readonly command: MutatingImapCommand;
  constructor(command: MutatingImapCommand) {
    super(`Read-only IMAP policy violated: ${command} must never be issued`);
    this.name = "ImapReadOnlyViolationError";
    this.command = command;
  }
}

export interface FakeImapClientOptions {
  /** Workspace the fake mailbox belongs to. */
  workspaceId: string;
  folders: Readonly<Record<string, FakeFolder>>;
  /** Simulate a failing download for a specific message part. */
  failAttachment?: { uid: number; partId: string };
  /** Simulate a connection failure (e.g. bad credentials). */
  connectError?: Error;
}

export class FakeImapClient implements ImapClient {
  readonly workspaceId: string;
  readonly commands: FakeImapCommand[] = [];
  readonly #options: FakeImapClientOptions;
  #connected = false;
  #selectedFolder: string | undefined;

  constructor(options: FakeImapClientOptions) {
    this.workspaceId = options.workspaceId;
    this.#options = options;
  }

  get connected(): boolean {
    return this.#connected;
  }

  async connect(): Promise<void> {
    this.commands.push("CONNECT");
    if (this.#options.connectError !== undefined) {
      throw this.#options.connectError;
    }
    this.#connected = true;
  }

  async listFolders(): Promise<EmailFolder[]> {
    this.#requireConnected();
    this.commands.push("LIST");
    return Object.entries(this.#options.folders).map(([path, folder]) => ({
      path,
      specialUse: folder.specialUse,
    }));
  }

  async openFolder(folder: string): Promise<OpenedFolder> {
    this.#requireConnected();
    this.commands.push(`EXAMINE ${folder}`);
    const state = this.#folder(folder);
    const maxUid = state.messages.reduce((max, message) => Math.max(max, message.uid), 0);
    this.#selectedFolder = folder;
    return {
      folder,
      uidValidity: state.uidValidity,
      uidNext: maxUid + 1,
      messageCount: state.messages.length,
    };
  }

  async fetchMessagesSince(input: FetchMessagesSinceInput): Promise<EmailMessageSummary[]> {
    this.#requireSelected(input.folder);
    const criteria = [`UID ${input.sinceUid + 1}:*`];
    if (input.sinceDate !== undefined) {
      criteria.push(`SINCE ${input.sinceDate}`);
    }
    this.commands.push(`UID SEARCH ${criteria.join(" ")}`);
    const matching = this.#folder(input.folder)
      .messages.filter((message) => message.uid > input.sinceUid)
      .filter((message) => input.sinceDate === undefined || message.internalDate >= input.sinceDate)
      .sort((a, b) => a.uid - b.uid)
      .slice(0, input.limit);
    if (matching.length > 0) {
      this.commands.push(
        `UID FETCH ${matching.map((m) => m.uid).join(",")} (ENVELOPE BODYSTRUCTURE)`,
      );
    }
    return matching.map(toSummary);
  }

  async fetchAttachment(input: FetchAttachmentInput): Promise<Uint8Array> {
    this.#requireSelected(input.folder);
    this.commands.push(`UID FETCH ${input.uid} BODY[${input.partId}]`);
    const failing = this.#options.failAttachment;
    if (failing !== undefined && failing.uid === input.uid && failing.partId === input.partId) {
      throw new Error(`Simulated download failure for UID ${input.uid} part ${input.partId}`);
    }
    const message = this.#folder(input.folder).messages.find((m) => m.uid === input.uid);
    const bytes = message?.parts[input.partId];
    if (bytes === undefined) {
      throw new AttachmentUnavailableError(
        "part_unavailable",
        `No such part ${input.partId} on UID ${input.uid}`,
      );
    }
    if (bytes.byteLength > input.maxBytes) {
      throw new AttachmentUnavailableError(
        "above_size_limit",
        `Part ${input.partId} on UID ${input.uid} exceeds ${input.maxBytes} bytes`,
      );
    }
    return new Uint8Array(bytes);
  }

  async disconnect(): Promise<void> {
    if (this.#connected) {
      this.commands.push("LOGOUT");
    }
    this.#connected = false;
    this.#selectedFolder = undefined;
  }

  // --- Mutating operations: always rejected -----------------------------------

  async setFlags(uid: number, flags: readonly string[]): Promise<never> {
    return this.#reject("STORE", `${uid} +FLAGS (${flags.join(" ")})`);
  }

  async copyMessage(uid: number, destination: string): Promise<never> {
    return this.#reject("COPY", `${uid} ${destination}`);
  }

  async moveMessage(uid: number, destination: string): Promise<never> {
    return this.#reject("MOVE", `${uid} ${destination}`);
  }

  async deleteMessage(uid: number): Promise<never> {
    return this.#reject("EXPUNGE", `${uid}`);
  }

  async appendMessage(folder: string): Promise<never> {
    return this.#reject("APPEND", folder);
  }

  /** Commands that would have changed mailbox state, for assertions. */
  mutatingCommands(): FakeImapCommand[] {
    return this.commands.filter((command) =>
      MUTATING_COMMANDS.some((prefix) => command.startsWith(`${prefix} `)),
    );
  }

  #reject(command: MutatingImapCommand, detail: string): never {
    this.commands.push(`${command} ${detail}`);
    throw new ImapReadOnlyViolationError(command);
  }

  #requireConnected(): void {
    if (!this.#connected) {
      throw new Error("FakeImapClient is not connected");
    }
  }

  #requireSelected(folder: string): void {
    this.#requireConnected();
    if (this.#selectedFolder !== folder) {
      throw new Error(`Folder ${folder} is not selected`);
    }
  }

  #folder(folder: string): FakeFolder {
    const state = this.#options.folders[folder];
    if (state === undefined) {
      throw new Error(`Mailbox does not exist: ${folder}`);
    }
    return state;
  }
}

function toSummary(message: FakeMessage): EmailMessageSummary {
  return {
    folder: message.folder,
    uid: message.uid,
    uidValidity: message.uidValidity,
    messageId: message.messageId,
    subject: message.subject,
    date: message.date,
    from: message.from,
    attachments: message.attachments.map((part) => ({ ...part })),
  };
}
