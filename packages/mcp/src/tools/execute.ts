/**
 * `execute` runs a small snippet of agent-authored code against the typed
 * `sona.*` facade.
 *
 * ## Security model
 *
 * Running agent-authored code safely requires a real isolate. Node's `vm`
 * module is explicitly NOT a security mechanism: the context's global is a host
 * object reachable via `this` / `globalThis` / the `Function` constructor, and a
 * single event loop cannot be preempted from a microtask loop. We therefore do
 * NOT enable code execution by default and do NOT bake in an in-process eval.
 *
 * Execution is pluggable via {@link CodeRunner}. A deployment that wants
 * `execute` must opt in by supplying a runner (see `createSonaTools`). For
 * untrusted/networked input that runner MUST be a true isolate (e.g. a V8
 * isolate via `isolated-vm`, or a locked-down worker/subprocess).
 *
 * {@link createVmDevRunner} is provided for LOCAL DEV ONLY. It is hardened in
 * shallow ways (facade rebuilt in-realm, strict-mode body so `this` is
 * undefined, deny-list, results crossing back as JSON so the host never touches
 * live VM objects, watchdog + deadline timers) but it is explicitly NOT a
 * security boundary: it cannot stop capability escapes through `globalThis` /
 * `Function`, nor bound a microtask loop. Never expose it to untrusted input.
 */
import { createContext, runInContext } from "node:vm";
import { createFacade } from "../facade.js";

export interface ExecuteInput {
  code: string;
  /** Wall-clock budget in ms. Best-effort for async work (see security model). */
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

/**
 * Pluggable execution backend. Implement this with a real isolate to run
 * untrusted code; {@link createVmDevRunner} is a dev-only reference.
 */
export interface CodeRunner {
  run(input: ExecuteInput): Promise<ExecuteResult>;
}

/** Runs a snippet through the given runner. A runner is always required. */
export function execute(input: ExecuteInput, runner: CodeRunner): Promise<ExecuteResult> {
  return runner.run(input);
}

/** Substrings rejected up front (defense in depth, NOT the security boundary). */
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

function forbidden(token: string): ExecuteFailure {
  return {
    ok: false,
    error: {
      name: "ForbiddenAccessError",
      message: `Code may only use the sona.* facade; disallowed token: ${token}`,
    },
  };
}

function hostError(error: unknown): ExecuteFailure {
  if (error instanceof Error) {
    return { ok: false, error: { name: error.name, message: error.message } };
  }
  return { ok: false, error: { name: "Error", message: String(error) } };
}

/**
 * Dev-only {@link CodeRunner} backed by `node:vm`. See the file header: this is
 * a convenience for local use, not a sandbox for untrusted input.
 */
export function createVmDevRunner(): CodeRunner {
  return {
    async run({ code, timeoutMs = 1000 }) {
      const offending = DENIED_PATTERNS.find((pattern) => code.includes(pattern));
      if (offending) {
        return forbidden(offending);
      }

      const context = createContext({});
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        runInContext(`globalThis.sona = ${FACADE_FACTORY_SOURCE};`, context, {
          timeout: timeoutMs,
        });

        // Strict-mode body so user `this` is undefined; the result and any error
        // are serialized to JSON *inside* the realm, so the host only ever
        // handles a primitive string (never live getters/Proxies/accessors).
        const wrapped = `(async function () {
          "use strict";
          try {
            const __value = await (async () => { ${code}\n })();
            return JSON.stringify({ ok: true, value: __value === undefined ? null : __value });
          } catch (err) {
            const name = err && typeof err === "object" && typeof err.name === "string"
              ? err.name : "Error";
            let message;
            try {
              message = err && typeof err === "object" && "message" in err
                ? String(err.message) : String(err);
            } catch { message = "Error"; }
            return JSON.stringify({ ok: false, error: { name, message } });
          }
        })()`;

        const execution = runInContext(wrapped, context, { timeout: timeoutMs }) as Promise<string>;
        const deadline = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Execution timed out")), timeoutMs);
          timer.unref?.();
        });

        const json = await Promise.race([execution, deadline]);
        return JSON.parse(json) as ExecuteResult;
      } catch (error) {
        return hostError(error);
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    },
  };
}
