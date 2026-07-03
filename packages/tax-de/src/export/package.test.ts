import { describe, expect, it } from "vitest";
import { PRIVATE_DE_TEMPLATE } from "../templates/private-de.js";
import { SAMPLE_POSTINGS } from "./fixtures.js";
import { generateExportPackage, PACKAGE_FILES } from "./package.js";
import type { TaxPostingInput } from "./types.js";

/** Asserts a fixture element exists (keeps tests free of non-null assertions). */
function basePosting(): TaxPostingInput {
  const first = SAMPLE_POSTINGS[0];
  if (first === undefined) {
    throw new Error("missing fixture posting");
  }
  return first;
}

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

  it("keeps category rows joinable to their postings and evidence", () => {
    const csv = byPath.get("tax-categories.csv") ?? "";
    const header = csv.split("\n")[0] ?? "";
    expect(header).toContain("postingId");
    expect(header).toContain("transactionId");
    expect(header).toContain("evidenceDocumentIds");
    expect(csv).toContain("p_taxadvice");
    expect(csv).toContain("doc_1");
  });

  it("excludes postings from other tax years", () => {
    const mixed = [
      ...SAMPLE_POSTINGS,
      {
        ...basePosting(),
        postingId: "p_2025",
        transactionId: "t_2025",
        date: "2025-11-30",
      },
    ];
    const p = generateExportPackage({
      year: 2026,
      postings: mixed,
      template: PRIVATE_DE_TEMPLATE,
      mode: "final",
    });
    const csv = p.files.find((f) => f.path === "tax-categories.csv")?.content ?? "";
    expect(csv).not.toContain("p_2025");
  });

  it("applies the review gate to the missing-evidence file in final mode", () => {
    // p_donation is receipt-required with no evidence but only `suggested`,
    // so a final package must not report it (it isn't in the export at all).
    expect(byPath.get("missing-evidence.csv")).not.toContain("p_donation");
    // p_maint is user_reviewed and missing evidence → reported.
    expect(byPath.get("missing-evidence.csv")).toContain("p_maint");
  });

  it("neutralizes spreadsheet formula injection in text fields", () => {
    const p = generateExportPackage({
      year: 2026,
      postings: [
        {
          ...basePosting(),
          postingId: "p_evil",
          description: '=HYPERLINK("http://evil","x")',
        },
      ],
      template: PRIVATE_DE_TEMPLATE,
      mode: "final",
    });
    const csv = p.files.find((f) => f.path === "tax-categories.csv")?.content ?? "";
    expect(csv).toContain("'=HYPERLINK");
    // Signed decimal amounts survive untouched.
    expect(csv).toContain("-500.00");
  });
});
