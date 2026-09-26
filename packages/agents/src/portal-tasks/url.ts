/**
 * URL scrubbing before anything is retained or shown. Portal URLs carry
 * session ids in query strings and account numbers, e-mail addresses, or
 * signed tokens in path segments, so one policy applies everywhere a URL lands
 * in provenance, stored metadata, blocked-request records, or error text.
 */

export const UNPARSEABLE_URL = "[unparseable url]";
const REDACTED_SEGMENT = "[REDACTED_SEGMENT]";
const URL_IN_TEXT_RE = /\b(?:https?|wss?):\/\/[^\s"'<>()[\]]+/gi;
const DIGIT_RUN_RE = /(?:\D*\d){8}/;
const TOKEN_CHARS_RE = /^[A-Za-z0-9._~+=%-]+$/;
const FILE_EXTENSION_RE = /\.[a-z]{2,4}$/i;
const MIN_TOKEN_SEGMENT_LENGTH = 20;

/**
 * Keeps protocol, host, and path shape; drops query, fragment, and userinfo
 * and replaces identifier-like path segments. Returns undefined when the input
 * is not a parseable URL.
 */
export function redactUrl(rawUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  const segments = url.pathname
    .split("/")
    .map((segment) => (isSensitivePathSegment(segment) ? REDACTED_SEGMENT : segment));
  return `${url.protocol}//${url.host}${segments.join("/")}`;
}

/** Applies {@link redactUrl} to every URL embedded in free text, such as a browser error. */
export function redactUrlsInText(text: string): string {
  return text.replace(URL_IN_TEXT_RE, (match) => redactUrl(match) ?? UNPARSEABLE_URL);
}

/**
 * Path and query with percent escapes decoded, for screening: servers decode
 * `/%64elete` to `/delete`, so the guard must too. Malformed input is returned
 * as is so it can still be screened literally.
 */
export function decodedPathAndQuery(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return safeDecode(`${url.pathname}${url.search}`);
  } catch {
    return safeDecode(rawUrl);
  }
}

/**
 * E-mail-like segments, anything carrying eight or more digits (account and
 * order numbers, IBANs), and long token-shaped segments without a file
 * extension (signed URLs, JWTs, base64 ids) are treated as sensitive. File
 * names stay when they carry fewer digits; the downloaded filename is retained
 * separately, so traceability does not depend on the URL.
 */
function isSensitivePathSegment(segment: string): boolean {
  const decoded = safeDecode(segment);
  if (decoded.includes("@") || DIGIT_RUN_RE.test(decoded)) {
    return true;
  }
  return (
    decoded.length >= MIN_TOKEN_SEGMENT_LENGTH &&
    TOKEN_CHARS_RE.test(decoded) &&
    !FILE_EXTENSION_RE.test(decoded)
  );
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function resolveUrl(rawHref: string, baseUrl: string): string {
  return new URL(rawHref, baseUrl).toString();
}
