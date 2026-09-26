/**
 * Error types shared by every {@link PaperlessClient} implementation. Messages
 * are redacted before construction: no token, no full URL, no document title.
 */

export type PaperlessOperation = "list" | "download";

export class PaperlessClientError extends Error {
  readonly operation: PaperlessOperation;
  /** HTTP status when the server answered; `undefined` for transport failures. */
  readonly status: number | undefined;
  constructor(operation: PaperlessOperation, message: string, status: number | undefined) {
    super(`Paperless ${operation} failed: ${message}`);
    this.name = "PaperlessClientError";
    this.operation = operation;
    this.status = status;
  }
}

/** The original exceeds the configured byte cap and never will fit; skipped, not retried. */
export class PaperlessDocumentTooLargeError extends PaperlessClientError {
  readonly documentId: number;
  constructor(documentId: number, maxBytes: number) {
    super("download", `document ${documentId} exceeds ${maxBytes} bytes`, undefined);
    this.name = "PaperlessDocumentTooLargeError";
    this.documentId = documentId;
  }
}

/** A configured base URL that is not on the allowlist or not safely reachable. */
export class PaperlessBaseUrlRejectedError extends Error {
  constructor(reason: string) {
    super(`Paperless base URL rejected: ${reason}`);
    this.name = "PaperlessBaseUrlRejectedError";
  }
}

/** Thrown by the test fake when a code path attempts a non-GET request. */
export class PaperlessReadOnlyViolationError extends Error {
  readonly method: string;
  constructor(method: string) {
    super(`Read-only Paperless policy violated: ${method} must never be issued`);
    this.name = "PaperlessReadOnlyViolationError";
    this.method = method;
  }
}
