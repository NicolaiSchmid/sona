import { describe, expect, it } from "vitest";
import { PRIVATE_DE_TEMPLATE } from "../templates/private-de.js";
import { SAMPLE_POSTINGS } from "./fixtures.js";
import { generateExportPackage, PACKAGE_FILES } from "./package.js";

describe("generateExportPackage", () => {
  const pkg = generateExportPackage({
    year: 2026,
    postings: SAMPLE_POSTINGS,
    template: PRIVATE_DE_TEMPLATE,
    mode: "final",
  });
  const byPath = new Map(pkg.files.map((f) => [f.path, f.content]));

  it("produces the expected manifest files", () => {
    expect(pkg.files.map((f) => f.path).sort()).toEqual([...PACKAGE_FILES].sort());
    expect(pkg.year).toBe(2026);
    expect(pkg.templateId).toBe("private-de");
  });

  it("writes reviewed lines into tax-categories.csv", () => {
    const csv = byPath.get("tax-categories.csv") ?? "";
    expect(csv.split("\n")[0]).toContain("date,description,amount");
    expect(csv).toContain("Expenses:TaxAdvice");
    // A suggested-only line must not appear in a final export.
    expect(csv).not.toContain("Charity donation");
  });

  it("lists missing evidence and parseable evidence links", () => {
    expect(byPath.get("missing-evidence.csv")).toContain("p_maint");
    const links = JSON.parse(byPath.get("evidence-links.json") ?? "[]") as Array<{
      postingId: string;
      documentIds: string[];
    }>;
    expect(
      links.some((l) => l.postingId === "p_taxadvice" && l.documentIds.includes("doc_1")),
    ).toBe(true);
  });

  it("includes the review disclaimer in the summary", () => {
    const summary = byPath.get("summary.md") ?? "";
    expect(summary.toLowerCase()).toContain("does not assert legal");
    expect(summary).toContain("2026");
  });
});
