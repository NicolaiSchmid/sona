/**
 * Download policy helpers shared by the runner and browser adapters.
 */

export class DownloadTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`download exceeds ${maxBytes} byte limit`);
    this.name = "DownloadTooLargeError";
    this.maxBytes = maxBytes;
  }
}

export function isSuccessfulStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/** Compares media types only; parameters such as `charset` are ignored. */
export function isExpectedMimeType(actual: string, expected: string): boolean {
  return mediaType(actual) === mediaType(expected);
}

const PDF_SIGNATURE = new TextEncoder().encode("%PDF-");

/**
 * A server-controlled `Content-Type` is not enough to accept bytes as tax
 * evidence; an expired-session page or proxy error labelled `application/pdf`
 * must not be stored as an invoice. Returns the rejection reason, or undefined
 * when the payload looks like the declared type.
 */
export function documentBytesProblem(bytes: Uint8Array, mimeType: string): string | undefined {
  if (bytes.byteLength === 0) {
    return "download payload is empty";
  }
  if (mediaType(mimeType) === "application/pdf" && !startsWith(bytes, PDF_SIGNATURE)) {
    return "download payload does not carry a PDF signature";
  }
  return undefined;
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.byteLength < prefix.byteLength) {
    return false;
  }
  return prefix.every((byte, index) => bytes[index] === byte);
}

function mediaType(contentType: string): string {
  return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}
