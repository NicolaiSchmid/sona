import { describe, expect, it } from "vitest";
import { CATALOG, FAMILIES, RISK_LABELS } from "./catalog";
import { searchCatalog } from "./tools/search";

describe("catalog", () => {
  it("every entry has a path, description, schema, and a valid risk", () => {
    for (const entry of CATALOG) {
      expect(entry.path.startsWith("sona.")).toBe(true);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.inputSchema).toBeDefined();
      expect(RISK_LABELS).toContain(entry.risk);
    }
  });

  it("exposes the expected facade families", () => {
    expect(FAMILIES).toEqual(
      expect.arrayContaining(["sources", "receipts", "reconciliation", "ledger", "tax", "agents"]),
    );
  });
});

describe("searchCatalog", () => {
  it("finds receipt functions", () => {
    const { results } = searchCatalog("receipt");
    expect(results.length).toBeGreaterThan(0);
    expect(
      results.every((r) => `${r.path} ${r.description}`.toLowerCase().includes("receipt")),
    ).toBe(true);
    expect(results.some((r) => r.path === "sona.receipts.ingestUpload")).toBe(true);
  });

  it("finds tax export functions", () => {
    const { results } = searchCatalog("tax export");
    expect(results.some((r) => r.path === "sona.tax.generatePackage")).toBe(true);
  });

  it("returns no results but still lists families for an unknown query", () => {
    const response = searchCatalog("nonexistent-capability-xyz");
    expect(response.results).toEqual([]);
    expect(response.families.length).toBeGreaterThan(0);
  });

  it("surfaces input field names and risk in results", () => {
    const { results } = searchCatalog("ingestUpload");
    const entry = results.find((r) => r.path === "sona.receipts.ingestUpload");
    expect(entry?.input).toEqual(["fileId"]);
    expect(entry?.risk).toBe("write_draft");
  });
});
