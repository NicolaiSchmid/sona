import { describe, expect, it } from "vitest";
import { PRIVATE_DE_TEMPLATE } from "../templates/private-de.js";
import { SAMPLE_DEPRECIATION, SAMPLE_EQUIPMENT_DEPRECIATION, SAMPLE_POSTINGS } from "./fixtures.js";
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

  it("writes an empty depreciation schedule file when no assets are configured", () => {
    const csv = byPath.get("depreciation-schedules.csv") ?? "";
    expect(csv.split("\n")).toHaveLength(1);
    expect(csv).toContain("assetId,assetName,assetKind,year,configId,configVersion");
    expect(byPath.get("summary.md")).toContain("## Depreciation schedules: 0 row(s)");
  });

  it("adds traceable depreciation schedule rows and gates them like the ledger export", () => {
    const withAssets = (mode: "draft" | "final", year: number) =>
      generateExportPackage({
        year,
        postings: SAMPLE_POSTINGS,
        template: PRIVATE_DE_TEMPLATE,
        mode,
        depreciation: [SAMPLE_DEPRECIATION],
      });
    const final2026 = withAssets("final", 2026);
    const csv = final2026.files.find((f) => f.path === "depreciation-schedules.csv")?.content ?? "";
    const [header, row] = csv.split("\n");
    expect(header).toContain(
      "transactionId,postingIds,recordedAmount,recordedConfigVersion,evidenceDocumentIds,notes",
    );
    expect(row).toContain("asset_flat");
    expect(row).toContain("cfg_flat_v1");
    expect(row).toContain("t_depr");
    expect(row).toContain("p_depr;p_depr_accumulated");
    expect(row).toContain("6360.00");
    expect(row).toContain("user_reviewed");
    expect(row).toContain("configured rule");
    expect(final2026.files.find((f) => f.path === "summary.md")?.content).toContain(
      "## Depreciation schedules: 1 row(s)",
    );

    // 2025 is only a draft: absent from a final package, present (flagged) in a draft package.
    const final2025 = withAssets("final", 2025);
    expect(
      final2025.files.find((f) => f.path === "depreciation-schedules.csv")?.content.split("\n"),
    ).toHaveLength(1);
    const draft2025 = withAssets("draft", 2025);
    const draftCsv =
      draft2025.files.find((f) => f.path === "depreciation-schedules.csv")?.content ?? "";
    expect(draftCsv).toContain("depr:asset_flat:v1:2025");
    expect(draftCsv).toContain("review required");
  });

  it("merges schedule rows without evidence into missing-evidence.csv without duplicates", () => {
    const schedule = SAMPLE_DEPRECIATION.schedule;
    const noEvidence = {
      ...SAMPLE_DEPRECIATION,
      schedule: {
        ...schedule,
        rows: schedule.rows.map((r) => ({
          ...r,
          evidenceDocumentIds: [],
          missingEvidenceFor: ["asset:asset_flat", "side_cost:sc_notary"],
        })),
      },
    };
    // p_depr is user_reviewed with evidence in the ledger fixture, so the ledger
    // path reports nothing for it; the schedule path adds exactly one row.
    const p = generateExportPackage({
      year: 2026,
      postings: SAMPLE_POSTINGS,
      template: PRIVATE_DE_TEMPLATE,
      mode: "final",
      depreciation: [noEvidence],
    });
    const missing = p.files.find((f) => f.path === "missing-evidence.csv")?.content ?? "";
    expect(missing.split("\n").filter((l) => l.includes("p_depr"))).toHaveLength(1);
    expect(missing).toContain("asset:asset_flat");

    // If the ledger path already reports the posting, the schedule path does not repeat it.
    const stripped = SAMPLE_POSTINGS.map((posting) =>
      posting.postingId === "p_depr" ? { ...posting, evidenceDocumentIds: [] } : posting,
    );
    const p2 = generateExportPackage({
      year: 2026,
      postings: stripped,
      template: PRIVATE_DE_TEMPLATE,
      mode: "final",
      depreciation: [noEvidence],
    });
    const missing2 = p2.files.find((f) => f.path === "missing-evidence.csv")?.content ?? "";
    expect(missing2.split("\n").filter((l) => l.includes("p_depr"))).toHaveLength(1);
  });

  it("neutralizes formula injection in depreciation-schedules.csv text fields", () => {
    const p = generateExportPackage({
      year: 2026,
      postings: SAMPLE_POSTINGS,
      template: PRIVATE_DE_TEMPLATE,
      mode: "final",
      depreciation: [{ ...SAMPLE_DEPRECIATION, assetName: '=HYPERLINK("http://evil","x")' }],
    });
    const csv = p.files.find((f) => f.path === "depreciation-schedules.csv")?.content ?? "";
    const [, row] = csv.split("\n");
    expect(row).toBeDefined();
    expect(row).toContain("'=HYPERLINK");
    expect(row).not.toMatch(/(^|,)=HYPERLINK/);
    // Numeric columns are untouched by the escaping.
    expect(row).toContain(",318000.00,");
    expect(row).toContain(",6360.00,");
  });

  it("writes one depreciation row per asset and none for a year before acquisition", () => {
    const both = generateExportPackage({
      year: 2026,
      postings: SAMPLE_POSTINGS,
      template: PRIVATE_DE_TEMPLATE,
      mode: "final",
      depreciation: [SAMPLE_DEPRECIATION, SAMPLE_EQUIPMENT_DEPRECIATION],
    });
    const csv = both.files.find((f) => f.path === "depreciation-schedules.csv")?.content ?? "";
    const lines = csv.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.filter((l) => l.startsWith("asset_flat,"))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("asset_workstation,"))).toHaveLength(1);
    expect(lines[2]).toContain("cfg_workstation_v1");
    expect(lines[2]).toContain("t_depr_workstation");
    expect(lines[2]).toContain("p_depr_workstation;p_depr_workstation_accumulated");
    expect(both.files.find((f) => f.path === "summary.md")?.content).toContain(
      "## Depreciation schedules: 2 row(s)",
    );

    // Neither asset had entered service in 2023: nothing to schedule, nothing to export.
    const before = generateExportPackage({
      year: 2023,
      postings: [],
      template: PRIVATE_DE_TEMPLATE,
      mode: "draft",
      depreciation: [SAMPLE_DEPRECIATION, SAMPLE_EQUIPMENT_DEPRECIATION],
    });
    expect(
      before.files.find((f) => f.path === "depreciation-schedules.csv")?.content.split("\n"),
    ).toHaveLength(1);
    expect(before.files.find((f) => f.path === "summary.md")?.content).toContain(
      "## Depreciation schedules: 0 row(s)",
    );
  });

  it("lists scheduled years left out of a final package in the summary", () => {
    const p = generateExportPackage({
      year: 2025,
      postings: SAMPLE_POSTINGS,
      template: PRIVATE_DE_TEMPLATE,
      mode: "final",
      depreciation: [SAMPLE_DEPRECIATION],
    });
    const summary = p.files.find((f) => f.path === "summary.md")?.content ?? "";
    expect(summary).toContain("### Scheduled years left out of this final package: 1");
    expect(summary).toContain('- asset_flat 2025: review state "draft" below required');
    expect(summary).toContain("(depr:asset_flat:v1:2025)");
  });

  it("lists schedule evidence in the receipt manifest and evidence links", () => {
    const p = generateExportPackage({
      year: 2026,
      postings: SAMPLE_POSTINGS,
      template: PRIVATE_DE_TEMPLATE,
      mode: "final",
      depreciation: [SAMPLE_DEPRECIATION],
    });
    const manifest = p.files.find((f) => f.path === "receipt-manifest.csv")?.content ?? "";
    // doc_notary is referenced only by the schedule row, never by a ledger line.
    expect(manifest).toContain("doc_notary,p_depr,asset:asset_flat,depreciation");
    const links = JSON.parse(
      p.files.find((f) => f.path === "evidence-links.json")?.content ?? "[]",
    ) as Array<{ postingId: string; transactionId: string; documentIds: string[] }>;
    expect(links).toContainEqual({
      postingId: "p_depr",
      transactionId: "t_depr",
      documentIds: ["doc_2", "doc_notary"],
    });
  });

  it("writes recorded amount and version columns, leaving them empty for a planned year", () => {
    const final2026 = generateExportPackage({
      year: 2026,
      postings: SAMPLE_POSTINGS,
      template: PRIVATE_DE_TEMPLATE,
      mode: "final",
      depreciation: [SAMPLE_DEPRECIATION],
    });
    const [, recorded] = (
      final2026.files.find((f) => f.path === "depreciation-schedules.csv")?.content ?? ""
    ).split("\n");
    // status,transactionId,postingIds,recordedAmount,recordedConfigVersion,evidenceDocumentIds
    expect(recorded).toContain(
      ",user_reviewed,t_depr,p_depr;p_depr_accumulated,6360.00,1,doc_2;doc_notary,",
    );

    const draft2027 = generateExportPackage({
      year: 2027,
      postings: [],
      template: PRIVATE_DE_TEMPLATE,
      mode: "draft",
      depreciation: [SAMPLE_DEPRECIATION],
    });
    const [, planned] = (
      draft2027.files.find((f) => f.path === "depreciation-schedules.csv")?.content ?? ""
    ).split("\n");
    expect(planned).toContain(",not_generated,,,,,doc_2;doc_notary,");
  });

  it("lists a shared document once per referencing record in the manifest and links", () => {
    // doc_2 substantiates both the ledger posting p_depr and the schedule row
    // that points at the same posting, so it is listed under each reference.
    const p = generateExportPackage({
      year: 2026,
      postings: SAMPLE_POSTINGS,
      template: PRIVATE_DE_TEMPLATE,
      mode: "final",
      depreciation: [SAMPLE_DEPRECIATION],
    });
    const manifest = (p.files.find((f) => f.path === "receipt-manifest.csv")?.content ?? "").split(
      "\n",
    );
    expect(manifest.filter((l) => l.startsWith("doc_2,"))).toEqual([
      "doc_2,p_depr,Expenses:RealEstate:Depreciation,depreciation",
      "doc_2,p_depr,asset:asset_flat,depreciation",
    ]);
    const links = JSON.parse(
      p.files.find((f) => f.path === "evidence-links.json")?.content ?? "[]",
    ) as Array<{ postingId: string; transactionId: string; documentIds: string[] }>;
    expect(links.filter((l) => l.postingId === "p_depr")).toEqual([
      { postingId: "p_depr", transactionId: "t_depr", documentIds: ["doc_2"] },
      { postingId: "p_depr", transactionId: "t_depr", documentIds: ["doc_2", "doc_notary"] },
    ]);
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
