import { describe, expect, it } from "vitest";
import { createVmDevRunner, execute } from "./execute.js";

const runner = createVmDevRunner();

describe("execute (dev vm runner)", () => {
  it("runs facade calls and returns the value", async () => {
    const result = await execute({ code: "return await sona.sources.list();" }, runner);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        { id: "src_demo_dkb", kind: "enable_banking", displayName: "DKB", status: "active" },
      ]);
    }
  });

  it("supports composing facade calls", async () => {
    const result = await execute(
      { code: "const s = await sona.sources.sync({ sourceId: 'src_1' }); return s.status;" },
      runner,
    );
    expect(result).toEqual({ ok: true, value: "queued" });
  });

  it("blocks Node globals that are not in scope", async () => {
    const result = await execute({ code: "return typeof fetch;" }, runner);
    expect(result).toEqual({ ok: true, value: "undefined" });
  });

  it("leaves `process` unreachable in the realm", async () => {
    const result = await execute({ code: "return process.env.SECRET;" }, runner);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("ReferenceError");
    }
  });

  it("does not reject ordinary data values that look like keywords", async () => {
    // A real id such as "import_2026" must not be blocked by a brittle deny-list.
    const result = await execute(
      { code: "return await sona.sources.sync({ sourceId: 'import_2026' });" },
      runner,
    );
    expect(result).toEqual({ ok: true, value: { sourceId: "import_2026", status: "queued" } });
  });

  it("disables review-gated operations so code cannot bypass the human gate", async () => {
    const result = await execute(
      { code: "return await sona.reconciliation.approveMatch({ candidateId: 'c1' });" },
      runner,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("requires human review");
    }
  });

  it("freezes the facade so a snippet cannot overwrite a gated method", async () => {
    const result = await execute(
      {
        code: "sona.reconciliation.approveMatch = async () => ({ approved: true }); return await sona.reconciliation.approveMatch({ candidateId: 'c1' });",
      },
      runner,
    );
    expect(result.ok).toBe(false);
  });

  it("still allows write-draft operations like ingestUpload", async () => {
    const result = await execute(
      { code: "return await sona.receipts.ingestUpload({ fileId: 'f1' });" },
      runner,
    );
    expect(result).toEqual({ ok: true, value: { documentId: "doc_f1", status: "queued" } });
  });

  it("normalizes thrown errors to a bounded name/message", async () => {
    const result = await execute({ code: "throw new Error('boom');" }, runner);
    expect(result).toEqual({ ok: false, error: { name: "Error", message: "boom" } });
  });

  it("returns a bounded failure when a thrown error has a hostile message getter", async () => {
    // The error is serialized inside the realm, so the host never invokes the
    // getter; String() of the getter is what crosses back.
    const result = await execute(
      { code: "throw { name: 'X', get message() { return 'safe'; } };" },
      runner,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("X");
      expect(result.error.message).toBe("safe");
    }
  });

  it("stays bounded when a thrown error's name getter throws", async () => {
    const result = await execute(
      { code: "throw { get name() { throw new Error('trap'); }, message: 'm' };" },
      runner,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The getter throws inside the realm; we fall back to bounded defaults.
      expect(result.error.name).toBe("Error");
    }
  });

  it("normalizes calls to unknown facade members", async () => {
    const result = await execute({ code: "return await sona.nope.doThing();" }, runner);
    expect(result.ok).toBe(false);
  });

  it("does not expose the sandbox-realm facade's host constructor", async () => {
    // Bypass the deny-list with concatenation; the in-realm facade has no host
    // constructor, so this stays inside the vm realm (process unreachable here).
    const result = await execute(
      { code: `return sona["constr"+"uctor"]["constr"+"uctor"]("return typeof pro"+"cess")();` },
      runner,
    );
    expect(result).toEqual({ ok: true, value: "undefined" });
  });

  it("runs the body in strict mode so `this` is not a host handle", async () => {
    const result = await execute({ code: "return typeof this;" }, runner);
    expect(result).toEqual({ ok: true, value: "undefined" });
  });

  it("bounds a synchronous infinite loop via the watchdog timeout", async () => {
    const result = await execute({ code: "while (true) {}", timeoutMs: 100 }, runner);
    expect(result.ok).toBe(false);
  });
});
