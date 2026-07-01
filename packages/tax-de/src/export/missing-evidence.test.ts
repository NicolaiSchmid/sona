import { describe, expect, it } from "vitest";
import { PRIVATE_DE_TEMPLATE } from "../templates/private-de.js";
import { SAMPLE_POSTINGS } from "./fixtures.js";
import { generateMissingEvidenceReport } from "./missing-evidence.js";

describe("generateMissingEvidenceReport", () => {
  const rows = generateMissingEvidenceReport(SAMPLE_POSTINGS, PRIVATE_DE_TEMPLATE);
  const ids = rows.map((r) => r.postingId);

  it("includes a receipt-required posting with no evidence", () => {
    expect(ids).toContain("p_maint"); // RealEstate:Maintenance, no evidence
    expect(ids).toContain("p_donation"); // Donations, no evidence
  });

  it("omits postings that already have evidence", () => {
    expect(ids).not.toContain("p_taxadvice"); // has doc_1
    expect(ids).not.toContain("p_depr"); // has doc_2
  });

  it("omits postings in sections that don't require receipts", () => {
    // Groceries is uncategorized (receiptRequired false), WorkRelated too.
    expect(ids).not.toContain("p_groceries");
    expect(ids).not.toContain("p_draft");
  });
});
