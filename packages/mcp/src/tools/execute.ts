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
 * shallow ways (facade rebuilt in-realm with review-gated operations disabled,
 * strict-mode body so `this` is undefined, results crossing back as JSON so the
 * host never touches live VM objects, watchdog + deadline timers) but it is
 * explicitly NOT a security boundary: it cannot stop capability escapes through
 * `globalThis` / `Function`, nor bound a microtask loop. Never expose it to
 * untrusted input.
 *
 * Regardless of runner, code execution must not let an agent bypass the human
 * review gate, so operations whose catalog risk is `review_required` or higher
 * (e.g. `approveMatch`, `autoApply`, `generatePackage`, `runPortalTask`) are
 * disabled inside the executable facade — they throw if called from a snippet.
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

// `createFacade` is self-contained (literals and async functions only), so its
// source can be re-evaluated inside the vm realm to produce a sandbox-owned
// facade. Keep it free of external references for this to hold.
const FACADE_FACTORY_SOURCE = `(${createFacade.toString()})()`;

// Operations whose catalog risk is review_required or higher. They are disabled
// inside the executable facade so a snippet cannot bypass the human review gate.
// (Kept in sync with packages/mcp/src/catalog.ts.)
const REVIEW_GATED_OPERATIONS: ReadonlyArray<[family: string, method: string]> = [
  ["reconciliation", "autoApply"],
  ["reconciliation", "approveMatch"],
  ["tax", "generatePackage"],
  ["agents", "runPortalTask"],
];

/** Upper bound on a single execution, regardless of caller-supplied timeout. */
const MAX_TIMEOUT_MS = 5_000;

// Source that rebuilds the facade in-realm, replaces review-gated methods with
// ones that throw, then deeply freezes the facade so a snippet can neither call
// gated operations nor reassign them to bypass the gate.
const SANDBOX_SETUP_SOURCE = `
  globalThis.sona = ${FACADE_FACTORY_SOURCE};
  for (const [family, method] of ${JSON.stringify(REVIEW_GATED_OPERATIONS)}) {
    globalThis.sona[family][method] = function () {
      throw new Error(
        "sona." + family + "." + method +
        " requires human review or policy and is not callable from execute()",
      );
    };
  }
  for (const family of Object.keys(globalThis.sona)) {
    Object.freeze(globalThis.sona[family]);
  }
  Object.freeze(globalThis.sona);
`;

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
      // Clamp the caller-controlled budget so a large value cannot block the
      // event loop for long (a custom runner receives the same raw value).
      const budgetMs = Math.min(Math.max(Math.trunc(timeoutMs), 1), MAX_TIMEOUT_MS);

      const context = createContext({});
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        runInContext(SANDBOX_SETUP_SOURCE, context, { timeout: budgetMs });

        // Strict-mode body so user `this` is undefined; the result and any error
        // are serialized to JSON *inside* the realm, so the host only ever
        // handles a primitive string (never live getters/Proxies/accessors).
        // All error-property reads happen inside the guarded block, so a hostile
        // throwing getter is caught here and never reaches the host.
        const wrapped = `(async function () {
          "use strict";
          try {
            const __value = await (async () => { ${code}\n })();
            return JSON.stringify({ ok: true, value: __value === undefined ? null : __value });
          } catch (err) {
            let name = "Error";
            let message = "Error";
            try {
              if (err && typeof err === "object") {
                if (typeof err.name === "string") name = err.name;
                message = "message" in err ? String(err.message) : String(err);
              } else {
                message = String(err);
              }
            } catch { /* keep bounded defaults */ }
            return JSON.stringify({ ok: false, error: { name, message } });
          }
        })()`;

        const execution = runInContext(wrapped, context, { timeout: budgetMs }) as Promise<string>;
        const deadline = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Execution timed out")), budgetMs);
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
