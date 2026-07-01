import { describe, expect, it } from "vitest";
import { PRIVATE_DE_TEMPLATE } from "../templates/private-de.js";
import { SAMPLE_POSTINGS } from "./fixtures.js";
import { generateExportLines, sectionForAccount } from "./generate.js";

const T = PRIVATE_DE_TEMPLATE;

describe("sectionForAccount", () => {
  it("maps real-estate maintenance to the rental property section", () => {
    expect(sectionForAccount(T, "Expenses:RealEstate:Maintenance").id).toBe("rental_property");
  });

  it("maps tax advice and depreciation to their own sections", () => {
    expect(sectionForAccount(T, "Expenses:TaxAdvice").id).toBe("tax_advice");
    expect(sectionForAccount(T, "Expenses:RealEstate:Depreciation").id).toBe("depreciation");
  });

  it("falls back to uncategorized for an unrecognized account", () => {
    expect(sectionForAccount(T, "Expenses:Groceries").id).toBe(T.uncategorizedSectionId);
  });
});

describe("generateExportLines review gate", () => {
  it("draft mode includes suggested and stronger, excludes raw drafts", () => {
    const { lines, excluded } = generateExportLines(SAMPLE_POSTINGS, T, { mode: "draft" });
    const includedIds = lines.map((l) => l.sourcePostingId);
    expect(includedIds).toContain("p_donation"); // suggested
    expect(includedIds).toContain("p_taxadvice"); // user_reviewed
    expect(includedIds).not.toContain("p_draft"); // draft state excluded
    expect(excluded.map((e) => e.postingId)).toContain("p_draft");
  });

  it("final mode requires user_reviewed or stronger", () => {
    const { lines } = generateExportLines(SAMPLE_POSTINGS, T, { mode: "final" });
    const includedIds = lines.map((l) => l.sourcePostingId);
    expect(includedIds).toContain("p_taxadvice"); // user_reviewed
    expect(includedIds).not.toContain("p_donation"); // only suggested
    expect(includedIds).not.toContain("p_groceries"); // only suggested
  });

  it("flags receipt-required lines without evidence", () => {
    const { lines } = generateExportLines(SAMPLE_POSTINGS, T, { mode: "final" });
    const maint = lines.find((l) => l.sourcePostingId === "p_maint");
    expect(maint?.notes).toBe("missing evidence");
    const taxAdvice = lines.find((l) => l.sourcePostingId === "p_taxadvice");
    expect(taxAdvice?.notes).toBeUndefined();
  });

  it("keeps every line traceable to its posting and evidence", () => {
    const { lines } = generateExportLines(SAMPLE_POSTINGS, T, { mode: "final" });
    const depr = lines.find((l) => l.sourcePostingId === "p_depr");
    expect(depr?.sourceTransactionId).toBe("t_depr");
    expect(depr?.evidenceDocumentIds).toEqual(["doc_2"]);
    expect(depr?.sectionId).toBe("depreciation");
  });
});
