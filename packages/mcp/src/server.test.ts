import { describe, expect, it } from "vitest";
import { runSonaTool, SONA_TOOLS } from "./server";

describe("MCP tool surface", () => {
  it("exposes exactly docs, search, and execute", () => {
    expect(SONA_TOOLS.map((t) => t.name)).toEqual(["docs", "search", "execute"]);
  });

  it("dispatches search through runSonaTool", async () => {
    const result = (await runSonaTool("search", { query: "tax" })) as { results: unknown[] };
    expect(Array.isArray(result.results)).toBe(true);
    expect(result.results.length).toBeGreaterThan(0);
  });

  it("validates input and rejects unknown tools", async () => {
    await expect(runSonaTool("execute", { code: 123 })).rejects.toThrow();
    await expect(runSonaTool("does-not-exist", {})).rejects.toThrow(/Unknown tool/);
  });
});
