/**
 * The public MCP tool surface. The default surface is intentionally just two
 * read-only-ish tools — `docs` and `search` — over the typed `sona.*` facade.
 *
 * `execute` runs agent-authored code and is a dev/local harness, not a hardened
 * sandbox (see `./tools/execute.ts`). It is therefore OFF by default and only
 * included when a caller opts in via `createSonaTools({ enableExecute: true })`.
 *
 * Tools are defined transport-agnostically as {@link SonaTool} descriptors with
 * zod input schemas, so they can be mounted on any MCP transport. Wiring these
 * onto a `@modelcontextprotocol/sdk` stdio server is a thin follow-up (remote
 * deployment is intentionally out of scope for this phase).
 */
import { z } from "zod";
import { getDocs } from "./tools/docs.js";
import { execute } from "./tools/execute.js";
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

const docsTool = defineTool({
  name: "docs",
  description: "Return Sona's product boundary, safety rules, and available facade families.",
  inputSchema: z.object({}),
  handler: async () => getDocs(),
});

const searchTool = defineTool({
  name: "search",
  description: "Search the reviewed sona.* function catalog by keyword.",
  inputSchema: z.object({ query: z.string().default("") }),
  handler: async ({ query }) => searchCatalog(query),
});

const executeTool = defineTool({
  name: "execute",
  description:
    "Run code against the typed sona.* facade, e.g. `return await sona.sources.list();`.",
  inputSchema: z.object({ code: z.string(), timeoutMs: z.number().int().positive().optional() }),
  handler: async (input) => execute(input),
});

export interface CreateSonaToolsOptions {
  /**
   * Include the `execute` code-runner. OFF by default: it is a dev/local
   * harness and must not be exposed to untrusted input. See `./tools/execute`.
   */
  enableExecute?: boolean;
}

/** Builds the tool surface. Defaults to the safe `docs` + `search` tools only. */
export function createSonaTools(options: CreateSonaToolsOptions = {}): SonaTool[] {
  const tools = [docsTool, searchTool];
  if (options.enableExecute) {
    tools.push(executeTool);
  }
  return tools;
}

/** The default, safe public tool surface (no code execution). */
export const SONA_TOOLS: readonly SonaTool[] = createSonaTools();

/**
 * Validates `rawInput` against the named tool's schema and runs it. Pass a tool
 * list from {@link createSonaTools} to enable `execute`. Throws on an unknown
 * tool name; input validation errors surface as zod errors.
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
