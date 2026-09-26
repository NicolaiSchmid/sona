import type { JsonValue } from "@sona/core";
import type { SqlExecutor } from "../runner.js";

export type Row = Record<string, unknown>;

export function row(value: unknown): Row | undefined {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Row;
}

export function rows(values: unknown[]): Row[] {
  return values.map((value) => {
    const parsed = row(value);
    if (parsed === undefined) {
      throw new Error("database returned a non-object row");
    }
    return parsed;
  });
}

export function requiredString(source: Row, key: string): string {
  const value = source[key];
  if (typeof value !== "string") {
    throw new Error(`database column ${key} was not a string`);
  }
  return value;
}

export function optionalString(source: Row, key: string): string | undefined {
  const value = source[key];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`database column ${key} was not a string`);
  }
  return value;
}

export function requiredNumber(source: Row, key: string): number {
  const value = source[key];
  if (typeof value !== "number") {
    throw new Error(`database column ${key} was not a number`);
  }
  return value;
}

export function parseJson(value: string): JsonValue {
  return JSON.parse(value) as JsonValue;
}

export function stringifyJson(value: JsonValue): string {
  return JSON.stringify(value);
}

export function nullToUndefined(value: string | null): string | undefined {
  return value ?? undefined;
}

export function undefinedToNull(value: string | undefined): string | null {
  return value ?? null;
}

/**
 * Runs `work` inside one database transaction. The callback is synchronous on
 * purpose: `node:sqlite` statements are synchronous, and an awaited gap inside
 * BEGIN/COMMIT would let unrelated statements interleave with the write. On
 * failure the transaction is rolled back and the original error rethrown.
 */
export function withTransaction<T>(db: SqlExecutor, work: () => T): T {
  db.exec("BEGIN");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Surface the original write failure.
    }
    throw error;
  }
}

/** Builds a `(?, ?, ...)` placeholder list for a parameterized `IN` clause. */
export function placeholders(count: number): string {
  return `(${Array.from({ length: count }, () => "?").join(", ")})`;
}
