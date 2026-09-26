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

/**
 * Reads a body as a stream and abandons it the moment the cap is crossed, so
 * no more than `maxBytes` is ever buffered whatever `Content-Length` claims.
 */
export async function readBodyWithLimit(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array> {
  if (body === null) {
    return new Uint8Array(0);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new DownloadTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/** Parses a `Content-Length` header; undefined when absent or malformed. */
export function parseContentLength(value: string | null | undefined): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function isSuccessfulStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

export function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
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
