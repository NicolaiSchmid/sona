import { describe, expect, it } from "vitest";
import { SAMPLE_POSTINGS } from "../export/fixtures.js";
import type { TaxPostingInput } from "../export/types.js";
import { ELSTER_DRAFT_MAPPING_PRIVATE_DE } from "../templates/elster-draft-de.js";
import { PRIVATE_DE_TEMPLATE } from "../templates/private-de.js";
import {
  generateElsterDraft,
  groupForLine,
  mappingCoversYear,
  totalsByCurrency,
} from "./mapping.js";
import type { ElsterDraftMapping } from "./types.js";

const T = PRIVATE_DE_TEMPLATE;
const M = ELSTER_DRAFT_MAPPING_PRIVATE_DE;

const RENTAL_INCOME: TaxPostingInput = {
  postingId: "p_rent_jan",
  transactionId: "t_rent_jan",
  date: "2026-01-03",
  description: "Rent January",
  amount: "950.00",
  commodity: "EUR",
  account: "Income:Rental:Flat",
  reviewState: "advisor_reviewed",
  evidenceDocumentIds: ["doc_lease"],
};

const RENTAL_INCOME_USD: TaxPostingInput = {
  ...RENTAL_INCOME,
  postingId: "p_rent_usd",
  transactionId: "t_rent_usd",
  amount: "100.00",
  commodity: "USD",
};

const OTHER_YEAR: TaxPostingInput = {
  ...RENTAL_INCOME,
  postingId: "p_rent_2025",
  transactionId: "t_rent_2025",
  date: "2025-12-30",
};

function draft(postings: readonly TaxPostingInput[], mapping: ElsterDraftMapping = M) {
  return generateElsterDraft({ year: 2026, postings, template: T, mapping });
}

function group(d: ReturnType<typeof draft>, id: string) {
  const found = d.groups.find((g) => g.groupId === id);
  if (found === undefined) {
    throw new Error(`missing group ${id}`);
  }
  return found;
}

describe("generateElsterDraft review gate", () => {
  const d = draft([...SAMPLE_POSTINGS, RENTAL_INCOME]);
  const includedIds = d.groups.flatMap((g) => g.lines.map((l) => l.postingId));
  const unmappedIds = d.unmapped.flatMap((s) => s.lines.map((l) => l.postingId));

  it("requires user_reviewed or stronger", () => {
    expect(d.requiredReviewState).toBe("user_reviewed");
    expect(includedIds).toContain("p_maint"); // user_reviewed
    expect(includedIds).toContain("p_rent_jan"); // advisor_reviewed
    expect(includedIds).not.toContain("p_donation"); // suggested
    expect(includedIds).not.toContain("p_draft"); // draft
    expect(unmappedIds).not.toContain("p_donation");
    expect(unmappedIds).not.toContain("p_draft");
  });

  it("lists every gated-out posting with a reason", () => {
    const reasons = new Map(d.excluded.map((e) => [e.postingId, e.reason]));
    expect(reasons.get("p_donation")).toContain('"suggested"');
    expect(reasons.get("p_draft")).toContain('"draft"');
    expect(reasons.get("p_groceries")).toContain("below required");
  });

  it("keeps postings from other years out and says so", () => {
    const other = draft([OTHER_YEAR, RENTAL_INCOME]);
    expect(other.groups.flatMap((g) => g.lines).map((l) => l.postingId)).toEqual(["p_rent_jan"]);
    expect(other.excluded).toContainEqual({
      postingId: "p_rent_2025",
      reason: "dated 2025-12-30, outside tax year 2026",
    });
  });
});

