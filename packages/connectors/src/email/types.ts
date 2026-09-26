/**
 * Shapes for the read-only email (IMAP) invoice source.
 *
 * The connector never reads message bodies: it fetches envelopes and body
 * structures, then downloads only the attachment parts that pass the
 * per-source policy. Message metadata becomes the raw source record; the
 * attachment itself is the evidence.
 */

export interface EmailAddress {
  /** Display name from the header, if any. */
  name: string | undefined;
  /** Lower-cased `local@domain` address. */
  address: string;
}

export type AttachmentDisposition = "attachment" | "inline";

/** One leaf part of a message's BODYSTRUCTURE that could carry a document. */
export interface EmailAttachmentPart {
  /** IMAP body part id, e.g. `"2"` or `"1.2"`; used to download the part. */
  partId: string;
  filename: string | undefined;
  /** Lower-cased `type/subtype`, e.g. `application/pdf`. */
  mimeType: string;
  /** Declared size in bytes when the server reports it. */
  size: number | undefined;
  disposition: AttachmentDisposition | undefined;
  /** Content-ID for parts referenced from an HTML body (embedded images). */
  contentId: string | undefined;
}

/** Envelope-level view of a message. Never contains the body or recipients. */
export interface EmailMessageSummary {
  folder: string;
  uid: number;
  /** Mailbox UIDVALIDITY as a decimal string (it is a 32-bit unsigned value). */
  uidValidity: string;
  /** `Message-ID` header without angle brackets, when present. */
  messageId: string | undefined;
  subject: string | undefined;
  /** Header date as ISO-8601, falling back to the server's internal date. */
  date: string | undefined;
  from: EmailAddress | undefined;
  attachments: readonly EmailAttachmentPart[];
}

export interface EmailFolder {
  path: string;
  /** RFC 6154 special-use flag, e.g. `\Inbox`, `\Junk`, when the server reports one. */
  specialUse: string | undefined;
}

export interface OpenedFolder {
  folder: string;
  uidValidity: string;
  /** Next UID the server predicts it will assign. */
  uidNext: number;
  messageCount: number;
}

export interface FetchMessagesSinceInput {
  folder: string;
  /** Only messages with a UID strictly greater than this are returned. */
  sinceUid: number;
  /** ISO date; when set, only messages received on/after this date are returned. */
  sinceDate?: string;
  /** At most this many messages (lowest UIDs first), so large folders are scanned in pages. */
  limit?: number;
}

export interface FetchAttachmentInput {
  folder: string;
  uid: number;
  partId: string;
  /** Hard cap; the client must fail rather than return more bytes. */
  maxBytes: number;
}

/**
 * Read-only IMAP access. The interface deliberately has no method that could
 * change mailbox state (flags, move, copy, delete, expunge, append).
 */
export interface ImapClient {
  /** Workspace whose credentials this client authenticates with; syncs refuse a mismatch. */
  readonly workspaceId: string;
  connect(): Promise<void>;
  listFolders(): Promise<EmailFolder[]>;
  /** Selects the folder in read-only (EXAMINE) mode. */
  openFolder(folder: string): Promise<OpenedFolder>;
  /** Messages with UID strictly greater than `sinceUid`, in ascending UID order. */
  fetchMessagesSince(input: FetchMessagesSinceInput): Promise<EmailMessageSummary[]>;
  fetchAttachment(input: FetchAttachmentInput): Promise<Uint8Array>;
  disconnect(): Promise<void>;
}

/** Per-source ingestion policy. All fields have conservative defaults. */
export interface EmailSourcePolicy {
  /** Mailbox folder to poll. Default `INBOX`. */
  folder?: string;
  /**
   * Allowed senders: exact addresses (`billing@vendor.example`) or domains
   * (`vendor.example`, `@vendor.example`; sub-domains match). Matching is
   * case-insensitive. When empty, every sender is accepted.
   */
  allowedSenders?: readonly string[];
  /** Lower-cased MIME types to store. Default: PDF plus common image types. */
  allowedMimeTypes?: readonly string[];
  /** Images smaller than this (signatures, logos, trackers) are skipped. Default 32 KiB. */
  minImageBytes?: number;
  /** Attachments larger than this are skipped and counted. Default 25 MiB. */
  maxAttachmentBytes?: number;
  /** ISO date bounding the very first sync (no cursor yet). Later syncs use the UID cursor. */
  initialSinceDate?: string;
}

export type AttachmentSkipReason =
  | "mime_type_not_allowed"
  | "embedded_image"
  | "below_size_threshold"
  | "above_size_limit"
  /** Downloaded bytes did not carry the signature of the declared type. */
  | "content_type_mismatch"
  /** The server did not return the advertised part. */
  | "part_unavailable";

export interface SkippedAttachment {
  partId: string;
  reason: AttachmentSkipReason;
}

export interface AttachmentSelection {
  selected: EmailAttachmentPart[];
  skipped: SkippedAttachment[];
}

/** Attachment entry on the raw record: what was stored, never the bytes. */
export interface RawEmailAttachment {
  partId: string;
  filename: string | undefined;
  mimeType: string;
  byteLength: number;
  contentHash: string;
}

/**
 * Redacted message metadata written to the raw source vault. Bodies, recipient
 * lists, and arbitrary headers are intentionally absent.
 */
export interface RawEmailMessagePayload {
  kind: "email_message";
  folder: string;
  uid: number;
  uidValidity: string;
  messageId: string | undefined;
  subject: string | undefined;
  date: string | undefined;
  fromAddress: string | undefined;
  fromName: string | undefined;
  attachments: RawEmailAttachment[];
}
