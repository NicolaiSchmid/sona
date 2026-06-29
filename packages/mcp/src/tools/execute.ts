/**
 * `execute` runs a small snippet of agent-authored code against the typed
 * `sona.*` facade.
 *
 * ⚠️ Security scope (READ THIS): this is a constrained, DEV/LOCAL execution
 * harness, not a hardened multi-tenant sandbox. The snippet runs in a fresh
 * `node:vm` context whose only injected binding is `sona`. There is no
 * `process`, `require`, `import`, `fetch`, filesystem, network, or secret
 * access in scope, and a static deny-list rejects obvious escape attempts.
 *
 * However, `node:vm` does NOT provide a real security boundary (async work is
 * not bounded by the timeout, and a determined snippet can reach shared
 * intrinsics). Do NOT expose this to untrusted input over a network without
 * replacing the engine with a true sandbox (isolated worker/V8 isolate) and
 * adding auth, resource limits, and per-operation risk gating.
 */
import { createContext, Script } from "node:vm";
import { createFacade, type SonaFacade } from "../facade";

export interface ExecuteInput {
  code: string;
  /** Sync wall-clock budget in ms (does not bound async work). */
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
 * Executes `code` as the body of an async function with `sona` in scope.
 * The snippet returns its result, e.g. `return await sona.sources.list();`.
 */
export async function execute(
  input: ExecuteInput,
  facade: SonaFacade = createFacade(),
): Promise<ExecuteResult> {
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

  // Only `sona` is reachable; ECMAScript intrinsics exist, Node globals do not.
  const context = createContext({ sona: facade });

  try {
    const script = new Script(`(async () => { ${code}\n })()`);
    const promise = script.runInContext(context, { timeout: timeoutMs }) as Promise<unknown>;
    const value = await promise;
    return { ok: true, value };
  } catch (error) {
    return normalizeError(error);
  }
}