describe("generateElsterDraft mapping", () => {
  const d = draft([...SAMPLE_POSTINGS, RENTAL_INCOME]);

  it("splits the rental section into income and expense groupings by account", () => {
    expect(group(d, "anlage_v_income").lines.map((l) => l.postingId)).toEqual(["p_rent_jan"]);
    expect(group(d, "anlage_v_expenses").lines.map((l) => l.postingId)).toEqual(["p_maint"]);
    expect(group(d, "anlage_v_depreciation").lines.map((l) => l.postingId)).toEqual(["p_depr"]);
  });

  it("sums exactly per grouping", () => {
    expect(group(d, "anlage_v_income").totals).toEqual([{ currency: "EUR", amount: "950.00" }]);
    expect(group(d, "anlage_v_expenses").totals).toEqual([{ currency: "EUR", amount: "-500.00" }]);
  });

  it("renders configured groups without lines as empty rather than dropping them", () => {
    const donations = group(d, "sonderausgaben_donations");
    expect(donations.lines).toEqual([]);
    expect(donations.totals).toEqual([]);
  });

  it("puts reviewed lines of unmapped sections into the review block", () => {
    expect(d.unmapped.map((s) => s.sectionId)).toEqual(["tax_advice"]);
    const taxAdvice = d.unmapped[0];
    expect(taxAdvice?.lines.map((l) => l.postingId)).toEqual(["p_taxadvice"]);
    expect(taxAdvice?.totals).toEqual([{ currency: "EUR", amount: "-200.00" }]);
  });

  it("traces every line to its posting, transaction, and evidence", () => {
    for (const line of [...d.groups, ...d.unmapped].flatMap((g) => g.lines)) {
      const posting = [...SAMPLE_POSTINGS, RENTAL_INCOME].find(
        (p) => p.postingId === line.postingId,
      );
      expect(posting).toBeDefined();
      expect(line.exportLineId).toBe(posting?.postingId);
      expect(line.transactionId).toBe(posting?.transactionId);
      expect(line.evidenceDocumentIds).toEqual(posting?.evidenceDocumentIds);
    }
  });

  it("flags lines whose section requires evidence but none is linked", () => {
    const maint = group(d, "anlage_v_expenses").lines[0];
    expect(maint?.flags).toEqual(["missing evidence"]);
    const depr = group(d, "anlage_v_depreciation").lines[0];
    expect(depr?.flags).toEqual([]);
  });

  it("never sums across currencies", () => {
    const mixed = draft([RENTAL_INCOME, RENTAL_INCOME_USD]);
    expect(group(mixed, "anlage_v_income").totals).toEqual([
      { currency: "EUR", amount: "950.00" },
      { currency: "USD", amount: "100.00" },
    ]);
  });

  it("is driven by the mapping: a user mapping moves sections between groupings", () => {
    const custom: ElsterDraftMapping = {
      id: "custom",
      templateId: T.id,
      version: 3,
      minTaxYear: 2026,
      groups: [
        {
          id: "everything_rental",
          anlage: "Anlage V",
          lineLabel: "All rental lines (prepared)",
          description: "custom",
          sectionIds: ["rental_property", "depreciation", "tax_advice"],
        },
      ],
    };
    const c = draft([...SAMPLE_POSTINGS, RENTAL_INCOME], custom);
    expect(c.mappingId).toBe("custom");
    expect(c.mappingVersion).toBe(3);
    expect(
      group(c, "everything_rental")
        .lines.map((l) => l.postingId)
        .sort(),
    ).toEqual(["p_depr", "p_maint", "p_rent_jan", "p_taxadvice"]);
    expect(c.unmapped).toEqual([]);
  });

  it("refuses a mapping configured for another template or year", () => {
    expect(() => draft([], { ...M, templateId: "other" })).toThrow(/configured for template/);
    expect(() => draft([], { ...M, minTaxYear: 2027 })).toThrow(/does not cover tax year 2026/);
    expect(() => draft([], { ...M, maxTaxYear: 2025 })).toThrow(/does not cover tax year 2026/);
  });
});

describe("helpers", () => {
  it("mappingCoversYear honours the inclusive bounds", () => {
    const m = { ...M, minTaxYear: 2025, maxTaxYear: 2026 };
    expect(mappingCoversYear(m, 2024)).toBe(false);
    expect(mappingCoversYear(m, 2025)).toBe(true);
    expect(mappingCoversYear(m, 2026)).toBe(true);
    expect(mappingCoversYear(m, 2027)).toBe(false);
  });

  it("groupForLine applies section and account refinement in order", () => {
    expect(groupForLine(M, { sectionId: "rental_property", account: "Income:Rental" })?.id).toBe(
      "anlage_v_income",
    );
    expect(
      groupForLine(M, { sectionId: "rental_property", account: "Expenses:RealEstate:Repairs" })?.id,
    ).toBe("anlage_v_expenses");
    expect(groupForLine(M, { sectionId: "uncategorized", account: "Expenses:X" })).toBeUndefined();
  });

  it("totalsByCurrency sums exactly", () => {
    expect(
      totalsByCurrency([
        { amount: "0.10", currency: "EUR" },
        { amount: "0.20", currency: "EUR" },
        { amount: "-0.05", currency: "EUR" },
      ]),
    ).toEqual([{ currency: "EUR", amount: "0.25" }]);
  });
});
