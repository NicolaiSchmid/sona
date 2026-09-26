/**
 * Bounded body reading for portal downloads. The runner must never buffer more
 * than the configured cap, whatever `Content-Length` claims, so bodies are
 * consumed as a stream and abandoned the moment the cap is crossed.
 */

export class DownloadTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`download exceeds ${maxBytes} byte limit`);
    this.name = "DownloadTooLargeError";
    this.maxBytes = maxBytes;
  }
}

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
  return concatChunks(chunks, total);
}

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
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
