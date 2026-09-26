/**
 * Pure helpers for the session cookie. The web layer decides the framework;
 * these only produce `Set-Cookie` values so the security attributes are
 * defined once and tested in isolation.
 */

export const DEFAULT_SESSION_COOKIE_NAME = "sona_session";

export const SAME_SITE_MODES = ["Strict", "Lax"] as const;

export type SameSiteMode = (typeof SAME_SITE_MODES)[number];

export interface SessionCookieOptions {
  name?: string;
  /** Emit the `Secure` attribute. Only ever false for plain-http localhost dev. */
  secure?: boolean;
  sameSite?: SameSiteMode;
  path?: string;
  domain?: string;
}

export interface SessionCookieAttributes {
  name: string;
  value: string;
  httpOnly: true;
  secure: boolean;
  sameSite: SameSiteMode;
  path: string;
  domain: string | undefined;
  expires: Date | undefined;
  /** Set for clearing cookies. */
  maxAge: number | undefined;
}

const COOKIE_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const COOKIE_VALUE_RE = /^[!#-+\--:<-[\]-~]*$/;

export function sessionCookie(
  token: string,
  expiresAt: Date,
  options: SessionCookieOptions = {},
): SessionCookieAttributes {
  return {
    name: options.name ?? DEFAULT_SESSION_COOKIE_NAME,
    value: token,
    httpOnly: true,
    secure: options.secure ?? true,
    sameSite: options.sameSite ?? "Lax",
    path: options.path ?? "/",
    domain: options.domain,
    expires: expiresAt,
    maxAge: undefined,
  };
}

/** Attributes that remove the cookie on the client. */
export function clearSessionCookie(options: SessionCookieOptions = {}): SessionCookieAttributes {
  return {
    ...sessionCookie("", new Date(0), options),
    maxAge: 0,
  };
}

export function serializeCookie(attributes: SessionCookieAttributes): string {
  if (!COOKIE_NAME_RE.test(attributes.name)) {
    throw new Error("Invalid cookie name");
  }
  if (!COOKIE_VALUE_RE.test(attributes.value)) {
    throw new Error("Invalid cookie value");
  }
  const parts = [`${attributes.name}=${attributes.value}`, `Path=${attributes.path}`];
  if (attributes.domain !== undefined) {
    parts.push(`Domain=${attributes.domain}`);
  }
  if (attributes.expires !== undefined) {
    parts.push(`Expires=${attributes.expires.toUTCString()}`);
  }
  if (attributes.maxAge !== undefined) {
    parts.push(`Max-Age=${attributes.maxAge}`);
  }
  parts.push("HttpOnly");
  if (attributes.secure) {
    parts.push("Secure");
  }
  parts.push(`SameSite=${attributes.sameSite}`);
  return parts.join("; ");
}

/** Reads one cookie's value from a `Cookie` request header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) {
      continue;
    }
    if (pair.slice(0, separator).trim() === name) {
      return pair.slice(separator + 1).trim();
    }
  }
  return undefined;
}
