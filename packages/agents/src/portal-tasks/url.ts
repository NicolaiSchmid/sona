/**
 * Drops the query string and fragment from a URL. Authenticated portal URLs
 * often carry session ids or signed parameters, so this runs before a URL
 * lands in provenance, stored metadata, or blocked-request records. Returns
 * undefined when the input is not a parseable URL.
 */
export function sanitizeUrl(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return undefined;
  }
}

export function resolveUrl(rawHref: string, baseUrl: string): string {
  return new URL(rawHref, baseUrl).toString();
}
