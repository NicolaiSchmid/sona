import { describe, expect, it } from "vitest";
import { SAMPLE_POSTINGS } from "../export/fixtures.js";
import { ELSTER_DRAFT_MAPPING_PRIVATE_DE } from "../templates/elster-draft-de.js";
import { PRIVATE_DE_TEMPLATE } from "../templates/private-de.js";
import { generateElsterDraft } from "./mapping.js";
import { ELSTER_DRAFT_BANNER, renderElsterDraftJson, renderElsterDraftMarkdown } from "./render.js";

const draft = generateElsterDraft({
  year: 2026,
  postings: SAMPLE_POSTINGS,
  template: PRIVATE_DE_TEMPLATE,
  mapping: ELSTER_DRAFT_MAPPING_PRIVATE_DE,
});
const markdown = renderElsterDraftMarkdown(draft);
const json = renderElsterDraftJson(draft);

/** Wording that would turn a preparation aid into a legal claim or a filing. */
const FORBIDDEN = [
  /deductible/i,
  /absetzbar/i,
  /submitted/i,
  /transmitted to elster/i,
  /files your/i,
  /guaranteed/i,
  /tax advice:/i,
];

describe("renderElsterDraftMarkdown", () => {
  it("opens with the not-a-submission / not-tax-advice banner", () => {
    for (const line of ELSTER_DRAFT_BANNER) {
      expect(markdown).toContain(line);
    }
    expect(markdown).toContain("NOT A SUBMISSION");
    expect(markdown).toContain("NOT TAX ADVICE");
    expect(markdown.indexOf("NOT A SUBMISSION")).toBeLessThan(markdown.indexOf("## "));
  });

  it("uses prepared/review wording and makes no legal claims", () => {
    expect(markdown).toContain("Prepared total (review required)");
    expect(markdown).toContain("Suggested grouping");
    // The banner itself may mention deductibility only to deny deciding it.
    const body = markdown
      .split("\n")
      .filter((line) => !line.startsWith("> "))
      .join("\n");
    for (const pattern of FORBIDDEN) {
      expect(body, `forbidden wording ${pattern}`).not.toMatch(pattern);
    }
  });

  it("renders every grouping with total, lines, posting ids, and evidence", () => {
    expect(markdown).toContain("## Anlage V — Rental expenses (prepared)");
    expect(markdown).toContain("-500.00 EUR");
    expect(markdown).toContain("p_maint / t_maint");
    expect(markdown).toContain("p_depr / t_depr");
    expect(markdown).toContain("doc_2");
    expect(markdown).toContain("⚠ missing evidence");
  });

  it("renders the unmapped block and the exclusion list", () => {
    expect(markdown).toContain("## Unmapped — review required");
    expect(markdown).toContain("Tax advice expenses (tax_advice): -200.00 EUR");
    expect(markdown).toContain("## Excluded from this draft: 3 posting(s)");
    expect(markdown).toContain("- p_donation:");
    expect(markdown).not.toContain("Charity donation");
  });

  it("escapes pipes and newlines so table rows stay intact", () => {
    const rendered = renderElsterDraftMarkdown({
      ...draft,
      groups: [
        {
          ...(draft.groups[0] ?? {
            groupId: "g",
            anlage: "A",
            lineLabel: "L",
            description: "d",
            totals: [],
            lines: [],
          }),
          lines: [
            {
              exportLineId: "p",
              postingId: "p",
              transactionId: "t",
              date: "2026-01-01",
              description: "a | b\nc",
              amount: "1.00",
              currency: "EUR",
              account: "Income:Rental",
              sectionId: "rental_property",
              reviewState: "user_reviewed",
              evidenceDocumentIds: [],
              flags: [],
            },
          ],
        },
      ],
    });
    expect(rendered).toContain("| a \\| b c |");
  });
});

describe("renderElsterDraftJson", () => {
  it("is parseable and carries the banner plus the full trace", () => {
    const parsed = JSON.parse(json) as {
      notice: string[];
      year: number;
      groups: Array<{ groupId: string; lines: Array<{ postingId: string }> }>;
      excluded: Array<{ postingId: string }>;
    };
    expect(parsed.notice).toEqual([...ELSTER_DRAFT_BANNER]);
    expect(parsed.year).toBe(2026);
    expect(
      parsed.groups.find((g) => g.groupId === "anlage_v_expenses")?.lines.map((l) => l.postingId),
    ).toEqual(["p_maint"]);
    expect(parsed.excluded.map((e) => e.postingId)).toContain("p_draft");
  });
});
