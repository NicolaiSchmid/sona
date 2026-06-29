import { createHash } from "node:crypto";

/** A value that round-trips through JSON without loss. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Returns the lowercase hex SHA-256 of the given data. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Stable hash of a JSON value with deterministically sorted object keys, so the
 * same logical payload always hashes identically regardless of key order.
 *
 * Only JSON-shaped values are accepted. Non-JSON inputs (Date, Map, class
 * instances, functions, symbols, bigint, NaN/Infinity) throw rather than being
 * silently coerced — otherwise distinct payloads could collide or a payload
 * could hash inconsistently with its JSON form, corrupting dedup and audit.
 */
export function stableJsonHash(value: JsonValue): string {
  return sha256Hex(canonicalize(value));
}

function canonicalize(value: JsonValue): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`Cannot hash non-finite number: ${value}`);
      }
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`Cannot hash non-JSON value of type ${typeof value}`);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Cannot hash non-plain object; expected a JSON object");
  }

  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
  return `{${entries.join(",")}}`;
}
