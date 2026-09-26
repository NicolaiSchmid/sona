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

/** Reads an INTEGER 0/1 boolean column, rejecting anything else. */
export function requiredBoolean(source: Row, key: string): boolean {
  const value = source[key];
  if (value !== 0 && value !== 1) {
    throw new Error(`database column ${key} was not a 0/1 boolean`);
  }
  return value === 1;
}

/**
 * Reads a closed-vocabulary TEXT column through a type guard, so a corrupted
 * or out-of-date value surfaces as an error instead of being cast through.
 */
export function requiredLiteral<T extends string>(
  source: Row,
  key: string,
  isMember: (value: string) => value is T,
): T {
  const value = requiredString(source, key);
  if (!isMember(value)) {
    throw new Error(`database column ${key} had unexpected value ${JSON.stringify(value)}`);
  }
  return value;
}

export function optionalNumber(source: Row, key: string): number | undefined {
  const value = source[key];
  if (value === null || value === undefined) {
    return undefined;
  }
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

/** Builds a `(?, ?, ...)` placeholder list for a parameterized `IN` clause. */
export function placeholders(count: number): string {
  return `(${Array.from({ length: count }, () => "?").join(", ")})`;
}

// --- Transactions -----------------------------------------------------------

/**
 * Nesting depth per executor: depth 0 opens a real transaction, deeper levels
 * use savepoints. Keyed by the executor object, so use one `DbClient` per
 * connection — two wrappers over the same connection cannot see each other.
 */
const transactionDepth = new WeakMap<SqlExecutor, number>();

interface TransactionScope {
  commit(): void;
  rollback(): void;
  close(): void;
}

function beginScope(db: SqlExecutor): TransactionScope {
  const depth = transactionDepth.get(db) ?? 0;
  const savepoint = depth === 0 ? undefined : `sona_savepoint_${depth}`;
  db.exec(savepoint === undefined ? "BEGIN" : `SAVEPOINT ${savepoint}`);
  transactionDepth.set(db, depth + 1);
  return {
    commit: () => {
      db.exec(savepoint === undefined ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
    },
    rollback: () => {
      try {
        if (savepoint === undefined) {
          db.exec("ROLLBACK");
        } else {
          db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        }
      } catch {
        // Surface the original write failure, not the rollback's.
      }
    },
    close: () => {
      if (depth === 0) {
        transactionDepth.delete(db);
      } else {
        transactionDepth.set(db, depth);
      }
    },
  };
}

/**
 * Runs `work` atomically. Nested calls on the same executor become savepoints
 * (SQLite and PostgreSQL), so repository methods compose into one outer unit:
 * an inner failure rolls back only its own writes, an outer failure rolls
 * back everything. The callback is synchronous, which is the natural fit for
 * `node:sqlite`'s synchronous statements.
 */
export function withTransaction<T>(db: SqlExecutor, work: () => T): T {
  const scope = beginScope(db);
  try {
    const result = work();
    scope.commit();
    return result;
  } catch (error) {
    scope.rollback();
    throw error;
  } finally {
    scope.close();
  }
}

/**
 * Async variant of {@link withTransaction} for composing `async` repository
 * methods into one atomic unit (e.g. ledger transaction + evidence link +
 * audit event). Only safe when nothing else issues statements on this
 * connection while the callback is suspended — true for a worker that
 * processes jobs sequentially on its own connection.
 */
export async function withTransactionAsync<T>(db: SqlExecutor, work: () => Promise<T>): Promise<T> {
  const scope = beginScope(db);
  try {
    const result = await work();
    scope.commit();
    return result;
  } catch (error) {
    scope.rollback();
    throw error;
  } finally {
    scope.close();
  }
}
