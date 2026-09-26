/**
 * Drops the query string, fragment, and userinfo from a URL. Authenticated
 * portal URLs often carry session ids or signed parameters, so this runs before
 * a URL lands in provenance, stored metadata, or blocked-request records.
 * Returns undefined when the input is not a parseable URL.
 */
export function sanitizeUrl(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return undefined;
  }
}

/** Sanitizes every URL embedded in free text, such as a browser error message. */
export function sanitizeUrlsInText(text: string): string {
  return text.replace(URL_IN_TEXT_RE, (match) => sanitizeUrl(match) ?? "[unparseable url]");
}

const URL_IN_TEXT_RE = /\b(?:https?|wss?):\/\/[^\s"'<>()[\]]+/gi;

/**
 * Portals put account numbers, e-mail addresses, and signed tokens in path
 * segments too. Segments that look like identifiers of that kind are replaced
 * before a URL is retained; short human-readable segments and file names stay
 * so the document remains traceable.
 */
export function redactSensitiveUrlPath(rawUrl: string): string | undefined {
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

const REDACTED_SEGMENT = "[REDACTED_SEGMENT]";
const TOKEN_SEGMENT_RE = /^[A-Za-z0-9_-]{24,}$/;
const NUMERIC_ID_SEGMENT_RE = /^\d{8,}$/;

function isSensitivePathSegment(segment: string): boolean {
  const decoded = safeDecode(segment);
  return (
    decoded.includes("@") || TOKEN_SEGMENT_RE.test(decoded) || NUMERIC_ID_SEGMENT_RE.test(decoded)
  );
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function resolveUrl(rawHref: string, baseUrl: string): string {
  return new URL(rawHref, baseUrl).toString();
}
