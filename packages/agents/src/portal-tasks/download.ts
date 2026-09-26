/**
 * Download policy helpers shared by the runner and browser adapters.
 */
import { resolveUrl } from "./url.js";

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

/** Only the statuses clients actually follow; 304 and friends are not redirects. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

export function isRedirectStatus(status: number): boolean {
  return REDIRECT_STATUSES.has(status);
}

/** 307/308 keep method and body; every other redirect becomes a body-less GET. */
export function redirectPreservesMethod(status: number): boolean {
  return status === 307 || status === 308;
}

export const MAX_REDIRECT_HOPS = 5;

export interface RedirectTargetInput {
  status: number;
  location: string | null | undefined;
  currentUrl: string;
  /** Hops already followed before this one. */
  hop: number;
  /** Defaults to {@link MAX_REDIRECT_HOPS}. */
  maxHops?: number;
}

/** Resolves the next hop of a redirect chain or throws when it cannot be followed safely. */
export function redirectTarget(input: RedirectTargetInput): string {
  const maxHops = input.maxHops ?? MAX_REDIRECT_HOPS;
  if (input.hop >= maxHops) {
    throw new Error(`redirect chain exceeded ${maxHops} hops`);
  }
  if (input.location === undefined || input.location === null) {
    throw new Error(`redirect ${input.status} without a Location header`);
  }
  return resolveUrl(input.location, input.currentUrl);
}

/** Compares media types only; parameters such as `charset` are ignored. */
export function isExpectedMimeType(actual: string, expected: string): boolean {
  return mediaType(actual) === mediaType(expected);
}

/** Document types a task may download: each has a byte signature the runner verifies. */
export const DOWNLOAD_MIME_TYPES = ["application/pdf", "image/png", "image/jpeg"] as const;

export type DownloadMimeType = (typeof DOWNLOAD_MIME_TYPES)[number];

const FILE_EXTENSIONS: Readonly<Record<DownloadMimeType, string>> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
};

/** File extension for a declared download type; falls back to `bin` for unknown input. */
export function fileExtensionFor(mimeType: string): string {
  const declared = mediaType(mimeType);
  return isDownloadMimeType(declared) ? FILE_EXTENSIONS[declared] : "bin";
}

const SIGNATURES: Readonly<Record<DownloadMimeType, readonly Uint8Array[]>> = {
  "application/pdf": [new TextEncoder().encode("%PDF-")],
  "image/png": [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  "image/jpeg": [new Uint8Array([0xff, 0xd8, 0xff])],
};

/**
 * A server-controlled `Content-Type` is not enough to accept bytes as tax
 * evidence; an expired-session page or proxy error labelled `application/pdf`
 * must not be stored as an invoice. Returns the rejection reason, or undefined
 * when the payload carries the signature of the declared type.
 */
export function documentBytesProblem(bytes: Uint8Array, mimeType: string): string | undefined {
  if (bytes.byteLength === 0) {
    return "download payload is empty";
  }
  const declared = mediaType(mimeType);
  if (!isDownloadMimeType(declared)) {
    return `download media type ${declared} is not a supported evidence format`;
  }
  return SIGNATURES[declared].some((signature) => startsWith(bytes, signature))
    ? undefined
    : `download payload does not carry the ${declared} signature`;
}

function isDownloadMimeType(value: string): value is DownloadMimeType {
  return (DOWNLOAD_MIME_TYPES as readonly string[]).includes(value);
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
