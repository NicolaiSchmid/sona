/**
 * Error types shared by every {@link ImapClient} implementation so the sync can
 * tell a transient failure (retry next run) from a part that can never be
 * fetched (count as skipped and move on).
 */

/** IMAP-level operation an {@link ImapClientError} originated from. */
export type ImapOperation = "connect" | "list" | "examine" | "fetch" | "download";

export class ImapClientError extends Error {
  readonly operation: ImapOperation;
  /** Library/server error code when available (e.g. `AUTHENTICATIONFAILED`). */
  readonly code: string | undefined;
  constructor(operation: ImapOperation, message: string, code: string | undefined) {
    super(`IMAP ${operation} failed: ${message}`);
    this.name = "ImapClientError";
    this.operation = operation;
    this.code = code;
  }
}

/** Why a part will not succeed on retry. Mirrors the matching `AttachmentSkipReason` members. */
export type AttachmentUnavailableReason = "above_size_limit" | "part_unavailable";

const UNAVAILABLE_CODES = {
  above_size_limit: "ATTACHMENT_TOO_LARGE",
  part_unavailable: "PART_UNAVAILABLE",
} as const satisfies Record<AttachmentUnavailableReason, string>;

/**
 * A single attachment part cannot be fetched and never will be: it exceeds the
 * configured byte cap, or the server does not return the advertised part. The
 * sync records it as skipped rather than pinning the cursor on it forever.
 */
export class AttachmentUnavailableError extends ImapClientError {
  readonly reason: AttachmentUnavailableReason;
  constructor(reason: AttachmentUnavailableReason, message: string) {
    super("download", message, UNAVAILABLE_CODES[reason]);
    this.name = "AttachmentUnavailableError";
    this.reason = reason;
  }
}
