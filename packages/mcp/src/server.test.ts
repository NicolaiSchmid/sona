import { describe, expect, it } from "vitest";
import { createSonaTools, runSonaTool, SONA_TOOLS } from "./server.js";
import { createVmDevRunner } from "./tools/execute.js";

describe("MCP tool surface", () => {
  it("defaults to the safe docs + search tools, with no code execution", () => {
    expect(SONA_TOOLS.map((t) => t.name)).toEqual(["docs", "search"]);
  });

  it("includes execute only when a runner is supplied", () => {
    const tools = createSonaTools({ runner: createVmDevRunner() });
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

  it("runs execute when given a runner-enabled tool list", async () => {
    const tools = createSonaTools({ runner: createVmDevRunner() });
    const result = (await runSonaTool("execute", { code: "return 1 + 1;" }, tools)) as {
      ok: boolean;
      value: unknown;
    };
    expect(result).toEqual({ ok: true, value: 2 });
  });

  it("advertises execute in docs only when it is enabled", async () => {
    const defaultDocs = (await runSonaTool("docs", {})) as { text: string };
    expect(defaultDocs.text).toContain("`execute` tool is disabled");

    const enabled = createSonaTools({ runner: createVmDevRunner() });
    const enabledDocs = (await runSonaTool("docs", {}, enabled)) as { text: string };
    expect(enabledDocs.text).toContain("then `execute`");
  });

  it("validates input and rejects unknown tools", async () => {
    await expect(runSonaTool("search", { query: 123 })).rejects.toThrow();
    await expect(runSonaTool("does-not-exist", {})).rejects.toThrow(/Unknown tool/);
  });
});
