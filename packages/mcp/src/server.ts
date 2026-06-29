/**
 * The public MCP tool surface: exactly three flat tools — `docs`, `search`,
 * and `execute` — over the typed `sona.*` facade. This mirrors the code-mode
 * approach: a tiny tool surface plus a typed backend catalog, instead of one
 * MCP tool per backend operation.
 *
 * Tools are defined transport-agnostically as {@link SonaTool} descriptors with
 * zod input schemas, so they can be mounted on any MCP transport. Wiring these
 * onto a `@modelcontextprotocol/sdk` stdio server is a thin follow-up (remote
 * deployment is intentionally out of scope for this phase).
 */
import { z } from "zod";
import { getDocs } from "./tools/docs";
import { execute } from "./tools/execute";
import { searchCatalog } from "./tools/search";

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

export const SONA_TOOLS: readonly SonaTool[] = [
  defineTool({
    name: "docs",
    description: "Return Sona's product boundary, safety rules, and available facade families.",
    inputSchema: z.object({}),
    handler: async () => getDocs(),
  }),
  defineTool({
    name: "search",
    description: "Search the reviewed sona.* function catalog by keyword.",
    inputSchema: z.object({ query: z.string().default("") }),
    handler: async ({ query }) => searchCatalog(query),
  }),
  defineTool({
    name: "execute",
    description:
      "Run code against the typed sona.* facade, e.g. `return await sona.sources.list();`.",
    inputSchema: z.object({ code: z.string(), timeoutMs: z.number().int().positive().optional() }),
    handler: async (input) => execute(input),
  }),
];

/**
 * Validates `rawInput` against the named tool's schema and runs it. Throws on an
 * unknown tool name; input validation errors surface as zod errors.
 */
export async function runSonaTool(name: string, rawInput: unknown): Promise<unknown> {
  const tool = SONA_TOOLS.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return tool.run(rawInput);
}
