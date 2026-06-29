/**
 * `docs` returns the product boundary and safety rules an agent must respect
 * before operating Sona, plus the list of available facade families.
 */
import { FAMILIES } from "../catalog.js";

export interface DocsResponse {
  productBoundary: string;
  families: readonly string[];
  safetyRules: string[];
  /** Human-readable rendering, suitable as MCP tool text output. */
  text: string;
}

const PRODUCT_BOUNDARY =
  "Sona is a personal tax backoffice for private individuals. It automates backoffice " +
  "preparation: reconciliation, evidence management, depreciation, and tax-ready exports. " +
  "It does not decide tax law, give individualized tax advice, submit tax returns, or " +
  "initiate payments.";

const SAFETY_RULES = [
  "AI may suggest classifications, matches, and export mappings; humans approve tax-relevant decisions.",
  "No automatic ELSTER submission.",
  "No payment initiation.",
  "Bank and portal access is read-only by default.",
  "Tax-relevant or high-value uncertain matches must enter a review queue.",
  "Never expose secrets, credentials, or raw backend paths in outputs.",
];

export function getDocs(): DocsResponse {
  const text = [
    "# Sona code-mode MCP",
    "",
    PRODUCT_BOUNDARY,
    "",
    "## Available families",
    ...FAMILIES.map((family) => `- sona.${family}.*`),
    "",
    "## Safety rules",
    ...SAFETY_RULES.map((rule) => `- ${rule}`),
    "",
    "Use `search` to discover operations, then `execute` to run code against the typed `sona.*` facade.",
  ].join("\n");

  return {
    productBoundary: PRODUCT_BOUNDARY,
    families: FAMILIES,
    safetyRules: SAFETY_RULES,
    text,
  };
}
