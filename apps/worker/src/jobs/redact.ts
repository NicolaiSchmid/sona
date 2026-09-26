/**
 * Error summaries stored on jobs, job runs, and audit events must never carry
 * credentials or account identifiers. Messages are truncated and obvious
 * secret/IBAN shapes are masked before persistence.
 */

import type { JsonValue } from "@sona/core";

const MAX_ERROR_LENGTH = 500;

const REDACTIONS: ReadonlyArray<[RegExp, string]> = [
  // Bearer / JWT-style tokens.
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?/g, "[jwt redacted]"],
  // key=value style secrets in query strings or config dumps.
  [
    /\b(api[_-]?key|secret|token|password|passwd|authorization|session[_-]?id)\s*[=:]\s*["']?[^\s"'&,;]+/gi,
    "$1=[redacted]",
  ],
  // IBANs (two letters, two check digits, 11-30 alphanumerics), optionally
  // space-grouped the way banks print them in error messages.
  [/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g, "[iban redacted]"],
  // PEM blocks.
  [/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, "[pem redacted]"],
];

export function redactText(value: string): string {
  let text = value;
  for (const [pattern, replacement] of REDACTIONS) {
    text = text.replace(pattern, replacement);
  }
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}…` : text;
}

/** `Name: message` for errors, `String(value)` otherwise — redacted and truncated. */
export function redactError(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name === "" ? "Error" : error.name;
    return redactText(`${name}: ${error.message}`);
  }
  return redactText(String(error));
}

/** Object keys whose values are never persisted from caller-supplied metadata. */
const SENSITIVE_KEY =
  /(password|passwd|secret|token|api[_-]?key|authorization|session[_-]?id|cookie|private[_-]?key)/i;

/**
 * Deep-copies JSON metadata, replacing the value of every key that looks like
 * a credential and redacting strings, so provenance recorded from uploads,
 * portals, or emails never carries a secret into the database.
 */
export function redactJson(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(redactJson);
  }
  const redacted: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    redacted[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redactJson(child);
  }
  return redacted;
}
