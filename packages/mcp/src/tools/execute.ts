/**
 * `execute` runs a small snippet of agent-authored code against the typed
 * `sona.*` facade.
 *
 * ⚠️ Security scope (READ THIS): this is a DEV/LOCAL execution harness. It is
 * NOT part of the default public tool surface — `runSonaTool` only exposes it
 * when a server is built with `createSonaTools({ enableExecute: true })`.
 *
 * Hardening within the harness:
 * - The snippet runs in a fresh `node:vm` context. The `sona` facade is rebuilt
 *   *inside* that context from its own source, so executed code cannot reach a
 *   host object — and therefore cannot walk `someHostObject.constructor.
 *   constructor("return process")()` back to the host realm, secrets, or
 *   builtin modules. There is no `process`, `require`, `import`, `fetch`, or fs
 *   in scope.
 * - A substring deny-list rejects obvious escape attempts (defense in depth,
 *   not the security boundary).
 * - Both synchronous CPU time and async settlement are bounded by `timeoutMs`.
 *
 * `node:vm` is still not a guaranteed isolation boundary. Before exposing
 * `execute` to untrusted/networked input, replace the engine with a true
 * isolate (e.g. a V8 isolate / isolated worker) plus auth, resource limits, and
 * per-operation risk gating.
 */
import { createContext, runInContext } from "node:vm";
import { createFacade } from "../facade.js";

export interface ExecuteInput {
  code: string;
  /** Wall-clock budget in ms for both sync execution and async settlement. */
  timeoutMs?: number;
}

export interface ExecuteSuccess {
  ok: true;
  value: unknown;
}

export interface ExecuteFailure {
  ok: false;
  error: { name: string; message: string };
}

export type ExecuteResult = ExecuteSuccess | ExecuteFailure;

/** Substrings that indicate an attempt to reach beyond the facade. */
const DENIED_PATTERNS = [
  "process",
  "require",
  "import",
  "globalThis",
  "eval",
  "Function(",
  "constructor",
  "__proto__",
];

// `createFacade` is self-contained (literals and async functions only), so its
// source can be re-evaluated inside the vm realm to produce a sandbox-owned
// facade. Keep it free of external references for this to hold.
const FACADE_FACTORY_SOURCE = `(${createFacade.toString()})()`;

function normalizeError(error: unknown): ExecuteFailure {
  // Errors thrown inside the vm come from a different realm, so `instanceof
  // Error` does not hold; match structurally on an error-like object instead.
  if (error !== null && typeof error === "object" && "message" in error) {
    const errorLike = error as { name?: unknown; message?: unknown };
    return {
      ok: false,
      error: {
        name: typeof errorLike.name === "string" ? errorLike.name : "Error",
        message: typeof errorLike.message === "string" ? errorLike.message : String(error),
      },
    };
  }
  return { ok: false, error: { name: "Error", message: String(error) } };
}

/**
 * Executes `code` as the body of an async function with a sandbox-realm `sona`
 * in scope. The snippet returns its result, e.g.
 * `return await sona.sources.list();`.
 */
export async function execute(input: ExecuteInput): Promise<ExecuteResult> {
  const { code, timeoutMs = 1000 } = input;

  const offending = DENIED_PATTERNS.find((pattern) => code.includes(pattern));
  if (offending) {
    return {
      ok: false,
      error: {
        name: "ForbiddenAccessError",
        message: `Code may only use the sona.* facade; disallowed token: ${offending}`,
      },
    };
  }

  const context = createContext({});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Build the facade inside the realm; `sona` is a sandbox-owned object.
    runInContext(`globalThis.sona = ${FACADE_FACTORY_SOURCE};`, context, { timeout: timeoutMs });

    const execution = runInContext(`(async () => { ${code}\n })()`, context, {
      timeout: timeoutMs,
    }) as Promise<unknown>;

    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Execution timed out")), timeoutMs);
      timer.unref?.();
    });

    const value = await Promise.race([execution, deadline]);
    return { ok: true, value };
  } catch (error) {
    return normalizeError(error);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
