import { describe, expect, it } from "vitest";
import { execute } from "./execute";

describe("execute", () => {
  it("runs facade calls and returns the value", async () => {
    const result = await execute({ code: "return await sona.sources.list();" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        { id: "src_demo_dkb", kind: "enable_banking", displayName: "DKB", status: "active" },
      ]);
    }
  });

  it("supports composing facade calls", async () => {
    const result = await execute({
      code: "const s = await sona.sources.sync({ sourceId: 'src_1' }); return s.status;",
    });
    expect(result).toEqual({ ok: true, value: "queued" });
  });

  it("blocks access to Node globals that are not in scope", async () => {
    const result = await execute({ code: "return typeof fetch;" });
    // `fetch` is omitted from the context, so it reads as undefined.
    expect(result).toEqual({ ok: true, value: "undefined" });
  });

  it("rejects code that tries to reach beyond the facade", async () => {
    const result = await execute({ code: "return process.env.SECRET;" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("ForbiddenAccessError");
      expect(result.error.message).toContain("process");
    }
  });

  it("normalizes thrown errors without leaking internals", async () => {
    const result = await execute({ code: "throw new Error('boom');" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("boom");
    }
  });

  it("normalizes calls to unknown facade members", async () => {
    const result = await execute({ code: "return await sona.nope.doThing();" });
    expect(result.ok).toBe(false);
  });
});
