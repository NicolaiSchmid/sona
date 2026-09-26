import { computeDepreciationSchedule } from "@sona/core";
import { describe, expect, it } from "vitest";
import { generateDepreciationSection } from "./depreciation.js";
import {
  SAMPLE_ASSET,
  SAMPLE_DEPRECIATION,
  SAMPLE_EQUIPMENT_DEPRECIATION,
  SAMPLE_SCHEDULE_CONFIG,
} from "./fixtures.js";

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
      configId: "cfg_flat_v1",
      configVersion: 1,
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
      {
        assetId: "asset_flat",
        year: 2025,
        transactionId: "depr:asset_flat:v1:2025",
        reason: expect.stringContaining('"draft"'),
      },
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

  it("never exports a reviewed amount that the current schedule no longer produces", () => {
    // Reviewed under v1 at 6 360; the schedule was later reconfigured to 3 %.
    const v2 = {
      ...SAMPLE_DEPRECIATION,
      schedule: computeDepreciationSchedule({
        asset: SAMPLE_ASSET,
        config: {
          ...SAMPLE_SCHEDULE_CONFIG,
          id: "cfg_flat_v2",
          version: 2,
          method: { kind: "linear_percentage", annualRatePercent: "3" },
        },
      }),
    };
    const final = generateDepreciationSection([v2], { year: 2026, mode: "final" });
    expect(final.rows).toEqual([]);
    expect(final.excluded).toEqual([
      {
        assetId: "asset_flat",
        year: 2026,
        transactionId: "t_depr",
        reason: expect.stringContaining(
          "recorded under config v1 (6360.00 EUR); current schedule is v2",
        ),
      },
    ]);

    const draft = generateDepreciationSection([v2], { year: 2026, mode: "draft" });
    expect(draft.rows[0]).toMatchObject({
      amount: "9540.00",
      recordedAmount: "6360.00",
      recordedConfigVersion: 1,
      configVersion: 2,
      status: "user_reviewed",
    });
    expect(draft.rows[0]?.notes).toContain("current schedule is v2");
    expect(draft.rows[0]?.notes).toContain("review required");
  });

  it("requires a fresh review when the config version changed even if the amount did not", () => {
    // v2 only renames the expense account; the 2 % amount is identical.
    const renamed = {
      ...SAMPLE_DEPRECIATION,
      schedule: computeDepreciationSchedule({
        asset: SAMPLE_ASSET,
        config: {
          ...SAMPLE_SCHEDULE_CONFIG,
          id: "cfg_flat_v2",
          version: 2,
          expenseAccount: "Expenses:RealEstate:Depreciation:Flat renamed",
        },
      }),
    };
    const final = generateDepreciationSection([renamed], { year: 2026, mode: "final" });
    expect(final.rows).toEqual([]);
    expect(final.excluded[0]?.reason).toContain("recorded under config v1");
  });

  it("flags a recorded amount that drifted from the same config version", () => {
    const drifted = {
      ...SAMPLE_DEPRECIATION,
      transactions: SAMPLE_DEPRECIATION.transactions.map((t) =>
        t.year === 2026 ? { ...t, amount: { amount: "6000.00", commodity: "EUR" } } : t,
      ),
    };
    const final = generateDepreciationSection([drifted], { year: 2026, mode: "final" });
    expect(final.excluded[0]?.reason).toContain(
      "recorded amount 6000.00 EUR differs from configured schedule 6360.00 EUR",
    );
  });

  it("surfaces a recorded transaction for a year the current schedule no longer covers", () => {
    const disposed = {
      ...SAMPLE_DEPRECIATION,
      schedule: computeDepreciationSchedule({
        asset: SAMPLE_ASSET,
        config: SAMPLE_SCHEDULE_CONFIG,
        events: [
          {
            kind: "disposal",
            id: "evt_sale",
            workspaceId: "ws_1",
            assetId: "asset_flat",
            occurredOn: "2025-06-30",
            description: "Sold",
            evidenceDocumentIds: ["doc_sale"],
            createdAt: "2025-07-01T00:00:00Z",
          },
        ],
      }),
    };
    const { rows, excluded } = generateDepreciationSection([disposed], {
      year: 2026,
      mode: "final",
    });
    expect(rows).toEqual([]);
    expect(excluded).toEqual([
      {
        assetId: "asset_flat",
        year: 2026,
        transactionId: "t_depr",
        reason: expect.stringContaining("outside the current schedule"),
      },
    ]);
  });

  it("treats two live transactions for one year as a review gap instead of picking one", () => {
    const doubled = {
      ...SAMPLE_DEPRECIATION,
      transactions: [
        ...SAMPLE_DEPRECIATION.transactions,
        {
          year: 2026,
          transactionId: "t_depr_second",
          postingIds: ["p_second"],
          amount: { amount: "6360.00", commodity: "EUR" },
          configVersion: 1,
          reviewState: "draft" as const,
        },
      ],
    };
    const final = generateDepreciationSection([doubled], { year: 2026, mode: "final" });
    expect(final.rows).toEqual([]);
    expect(final.excluded[0]?.reason).toContain("more than one live transaction");
    const draft = generateDepreciationSection([doubled], { year: 2026, mode: "draft" });
    expect(draft.rows[0]?.notes).toContain("t_depr, t_depr_second");
    expect(draft.rows[0]?.notes).toContain("review required");
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
              amount: { amount: "6360.00", commodity: "EUR" },
              configVersion: 1,
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
        rows: schedule.rows.map((r) => ({
          ...r,
          evidenceDocumentIds: [],
          missingEvidenceFor: ["asset:asset_flat", "side_cost:sc_notary"],
        })),
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

  it("flags a row whose contract is evidenced but whose side cost is not", () => {
    // Real gap: the purchase contract exists, the notary invoice does not.
    const partial = {
      ...SAMPLE_DEPRECIATION,
      schedule: computeDepreciationSchedule({
        asset: {
          ...SAMPLE_ASSET,
          acquisitionSideCosts: SAMPLE_ASSET.acquisitionSideCosts.map((s) => ({
            ...s,
            evidenceDocumentIds: [],
          })),
        },
        config: SAMPLE_SCHEDULE_CONFIG,
      }),
    };
    const { rows, missingEvidence } = generateDepreciationSection([partial], {
      year: 2026,
      mode: "final",
    });
    expect(rows[0]?.evidenceDocumentIds).toEqual(["doc_2"]);
    expect(rows[0]?.notes).toContain("missing evidence for side_cost:sc_notary");
    expect(missingEvidence).toHaveLength(1);
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
              amount: { amount: "6360.00", commodity: "EUR" },
              configVersion: 1,
              reviewState: "superseded",
            },
          ],
        },
      ],
      { year: 2026, mode: "final" },
    );
    expect(rows).toEqual([]);
    expect(excluded).toEqual([
      {
        assetId: "asset_flat",
        year: 2026,
        transactionId: undefined,
        reason: "no depreciation transaction generated yet",
      },
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
      configId: "cfg_workstation_v1",
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

  it("labels a disposal year and names an unevidenced disposal event in the notes", () => {
    const disposed = {
      ...SAMPLE_DEPRECIATION,
      transactions: [],
      schedule: computeDepreciationSchedule({
        asset: SAMPLE_ASSET,
        config: SAMPLE_SCHEDULE_CONFIG,
        events: [
          {
            kind: "disposal",
            id: "evt_sale",
            workspaceId: "ws_1",
            assetId: "asset_flat",
            occurredOn: "2026-06-30",
            description: "Sold",
            evidenceDocumentIds: [],
            createdAt: "2026-07-01T00:00:00Z",
          },
        ],
      }),
    };
    const { rows, excluded, missingEvidence } = generateDepreciationSection([disposed], {
      year: 2026,
      mode: "draft",
    });
    expect(excluded).toEqual([]);
    expect(rows[0]).toMatchObject({
      monthsInService: 6,
      amount: "3180.00",
      status: "not_generated",
      recordedAmount: undefined,
      recordedConfigVersion: undefined,
      evidenceDocumentIds: ["doc_2", "doc_notary"],
    });
    expect(rows[0]?.notes).toContain("disposal year");
    expect(rows[0]?.notes).toContain("missing evidence for event:evt_sale");
    expect(missingEvidence).toEqual([
      {
        postingId: "schedule:cfg_flat_v1:2026",
        transactionId: "schedule:cfg_flat_v1:2026",
        date: "2026-06-30",
        account: "asset:asset_flat",
        sectionId: "depreciation",
        amount: "3180.00",
        currency: "EUR",
      },
    ]);
    // The year after the disposal is outside the schedule and has nothing recorded.
    expect(generateDepreciationSection([disposed], { year: 2027, mode: "draft" })).toEqual({
      rows: [],
      excluded: [],
      missingEvidence: [],
    });
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
