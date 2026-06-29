import { describe, expect, it } from "vitest";
import { createSonaTools, runSonaTool, SONA_TOOLS } from "./server.js";

describe("MCP tool surface", () => {
  it("defaults to the safe docs + search tools, with execute gated off", () => {
    expect(SONA_TOOLS.map((t) => t.name)).toEqual(["docs", "search"]);
  });

  it("includes execute only when explicitly enabled", () => {
    const tools = createSonaTools({ enableExecute: true });
    expect(tools.map((t) => t.name)).toEqual(["docs", "search", "execute"]);
  });

  it("dispatches search through runSonaTool", async () => {
    const result = (await runSonaTool("search", { query: "tax" })) as { results: unknown[] };
    expect(Array.isArray(result.results)).toBe(true);
    expect(result.results.length).toBeGreaterThan(0);
  });

  it("does not expose execute on the default surface", async () => {
    await expect(runSonaTool("execute", { code: "return 1;" })).rejects.toThrow(/Unknown tool/);
  });

  it("runs execute when given an execute-enabled tool list", async () => {
    const tools = createSonaTools({ enableExecute: true });
    const result = (await runSonaTool("execute", { code: "return 1 + 1;" }, tools)) as {
      ok: boolean;
      value: unknown;
    };
    expect(result).toEqual({ ok: true, value: 2 });
  });

  it("validates input and rejects unknown tools", async () => {
    await expect(runSonaTool("search", { query: 123 })).rejects.toThrow();
    await expect(runSonaTool("does-not-exist", {})).rejects.toThrow(/Unknown tool/);
  });
});
