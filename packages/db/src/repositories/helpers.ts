import type { JsonValue } from "@sona/core";

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
