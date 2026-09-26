import { describe, expect, it } from "vitest";
import { generateDepreciationSection } from "./depreciation.js";
import { SAMPLE_DEPRECIATION, SAMPLE_EQUIPMENT_DEPRECIATION } from "./fixtures.js";

describe("generateDepreciationSection", () => {
  it("emits a traceable row for the export year in final mode when reviewed", () => {
    const { rows, excluded, missingEvidence } = generateDepreciationSection([SAMPLE_DEPRECIATION], {
      year: 2026,
      mode: "final",
    });
    expect(excluded).toEqual([]);
    expect(missingEvidence).toEqual([]);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      assetId: "asset_flat",
      assetName: "Synthetic flat",
      assetKind: "real_estate",
      year: 2026,
      scheduleConfigId: "cfg_flat_v1",
      scheduleVersion: 1,
      configuredMethod: "linear 2 % per year",
      monthsInService: 12,
      depreciableBasis: "318000.00",
      amount: "6360.00",
      currency: "EUR",
      transactionId: "t_depr",
      postingIds: ["p_depr", "p_depr_accumulated"],
      status: "user_reviewed",
      evidenceDocumentIds: ["doc_2", "doc_notary"],
    });
    expect(row?.notes).toContain("suggested amount from configured rule v1");
    expect(row?.notes).not.toContain("review required");
  });

  it("excludes unreviewed and not-yet-generated years from a final export", () => {
    const draftYear = generateDepreciationSection([SAMPLE_DEPRECIATION], {
      year: 2025,
      mode: "final",
    });
    expect(draftYear.rows).toEqual([]);
    expect(draftYear.excluded).toEqual([
      { assetId: "asset_flat", year: 2025, reason: expect.stringContaining('"draft"') },
    ]);

    const notGenerated = generateDepreciationSection([SAMPLE_DEPRECIATION], {
      year: 2027,
      mode: "final",
    });
    expect(notGenerated.rows).toEqual([]);
    expect(notGenerated.excluded[0]?.reason).toContain("no depreciation transaction");
  });

  it("lists planned rows in draft mode with their status and a review-required note", () => {
    const draft2025 = generateDepreciationSection([SAMPLE_DEPRECIATION], {
      year: 2025,
      mode: "draft",
    });
    expect(draft2025.rows[0]).toMatchObject({
      status: "draft",
      transactionId: "depr:asset_flat:v1:2025",
    });
    expect(draft2025.rows[0]?.notes).toContain("review required");

    const planned2027 = generateDepreciationSection([SAMPLE_DEPRECIATION], {
      year: 2027,
      mode: "draft",
    });
    expect(planned2027.rows[0]).toMatchObject({
      status: "not_generated",
      transactionId: undefined,
      postingIds: [],
      amount: "6360.00",
    });
    expect(planned2027.rows[0]?.notes).toContain("review required");
  });

  it("ignores superseded transactions when resolving a year's status", () => {
    const { rows } = generateDepreciationSection(
      [
        {
          ...SAMPLE_DEPRECIATION,
          transactions: [
            {
              year: 2026,
              transactionId: "t_old",
              postingIds: ["p_old"],
              reviewState: "superseded",
            },
          ],
        },
      ],
      { year: 2026, mode: "draft" },
    );
    expect(rows[0]?.status).toBe("not_generated");
    expect(rows[0]?.transactionId).toBeUndefined();
  });

  it("carries pro-rata notes and skips assets without a row for the year", () => {
    const { rows } = generateDepreciationSection([SAMPLE_DEPRECIATION], {
      year: 2024,
      mode: "draft",
    });
    expect(rows[0]?.monthsInService).toBe(6);
    expect(rows[0]?.notes).toContain("pro rata");
    expect(
      generateDepreciationSection([SAMPLE_DEPRECIATION], { year: 2000, mode: "draft" }).rows,
    ).toEqual([]);
  });

  it("reports rows without evidence in the missing-evidence shape", () => {
    const schedule = SAMPLE_DEPRECIATION.schedule;
    const noEvidence = {
      ...SAMPLE_DEPRECIATION,
      schedule: {
        ...schedule,
        rows: schedule.rows.map((r) => ({ ...r, evidenceDocumentIds: [] })),
      },
    };
    const reviewed = generateDepreciationSection([noEvidence], { year: 2026, mode: "final" });
    expect(reviewed.rows[0]?.notes).toContain("missing evidence");
    expect(reviewed.missingEvidence).toEqual([
      {
        postingId: "p_depr",
        transactionId: "t_depr",
        date: "2026-12-31",
        account: "asset:asset_flat",
        sectionId: "depreciation",
        amount: "6360.00",
        currency: "EUR",
      },
    ]);

    const planned = generateDepreciationSection([noEvidence], { year: 2027, mode: "draft" });
    expect(planned.missingEvidence[0]).toMatchObject({
      postingId: "schedule:cfg_flat_v1:2027",
      transactionId: "schedule:cfg_flat_v1:2027",
    });
  });

  it("treats a year whose only transaction is superseded as not generated in a final export", () => {
    const { rows, excluded } = generateDepreciationSection(
      [
        {
          ...SAMPLE_DEPRECIATION,
          transactions: [
            {
              year: 2026,
              transactionId: "t_old",
              postingIds: ["p_old"],
              reviewState: "superseded",
            },
          ],
        },
      ],
      { year: 2026, mode: "final" },
    );
    expect(rows).toEqual([]);
    expect(excluded).toEqual([
      { assetId: "asset_flat", year: 2026, reason: "no depreciation transaction generated yet" },
    ]);
  });

  it("emits one row per asset and keeps each asset's own schedule and transaction", () => {
    const { rows, excluded } = generateDepreciationSection(
      [SAMPLE_DEPRECIATION, SAMPLE_EQUIPMENT_DEPRECIATION],
      { year: 2026, mode: "final" },
    );
    expect(excluded).toEqual([]);
    expect(rows.map((r) => r.assetId)).toEqual(["asset_flat", "asset_workstation"]);
    const workstation = rows.find((r) => r.assetId === "asset_workstation");
    expect(workstation).toMatchObject({
      assetKind: "equipment",
      scheduleConfigId: "cfg_workstation_v1",
      configuredMethod: "linear over 3 years",
      monthsInService: 12,
      amount: "4000.00",
      transactionId: "t_depr_workstation",
      postingIds: ["p_depr_workstation", "p_depr_workstation_accumulated"],
      status: "user_reviewed",
      evidenceDocumentIds: ["doc_workstation_invoice"],
    });
    // The flat row is unchanged by the presence of a second asset.
    expect(rows.find((r) => r.assetId === "asset_flat")?.transactionId).toBe("t_depr");
  });

  it("gates each asset independently within one export", () => {
    // 2025: the flat has a draft transaction; the workstation has none yet.
    const { rows, excluded } = generateDepreciationSection(
      [SAMPLE_DEPRECIATION, SAMPLE_EQUIPMENT_DEPRECIATION],
      { year: 2025, mode: "final" },
    );
    expect(rows).toEqual([]);
    expect(excluded.map((e) => [e.assetId, e.reason])).toEqual([
      ["asset_flat", expect.stringContaining('"draft"')],
      ["asset_workstation", "no depreciation transaction generated yet"],
    ]);
    const draft = generateDepreciationSection(
      [SAMPLE_DEPRECIATION, SAMPLE_EQUIPMENT_DEPRECIATION],
      { year: 2025, mode: "draft" },
    );
    expect(draft.rows.map((r) => [r.assetId, r.status, r.monthsInService, r.amount])).toEqual([
      ["asset_flat", "draft", 12, "6360.00"],
      ["asset_workstation", "not_generated", 3, "1000.00"],
    ]);
  });

  it("never uses legal-certainty wording", () => {
    const { rows } = generateDepreciationSection([SAMPLE_DEPRECIATION], {
      year: 2026,
      mode: "draft",
    });
    for (const row of rows) {
      const text = `${row.notes} ${row.configuredMethod}`.toLowerCase();
      expect(text).not.toContain("deductible");
      expect(text).not.toContain("legally");
      expect(text).not.toContain("required rate");
    }
  });
});
