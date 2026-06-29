/**
 * `search` inspects the reviewed function catalog so an agent can discover which
 * `sona.*` operations exist before writing code for the `execute` tool.
 */
import { z } from "zod";
import { CATALOG, type CatalogEntry, FAMILIES, type RiskLabel } from "../catalog.js";

export interface CatalogSearchResult {
  path: string;
  family: string;
  description: string;
  risk: RiskLabel;
  /** Names of the operation's input fields. */
  input: string[];
}

export interface CatalogSearchResponse {
  query: string;
  results: CatalogSearchResult[];
  /** Always returned so an agent can orient even when nothing matched. */
  families: readonly string[];
}

function inputFields(schema: CatalogEntry["inputSchema"]): string[] {
  return schema instanceof z.ZodObject ? Object.keys(schema.shape) : [];
}

function toResult(entry: CatalogEntry): CatalogSearchResult {
  return {
    path: entry.path,
    family: entry.family,
    description: entry.description,
    risk: entry.risk,
    input: inputFields(entry.inputSchema),
  };
}

/**
 * Returns catalog entries whose path or description match every whitespace-
 * separated term in the query (case-insensitive). An empty query returns the
 * whole catalog.
 */
export function searchCatalog(query: string): CatalogSearchResponse {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const results = CATALOG.filter((entry) => {
    const haystack = `${entry.path} ${entry.description}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  }).map(toResult);

  return { query, results, families: FAMILIES };
}
