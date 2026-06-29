/**
 * @sona/mcp
 *
 * Code-mode MCP surface (docs/search/execute) over a typed sona.* facade.
 * Keeps internal backend paths private from the public agent interface.
 */

/** Package version marker, used to verify wiring and test discovery. */
export const sonaMcpVersion = "0.0.0" as const;

export { CATALOG, type CatalogEntry, FAMILIES, RISK_LABELS, type RiskLabel } from "./catalog.js";
export { createFacade, type SonaFacade } from "./facade.js";
export {
  type CreateSonaToolsOptions,
  createSonaTools,
  runSonaTool,
  SONA_TOOLS,
  type SonaTool,
} from "./server.js";
export { type DocsResponse, getDocs } from "./tools/docs.js";
export {
  type CodeRunner,
  createVmDevRunner,
  type ExecuteInput,
  type ExecuteResult,
  execute,
} from "./tools/execute.js";
export {
  type CatalogSearchResponse,
  type CatalogSearchResult,
  searchCatalog,
} from "./tools/search.js";
