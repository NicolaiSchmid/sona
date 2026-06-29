/**
 * @sona/mcp
 *
 * Code-mode MCP surface (docs/search/execute) over a typed sona.* facade.
 * Keeps internal backend paths private from the public agent interface.
 */

/** Package version marker, used to verify wiring and test discovery. */
export const sonaMcpVersion = "0.0.0" as const;

export { CATALOG, type CatalogEntry, FAMILIES, RISK_LABELS, type RiskLabel } from "./catalog";
export { createFacade, type SonaFacade } from "./facade";
export { runSonaTool, SONA_TOOLS, type SonaTool } from "./server";
export { type DocsResponse, getDocs } from "./tools/docs";
export { type ExecuteInput, type ExecuteResult, execute } from "./tools/execute";
export {
  type CatalogSearchResponse,
  type CatalogSearchResult,
  searchCatalog,
} from "./tools/search";
