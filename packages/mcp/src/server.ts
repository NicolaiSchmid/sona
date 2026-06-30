/**
 * The public MCP tool surface. The default surface is intentionally just two
 * tools — `docs` and `search` — over the typed `sona.*` facade.
 *
 * `execute` runs agent-authored code and is therefore NOT included by default.
 * It is only added when a caller supplies a {@link CodeRunner} via
 * `createSonaTools({ runner })`. For untrusted/networked input that runner MUST
 * be a true isolate; `createVmDevRunner` is local-dev only (see `./tools/execute`).
 *
 * Tools are defined transport-agnostically as {@link SonaTool} descriptors with
 * zod input schemas, so they can be mounted on any MCP transport. Wiring these
 * onto a `@modelcontextprotocol/sdk` stdio server is a thin follow-up (remote
 * deployment is intentionally out of scope for this phase).
 */
import { z } from "zod";
import { getDocs } from "./tools/docs.js";
import { type CodeRunner, execute } from "./tools/execute.js";
import { searchCatalog } from "./tools/search.js";

export interface SonaTool {
  name: string;
  description: string;
  /** Input schema, exposed so a transport can advertise/validate it. */
  inputSchema: z.ZodTypeAny;
  /** Validates raw input against the schema, then runs the tool. */
  run(rawInput: unknown): Promise<unknown>;
}

function defineTool<S extends z.ZodTypeAny>(def: {
  name: string;
  description: string;
  inputSchema: S;
  handler: (input: z.infer<S>) => Promise<unknown>;
}): SonaTool {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    run: (rawInput) => def.handler(def.inputSchema.parse(rawInput ?? {})),
  };
}

const searchTool = defineTool({
  name: "search",
  description: "Search the reviewed sona.* function catalog by keyword.",
  inputSchema: z.object({ query: z.string().default("") }),
  handler: async ({ query }) => searchCatalog(query),
});

export interface CreateSonaToolsOptions {
  /**
   * Execution backend for the `execute` tool. Omit to disable code execution
   * (the safe default). For untrusted input pass a true isolate; for local dev
   * pass `createVmDevRunner()`.
   */
  runner?: CodeRunner;
}

/** Builds the tool surface. Defaults to `docs` + `search`; no code execution. */
export function createSonaTools(options: CreateSonaToolsOptions = {}): SonaTool[] {
  const { runner } = options;
  const docsTool = defineTool({
    name: "docs",
    description: "Return Sona's product boundary, safety rules, and available facade families.",
    inputSchema: z.object({}),
    handler: async () => getDocs({ hasExecute: runner !== undefined }),
  });

  const tools = [docsTool, searchTool];

  if (runner) {
    tools.push(
      defineTool({
        name: "execute",
        description:
          "Run code against the typed sona.* facade, e.g. `return await sona.sources.list();`.",
        inputSchema: z.object({
          code: z.string(),
          // Bounded here so no runner receives an unbounded budget; each runner
          // additionally clamps to its own safe maximum.
          timeoutMs: z.number().int().positive().max(60_000).optional(),
        }),
        handler: async (input) => execute(input, runner),
      }),
    );
  }

  return tools;
}

/** The default, safe public tool surface (no code execution). */
export const SONA_TOOLS: readonly SonaTool[] = createSonaTools();

/**
 * Validates `rawInput` against the named tool's schema and runs it. Pass a tool
 * list from {@link createSonaTools} (with a `runner`) to enable `execute`.
 * Throws on an unknown tool name; input validation errors surface as zod errors.
 */
export async function runSonaTool(
  name: string,
  rawInput: unknown,
  tools: readonly SonaTool[] = SONA_TOOLS,
): Promise<unknown> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return tool.run(rawInput);
}
