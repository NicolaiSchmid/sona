import { describe, expect, it } from "vitest";
import { sumDecimals } from "../money/decimal";
import {
  SAMPLE_DISPOSAL,
  SAMPLE_EQUIPMENT,
  SAMPLE_EQUIPMENT_CONFIG,
  SAMPLE_IMPROVEMENT,
  SAMPLE_PROPERTY,
  SAMPLE_PROPERTY_CONFIG,
} from "./fixtures";
import {
  allocateAcquisitionCosts,
  computeDepreciationSchedule,
  type DepreciationSchedule,
  type DepreciationScheduleRow,
  describeDepreciationMethod,
} from "./schedule";
import {
  type Asset,
  type AssetComponent,
  DepreciationError,
  type DepreciationScheduleConfig,
} from "./types";

function rowFor(schedule: DepreciationSchedule, year: number) {
  const row = schedule.rows.find((r) => r.year === year);
  if (row === undefined) {
    throw new Error(`no row for ${year}`);
  }
  return row;
}

function lastRow(schedule: DepreciationSchedule): DepreciationScheduleRow {
  const row = schedule.rows[schedule.rows.length - 1];
  if (row === undefined) {
    throw new Error("schedule has no rows");
  }
  return row;
}

function componentOf(asset: Asset, index: number): AssetComponent {
  const component = asset.components[index];
  if (component === undefined) {
    throw new Error(`fixture has no component ${index}`);
  }
  return component;
}

function totalOf(schedule: DepreciationSchedule): string {
  return sumDecimals(schedule.rows.map((r) => r.amount));
}

describe("allocateAcquisitionCosts", () => {
  it("splits side costs proportionally to the building/land split", () => {
    const allocation = allocateAcquisitionCosts(SAMPLE_PROPERTY);
    expect(allocation.purchasePrice).toBe("400000.00");
    expect(allocation.sideCosts).toBe("24000.00");
    expect(allocation.totalAcquisitionCost).toBe("424000.00");
    const building = allocation.components.find((c) => c.componentId === "cmp_building");
    const land = allocation.components.find((c) => c.componentId === "cmp_land");
    expect(building?.allocatedSideCosts).toBe("18000.00");
    expect(building?.total).toBe("318000.00");
    expect(land?.allocatedSideCosts).toBe("6000.00");
    expect(land?.total).toBe("106000.00");
    // Land is configured non-depreciable and contributes nothing to the basis.
    expect(allocation.depreciableBasis).toBe("318000.00");
  });

  it("lets the last component absorb the rounding remainder exactly", () => {
    const asset: Asset = {
      ...SAMPLE_PROPERTY,
      components: [
        { ...componentOf(SAMPLE_PROPERTY, 0), cost: { amount: "1.00", commodity: "EUR" } },
        { ...componentOf(SAMPLE_PROPERTY, 1), cost: { amount: "1.00", commodity: "EUR" } },
        {
          id: "cmp_garage",
          role: "other",
          label: "Garage",
          cost: { amount: "1.00", commodity: "EUR" },
          depreciable: true,
        },
      ],
      acquisitionSideCosts: [
        {
          id: "sc",
          label: "Fee",
          amount: { amount: "1.00", commodity: "EUR" },
          evidenceDocumentIds: [],
        },
      ],
    };
    const allocation = allocateAcquisitionCosts(asset);
    // Largest remainder: equal remainders, so the leftover cent goes to the first component.
    expect(allocation.components.map((c) => c.allocatedSideCosts)).toEqual([
      "0.34",
      "0.33",
      "0.33",
    ]);
    expect(sumDecimals(allocation.components.map((c) => c.allocatedSideCosts))).toBe("1.00");
  });

  it("never assigns a negative side-cost share when rounding overshoots", () => {
    const asset: Asset = {
      ...SAMPLE_PROPERTY,
      components: [
        { ...componentOf(SAMPLE_PROPERTY, 0), cost: { amount: "0.01", commodity: "EUR" } },
        { ...componentOf(SAMPLE_PROPERTY, 1), cost: { amount: "0.01", commodity: "EUR" } },
        {
          id: "cmp_zero",
          role: "other",
          label: "Zero-cost",
          cost: { amount: "0.00", commodity: "EUR" },
          depreciable: true,
        },
      ],
      acquisitionSideCosts: [
        {
          id: "sc",
          label: "Fee",
          amount: { amount: "0.01", commodity: "EUR" },
          evidenceDocumentIds: [],
        },
      ],
    };
    const allocation = allocateAcquisitionCosts(asset);
    expect(allocation.components.map((c) => c.allocatedSideCosts)).toEqual([
      "0.01",
      "0.00",
      "0.00",
    ]);
    for (const component of allocation.components) {
      expect(component.allocatedSideCosts.startsWith("-")).toBe(false);
    }
  });

  it("rejects an asset without any positive component cost", () => {
    const asset: Asset = {
      ...SAMPLE_PROPERTY,
      components: [{ ...componentOf(SAMPLE_PROPERTY, 0), cost: { amount: "0", commodity: "EUR" } }],
    };
    expect(() => allocateAcquisitionCosts(asset)).toThrow(DepreciationError);
  });
});

describe("computeDepreciationSchedule — linear percentage", () => {
  const schedule = computeDepreciationSchedule({
    asset: SAMPLE_PROPERTY,
    config: SAMPLE_PROPERTY_CONFIG,
  });

  it("depreciates 2 % of the building basis with a pro-rata acquisition year", () => {
    expect(schedule.acquisitionBasis).toBe("318000.00");
    const first = rowFor(schedule, 2024);
    // July–December inclusive = 6 months.
    expect(first.monthsInService).toBe(6);
    expect(first.amount).toBe("3180.00");
    expect(first.notes).toEqual(["pro_rata"]);
    expect(rowFor(schedule, 2025).amount).toBe("6360.00");
    expect(rowFor(schedule, 2025).notes).toEqual([]);
  });

  it("ends with a remainder year so the total equals the basis exactly", () => {
    const last = lastRow(schedule);
    expect(last.year).toBe(2074);
    expect(last.amount).toBe("3180.00");
    expect(last.notes).toContain("final_remainder");
    expect(last.closingBookValue).toBe("0.00");
    expect(totalOf(schedule)).toBe("318000.00");
    expect(schedule.totalDepreciation).toBe("318000.00");
    expect(schedule.complete).toBe(true);
  });

  it("never lets book value go negative and keeps running totals consistent", () => {
    let accumulated = "0";
    for (const row of schedule.rows) {
      expect(row.closingBookValue.startsWith("-")).toBe(false);
      accumulated = sumDecimals([accumulated, row.amount]);
      expect(row.accumulatedDepreciation).toBe(accumulated);
      expect(sumDecimals([row.openingBookValue, `-${row.amount}`])).toBe(row.closingBookValue);
    }
  });

  it("carries acquisition evidence onto every row", () => {
    for (const row of schedule.rows) {
      expect(row.evidenceDocumentIds).toEqual([
        "doc_purchase_contract",
        "doc_transfer_tax",
        "doc_notary",
      ]);
      expect(row.missingEvidenceFor).toEqual([]);
    }
  });

  it("names every contributor that lacks evidence, even when others have some", () => {
    const s = computeDepreciationSchedule({
      asset: {
        ...SAMPLE_PROPERTY,
        evidenceDocumentIds: [],
        // Strip evidence from the transfer-tax side cost only; the notary keeps its invoice.
        acquisitionSideCosts: SAMPLE_PROPERTY.acquisitionSideCosts.map((sideCost) =>
          sideCost.id === "sc_transfer_tax" ? { ...sideCost, evidenceDocumentIds: [] } : sideCost,
        ),
      },
      config: SAMPLE_PROPERTY_CONFIG,
      events: [{ ...SAMPLE_IMPROVEMENT, evidenceDocumentIds: [] }],
    });
    expect(rowFor(s, 2025).evidenceDocumentIds).toEqual(["doc_notary"]);
    expect(rowFor(s, 2025).missingEvidenceFor).toEqual([
      "asset:asset_flat",
      "side_cost:sc_transfer_tax",
    ]);
    expect(rowFor(s, 2026).missingEvidenceFor).toEqual([
      "asset:asset_flat",
      "side_cost:sc_transfer_tax",
      "event:evt_bath_2026",
    ]);
  });

  it("records the configuration version it was computed from", () => {
    expect(schedule.configId).toBe("cfg_flat_v1");
    expect(schedule.configVersion).toBe(1);
    expect(schedule.method).toEqual({ kind: "linear_percentage", annualRatePercent: "2" });
  });

  it("uses full years when pro rata is disabled", () => {
    const full = computeDepreciationSchedule({
      asset: SAMPLE_PROPERTY,
      config: { ...SAMPLE_PROPERTY_CONFIG, proRataTemporis: false },
    });
    expect(rowFor(full, 2024).monthsInService).toBe(12);
    expect(rowFor(full, 2024).amount).toBe("6360.00");
    expect(full.rows).toHaveLength(50);
    expect(totalOf(full)).toBe("318000.00");
  });

  it("rounds fractional rates deterministically and still sums to the basis", () => {
    const asset: Asset = {
      ...SAMPLE_EQUIPMENT,
      acquiredOn: "2025-06-01",
      components: [
        { ...componentOf(SAMPLE_EQUIPMENT, 0), cost: { amount: "12345.67", commodity: "EUR" } },
      ],
    };
    const config: DepreciationScheduleConfig = {
      ...SAMPLE_EQUIPMENT_CONFIG,
      method: { kind: "linear_percentage", annualRatePercent: "2.5" },
    };
    const s = computeDepreciationSchedule({ asset, config });
    // 12345.67 × 2.5 % × 7/12 = 180.04101… → 180.04
    expect(rowFor(s, 2025).amount).toBe("180.04");
    // 12345.67 × 2.5 % = 308.64175 → 308.64
    expect(rowFor(s, 2026).amount).toBe("308.64");
    expect(totalOf(s)).toBe("12345.67");
  });
});

describe("computeDepreciationSchedule — linear useful life", () => {
  it("spreads the remaining book value over the remaining months", () => {
    const s = computeDepreciationSchedule({
      asset: SAMPLE_EQUIPMENT,
      config: SAMPLE_EQUIPMENT_CONFIG,
    });
    expect(s.rows.map((r) => [r.year, r.monthsInService, r.amount])).toEqual([
      [2025, 3, "1000.00"],
      [2026, 12, "4000.00"],
      [2027, 12, "4000.00"],
      [2028, 12, "3000.00"],
    ]);
    expect(rowFor(s, 2028).notes).toContain("final_remainder");
    expect(totalOf(s)).toBe("12000.00");
    expect(s.complete).toBe(true);
  });

  it("absorbs cent rounding in the final year", () => {
    const asset: Asset = {
      ...SAMPLE_EQUIPMENT,
      acquiredOn: "2025-01-01",
      components: [
        { ...componentOf(SAMPLE_EQUIPMENT, 0), cost: { amount: "1000.00", commodity: "EUR" } },
      ],
    };
    const s = computeDepreciationSchedule({
      asset,
      config: { ...SAMPLE_EQUIPMENT_CONFIG, proRataTemporis: false },
    });
    expect(s.rows.map((r) => r.amount)).toEqual(["333.33", "333.34", "333.33"]);
    expect(totalOf(s)).toBe("1000.00");
  });

  it("honours a configured residual value as the floor", () => {
    const s = computeDepreciationSchedule({
      asset: SAMPLE_EQUIPMENT,
      config: {
        ...SAMPLE_EQUIPMENT_CONFIG,
        proRataTemporis: false,
        residualValue: { amount: "1500.00", commodity: "EUR" },
      },
    });
    expect(s.residualValue).toBe("1500.00");
    expect(s.rows.map((r) => r.amount)).toEqual(["3500.00", "3500.00", "3500.00"]);
    expect(s.rows[s.rows.length - 1]?.closingBookValue).toBe("1500.00");
    expect(totalOf(s)).toBe("10500.00");
  });

  it("rejects a residual value above the depreciable basis", () => {
    expect(() =>
      computeDepreciationSchedule({
        asset: SAMPLE_EQUIPMENT,
        config: {
          ...SAMPLE_EQUIPMENT_CONFIG,
          residualValue: { amount: "99999.00", commodity: "EUR" },
        },
      }),
    ).toThrow(/exceeds depreciable basis/);
  });
});

describe("computeDepreciationSchedule — improvements", () => {
  const withImprovement = computeDepreciationSchedule({
    asset: SAMPLE_PROPERTY,
    config: SAMPLE_PROPERTY_CONFIG,
    events: [SAMPLE_IMPROVEMENT],
  });
  const without = computeDepreciationSchedule({
    asset: SAMPLE_PROPERTY,
    config: SAMPLE_PROPERTY_CONFIG,
  });

  it("raises the basis from the improvement year forward only", () => {
    expect(rowFor(withImprovement, 2024)).toEqual(rowFor(without, 2024));
    expect(rowFor(withImprovement, 2025)).toEqual(rowFor(without, 2025));
    const improved = rowFor(withImprovement, 2026);
    expect(improved.depreciableBasis).toBe("368000.00");
    expect(improved.amount).toBe("7360.00");
    expect(improved.appliedEventIds).toEqual(["evt_bath_2026"]);
    expect(improved.evidenceDocumentIds).toContain("doc_bath_invoice");
    expect(rowFor(withImprovement, 2025).evidenceDocumentIds).not.toContain("doc_bath_invoice");
  });

  it("extends the schedule and still totals the improved basis", () => {
    expect(totalOf(withImprovement)).toBe("368000.00");
    expect(withImprovement.rows.length).toBeGreaterThanOrEqual(without.rows.length);
    expect(withImprovement.complete).toBe(true);
  });

  it("ignores improvements to a non-depreciable component for the basis but keeps their evidence", () => {
    const s = computeDepreciationSchedule({
      asset: SAMPLE_PROPERTY,
      config: SAMPLE_PROPERTY_CONFIG,
      events: [
        {
          ...SAMPLE_IMPROVEMENT,
          id: "evt_land",
          componentId: "cmp_land",
          evidenceDocumentIds: ["doc_land_work"],
        },
      ],
    });
    expect(rowFor(s, 2026).depreciableBasis).toBe("318000.00");
    expect(rowFor(s, 2026).evidenceDocumentIds).toContain("doc_land_work");
    expect(totalOf(s)).toBe("318000.00");
  });

  it("re-spreads an improvement over the remaining useful life", () => {
    const s = computeDepreciationSchedule({
      asset: SAMPLE_EQUIPMENT,
      config: { ...SAMPLE_EQUIPMENT_CONFIG, proRataTemporis: false },
      events: [
        {
          ...SAMPLE_IMPROVEMENT,
          id: "evt_upgrade",
          assetId: "asset_laptop",
          componentId: "cmp_laptop",
          occurredOn: "2026-05-05",
          amount: { amount: "2400.00", commodity: "EUR" },
        },
      ],
    });
    // 2025: 12000/3 = 4000. 2026: (8000 + 2400) over 24 remaining months → 5200. 2027: 5200.
    expect(s.rows.map((r) => r.amount)).toEqual(["4000.00", "5200.00", "5200.00"]);
    expect(totalOf(s)).toBe("14400.00");
  });

  it("rejects events for another asset, unknown components, or before acquisition", () => {
    const base = { asset: SAMPLE_PROPERTY, config: SAMPLE_PROPERTY_CONFIG };
    expect(() =>
      computeDepreciationSchedule({
        ...base,
        events: [{ ...SAMPLE_IMPROVEMENT, assetId: "asset_other" }],
      }),
    ).toThrow(/does not belong/);
    expect(() =>
      computeDepreciationSchedule({
        ...base,
        events: [{ ...SAMPLE_IMPROVEMENT, componentId: "cmp_missing" }],
      }),
    ).toThrow(/unknown component/);
    expect(() =>
      computeDepreciationSchedule({
        ...base,
        events: [{ ...SAMPLE_IMPROVEMENT, occurredOn: "2023-01-01" }],
      }),
    ).toThrow(/before the asset was acquired/);
  });

  it("rejects a config that belongs to a different asset or workspace", () => {
    expect(() =>
      computeDepreciationSchedule({
        asset: SAMPLE_PROPERTY,
        config: { ...SAMPLE_PROPERTY_CONFIG, assetId: "asset_laptop" },
      }),
    ).toThrow(DepreciationError);
    expect(() =>
      computeDepreciationSchedule({
        asset: SAMPLE_PROPERTY,
        config: { ...SAMPLE_PROPERTY_CONFIG, workspaceId: "ws_2" },
      }),
    ).toThrow(DepreciationError);
  });
});

describe("computeDepreciationSchedule — disposal", () => {
  it("stops in the disposal year with a pro-rata final amount", () => {
    const s = computeDepreciationSchedule({
      asset: SAMPLE_PROPERTY,
      config: SAMPLE_PROPERTY_CONFIG,
      events: [SAMPLE_DISPOSAL],
    });
    expect(s.rows.map((r) => r.year)).toEqual([2024, 2025, 2026, 2027]);
    const last = rowFor(s, 2027);
    // January–April inclusive = 4 months of 6 360.
    expect(last.monthsInService).toBe(4);
    expect(last.amount).toBe("2120.00");
    expect(last.notes).toEqual(["pro_rata", "disposal_year"]);
    expect(s.disposedOn).toBe("2027-04-20");
    expect(s.complete).toBe(true);
    // Remaining book value is left for an explicit disposal posting, not depreciated away.
    expect(last.closingBookValue).toBe("299980.00");
    // The disposal event and its evidence are part of the disposal-year row's provenance.
    expect(last.appliedEventIds).toEqual(["evt_sale_2027"]);
    expect(last.evidenceDocumentIds).toContain("doc_sale_contract");
    expect(rowFor(s, 2026).appliedEventIds).toEqual([]);
    expect(rowFor(s, 2026).evidenceDocumentIds).not.toContain("doc_sale_contract");
  });

  it("counts acquisition through disposal month when both fall in one year", () => {
    const s = computeDepreciationSchedule({
      asset: SAMPLE_PROPERTY,
      config: SAMPLE_PROPERTY_CONFIG,
      events: [{ ...SAMPLE_DISPOSAL, occurredOn: "2024-10-31" }],
    });
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]?.monthsInService).toBe(4);
    expect(s.rows[0]?.amount).toBe("2120.00");
  });

  it("rejects a second disposal or an improvement after disposal", () => {
    expect(() =>
      computeDepreciationSchedule({
        asset: SAMPLE_PROPERTY,
        config: SAMPLE_PROPERTY_CONFIG,
        events: [SAMPLE_DISPOSAL, { ...SAMPLE_DISPOSAL, id: "evt_dup" }],
      }),
    ).toThrow(/more than one disposal/);
    expect(() =>
      computeDepreciationSchedule({
        asset: SAMPLE_PROPERTY,
        config: SAMPLE_PROPERTY_CONFIG,
        events: [SAMPLE_DISPOSAL, { ...SAMPLE_IMPROVEMENT, occurredOn: "2028-01-01" }],
      }),
    ).toThrow(/after disposal/);
  });
});

describe("computeDepreciationSchedule — retractions", () => {
  const retraction = {
    kind: "retraction" as const,
    id: "evt_retract_bath",
    workspaceId: "ws_1",
    assetId: "asset_flat",
    retractsEventId: "evt_bath_2026",
    occurredOn: "2026-09-01",
    description: "Booked as maintenance instead",
    evidenceDocumentIds: [],
    createdAt: "2026-09-01T00:00:00Z",
  };

  it("ignores a retracted improvement so the schedule matches one without it", () => {
    const without = computeDepreciationSchedule({
      asset: SAMPLE_PROPERTY,
      config: SAMPLE_PROPERTY_CONFIG,
    });
    const retracted = computeDepreciationSchedule({
      asset: SAMPLE_PROPERTY,
      config: SAMPLE_PROPERTY_CONFIG,
      events: [SAMPLE_IMPROVEMENT, retraction],
    });
    expect(retracted.rows).toEqual(without.rows);
  });

  it("lets a corrected event follow a retraction", () => {
    const corrected = computeDepreciationSchedule({
      asset: SAMPLE_PROPERTY,
      config: SAMPLE_PROPERTY_CONFIG,
      events: [
        SAMPLE_IMPROVEMENT,
        retraction,
        {
          ...SAMPLE_IMPROVEMENT,
          id: "evt_bath_fixed",
          amount: { amount: "20000.00", commodity: "EUR" },
        },
      ],
    });
    expect(rowFor(corrected, 2026).depreciableBasis).toBe("338000.00");
    expect(rowFor(corrected, 2026).appliedEventIds).toEqual(["evt_bath_fixed"]);
  });

  it("lets a retracted disposal be replaced and rejects dangling or nested retractions", () => {
    const replaced = computeDepreciationSchedule({
      asset: SAMPLE_PROPERTY,
      config: SAMPLE_PROPERTY_CONFIG,
      events: [
        SAMPLE_DISPOSAL,
        { ...retraction, id: "evt_retract_sale", retractsEventId: "evt_sale_2027" },
        { ...SAMPLE_DISPOSAL, id: "evt_sale_2028", occurredOn: "2028-01-31" },
      ],
    });
    expect(replaced.disposedOn).toBe("2028-01-31");
    expect(() =>
      computeDepreciationSchedule({
        asset: SAMPLE_PROPERTY,
        config: SAMPLE_PROPERTY_CONFIG,
        events: [{ ...retraction, retractsEventId: "evt_missing" }],
      }),
    ).toThrow(/unknown event/);
    expect(() =>
      computeDepreciationSchedule({
        asset: SAMPLE_PROPERTY,
        config: SAMPLE_PROPERTY_CONFIG,
        events: [
          SAMPLE_IMPROVEMENT,
          retraction,
          { ...retraction, id: "evt_nested", retractsEventId: "evt_retract_bath" },
        ],
      }),
    ).toThrow(/cannot retract another retraction/);
  });
});

describe("describeDepreciationMethod", () => {
  it("labels methods as configured, without legal wording", () => {
    expect(
      describeDepreciationMethod({ kind: "linear_percentage", annualRatePercent: "2.5" }),
    ).toBe("linear 2.5 % per year");
    expect(describeDepreciationMethod({ kind: "linear_useful_life", usefulLifeYears: 3 })).toBe(
      "linear over 3 years",
    );
  });
});

describe("computeDepreciationSchedule — acquisition month boundaries", () => {
  it("treats a January acquisition as a full year without a pro-rata note", () => {
    const s = computeDepreciationSchedule({
      asset: { ...SAMPLE_PROPERTY, acquiredOn: "2024-01-31" },
      config: SAMPLE_PROPERTY_CONFIG,
    });
    const first = rowFor(s, 2024);
    expect(first.monthsInService).toBe(12);
    expect(first.amount).toBe("6360.00");
    expect(first.notes).toEqual([]);
    // 318 000 / 6 360 = 50 exact full years, so no remainder year is needed.
    expect(s.rows).toHaveLength(50);
    expect(lastRow(s).year).toBe(2073);
    expect(totalOf(s)).toBe("318000.00");
  });

  it("counts a single month for a December acquisition", () => {
    const s = computeDepreciationSchedule({
      asset: { ...SAMPLE_PROPERTY, acquiredOn: "2024-12-01" },
      config: SAMPLE_PROPERTY_CONFIG,
    });
    const first = rowFor(s, 2024);
    expect(first.monthsInService).toBe(1);
    // 318 000 × 2 % / 12 = 530.
    expect(first.amount).toBe("530.00");
    expect(first.notes).toEqual(["pro_rata"]);
    expect(lastRow(s).amount).toBe("5830.00");
    expect(lastRow(s).notes).toContain("final_remainder");
    expect(totalOf(s)).toBe("318000.00");
  });
});

describe("computeDepreciationSchedule — improvement timing", () => {
  it("applies an improvement in the acquisition year to the pro-rata first row", () => {
    const s = computeDepreciationSchedule({
      asset: SAMPLE_PROPERTY,
      config: SAMPLE_PROPERTY_CONFIG,
      events: [{ ...SAMPLE_IMPROVEMENT, occurredOn: "2024-09-01" }],
    });
    const first = rowFor(s, 2024);
    expect(first.depreciableBasis).toBe("368000.00");
    // 368 000 × 2 % × 6/12 = 3 680.
    expect(first.amount).toBe("3680.00");
    expect(first.monthsInService).toBe(6);
    expect(first.appliedEventIds).toEqual(["evt_bath_2026"]);
    expect(first.evidenceDocumentIds).toContain("doc_bath_invoice");
    expect(totalOf(s)).toBe("368000.00");
    expect(s.complete).toBe(true);
  });

  it("applies several improvements in one year together and keeps all their evidence", () => {
    const kitchen = {
      ...SAMPLE_IMPROVEMENT,
      id: "evt_kitchen_2026",
      occurredOn: "2026-11-01",
      amount: { amount: "10000.00", commodity: "EUR" },
      evidenceDocumentIds: ["doc_kitchen_invoice"],
    };
    const s = computeDepreciationSchedule({
      asset: SAMPLE_PROPERTY,
      config: SAMPLE_PROPERTY_CONFIG,
      events: [kitchen, SAMPLE_IMPROVEMENT],
    });
    expect(rowFor(s, 2025).depreciableBasis).toBe("318000.00");
    const improved = rowFor(s, 2026);
    expect(improved.depreciableBasis).toBe("378000.00");
    expect(improved.amount).toBe("7560.00");
    expect([...improved.appliedEventIds].sort()).toEqual(["evt_bath_2026", "evt_kitchen_2026"]);
    expect(improved.evidenceDocumentIds).toEqual(
      expect.arrayContaining(["doc_bath_invoice", "doc_kitchen_invoice"]),
    );
    expect(totalOf(s)).toBe("378000.00");
  });

  it("resumes a fully depreciated useful-life asset in the year of a later improvement", () => {
    const s = computeDepreciationSchedule({
      asset: SAMPLE_EQUIPMENT,
      config: { ...SAMPLE_EQUIPMENT_CONFIG, proRataTemporis: false },
      events: [
        {
          ...SAMPLE_IMPROVEMENT,
          id: "evt_late",
          assetId: "asset_laptop",
          componentId: "cmp_laptop",
          occurredOn: "2031-02-01",
          amount: { amount: "600.00", commodity: "EUR" },
          evidenceDocumentIds: ["doc_late_invoice"],
        },
      ],
    });
    // Original life 2025–2027, nothing for 2028–2030, then the improvement alone in 2031.
    expect(s.rows.map((r) => r.year)).toEqual([2025, 2026, 2027, 2031]);
    expect(rowFor(s, 2027).closingBookValue).toBe("0.00");
    const resumed = rowFor(s, 2031);
    expect(resumed.depreciableBasis).toBe("12600.00");
    expect(resumed.openingBookValue).toBe("600.00");
    expect(resumed.amount).toBe("600.00");
    expect(resumed.closingBookValue).toBe("0.00");
    expect(resumed.appliedEventIds).toEqual(["evt_late"]);
    expect(resumed.evidenceDocumentIds).toEqual(["doc_laptop_invoice", "doc_late_invoice"]);
    expect(totalOf(s)).toBe("12600.00");
    expect(s.complete).toBe(true);
  });

  it("resumes a fully depreciated percentage asset in the year of a later improvement", () => {
    const s = computeDepreciationSchedule({
      asset: SAMPLE_EQUIPMENT,
      config: {
        ...SAMPLE_EQUIPMENT_CONFIG,
        proRataTemporis: false,
        method: { kind: "linear_percentage", annualRatePercent: "50" },
      },
      events: [
        {
          ...SAMPLE_IMPROVEMENT,
          id: "evt_late",
          assetId: "asset_laptop",
          componentId: "cmp_laptop",
          occurredOn: "2030-02-01",
          amount: { amount: "600.00", commodity: "EUR" },
        },
      ],
    });
    expect(s.rows.map((r) => [r.year, r.amount])).toEqual([
      [2025, "6000.00"],
      [2026, "6000.00"],
      [2030, "600.00"],
    ]);
    expect(totalOf(s)).toBe("12600.00");
    expect(s.complete).toBe(true);
  });
});

describe("computeDepreciationSchedule — percentage with residual and rounding scale", () => {
  it("stops a percentage schedule at the configured residual value", () => {
    const s = computeDepreciationSchedule({
      asset: SAMPLE_EQUIPMENT,
      config: {
        ...SAMPLE_EQUIPMENT_CONFIG,
        proRataTemporis: false,
        method: { kind: "linear_percentage", annualRatePercent: "25" },
        residualValue: { amount: "2000.00", commodity: "EUR" },
      },
    });
    expect(s.rows.map((r) => r.amount)).toEqual(["3000.00", "3000.00", "3000.00", "1000.00"]);
    expect(lastRow(s).notes).toEqual(["final_remainder"]);
    expect(lastRow(s).closingBookValue).toBe("2000.00");
    expect(totalOf(s)).toBe("10000.00");
    expect(s.complete).toBe(true);
  });

  it("rejects a residual value in a different commodity", () => {
    expect(() =>
      computeDepreciationSchedule({
        asset: SAMPLE_EQUIPMENT,
        config: {
          ...SAMPLE_EQUIPMENT_CONFIG,
          residualValue: { amount: "1.00", commodity: "USD" },
        },
      }),
    ).toThrow(/denominated in USD/);
  });

  it("rejects an improvement in a different commodity", () => {
    expect(() =>
      computeDepreciationSchedule({
        asset: SAMPLE_PROPERTY,
        config: SAMPLE_PROPERTY_CONFIG,
        events: [{ ...SAMPLE_IMPROVEMENT, amount: { amount: "1.00", commodity: "CHF" } }],
      }),
    ).toThrow(/denominated in CHF/);
  });

  it("totals exactly at rounding scale 0 (whole units)", () => {
    const asset: Asset = {
      ...SAMPLE_EQUIPMENT,
      acquiredOn: "2025-01-01",
      components: [
        { ...componentOf(SAMPLE_EQUIPMENT, 0), cost: { amount: "1000", commodity: "EUR" } },
      ],
    };
    const s = computeDepreciationSchedule({
      asset,
      config: { ...SAMPLE_EQUIPMENT_CONFIG, proRataTemporis: false, roundingScale: 0 },
    });
    expect(s.scale).toBe(0);
    expect(s.rows.map((r) => r.amount)).toEqual(["333", "334", "333"]);
    expect(s.acquisitionBasis).toBe("1000");
    expect(totalOf(s)).toBe("1000");
    expect(s.totalDepreciation).toBe("1000");
  });

  it("totals exactly at rounding scale 4", () => {
    const asset: Asset = {
      ...SAMPLE_EQUIPMENT,
      acquiredOn: "2025-01-01",
      components: [
        { ...componentOf(SAMPLE_EQUIPMENT, 0), cost: { amount: "1000.00", commodity: "EUR" } },
      ],
    };
    const s = computeDepreciationSchedule({
      asset,
      config: { ...SAMPLE_EQUIPMENT_CONFIG, proRataTemporis: false, roundingScale: 4 },
    });
    expect(s.rows.map((r) => r.amount)).toEqual(["333.3333", "333.3334", "333.3333"]);
    expect(totalOf(s)).toBe("1000.0000");
    expect(lastRow(s).closingBookValue).toBe("0.0000");
  });

  it("rejects component costs with more fractional digits than the rounding scale", () => {
    const asset: Asset = {
      ...SAMPLE_EQUIPMENT,
      components: [
        { ...componentOf(SAMPLE_EQUIPMENT, 0), cost: { amount: "1000.50", commodity: "EUR" } },
      ],
    };
    expect(() =>
      computeDepreciationSchedule({
        asset,
        config: { ...SAMPLE_EQUIPMENT_CONFIG, roundingScale: 0 },
      }),
    ).toThrow(/fractional/);
  });

  it("applies a rate with more fractional digits than the basis scale", () => {
    const asset: Asset = {
      ...SAMPLE_EQUIPMENT,
      acquiredOn: "2025-01-01",
      components: [
        { ...componentOf(SAMPLE_EQUIPMENT, 0), cost: { amount: "1000.00", commodity: "EUR" } },
      ],
    };
    const s = computeDepreciationSchedule({
      asset,
      config: {
        ...SAMPLE_EQUIPMENT_CONFIG,
        proRataTemporis: false,
        method: { kind: "linear_percentage", annualRatePercent: "33.333" },
      },
    });
    // 1000 × 33.333 % = 333.33 per year. The percentage method applies the
    // configured rate every year and lets the last year absorb the remainder,
    // so a rate that is not an exact divisor leaves a small trailing stub year.
    expect(s.rows.map((r) => r.amount)).toEqual(["333.33", "333.33", "333.33", "0.01"]);
    expect(lastRow(s).notes).toEqual(["final_remainder"]);
    expect(totalOf(s)).toBe("1000.00");
  });
});

describe("computeDepreciationSchedule — termination and degenerate inputs", () => {
  it("refuses a rate so small the schedule would not terminate within the year cap", () => {
    expect(() =>
      computeDepreciationSchedule({
        asset: SAMPLE_PROPERTY,
        config: {
          ...SAMPLE_PROPERTY_CONFIG,
          method: { kind: "linear_percentage", annualRatePercent: "0.1" },
        },
      }),
    ).toThrow(/did not terminate within 200 years/);
  });

  it("refuses a disposal dated before the acquisition month of the same year", () => {
    expect(() =>
      computeDepreciationSchedule({
        asset: SAMPLE_PROPERTY,
        config: SAMPLE_PROPERTY_CONFIG,
        events: [{ ...SAMPLE_DISPOSAL, occurredOn: "2024-03-31" }],
      }),
    ).toThrow(/before the asset was acquired/);
    expect(() =>
      computeDepreciationSchedule({
        asset: SAMPLE_PROPERTY,
        config: SAMPLE_PROPERTY_CONFIG,
        events: [{ ...SAMPLE_IMPROVEMENT, occurredOn: "2024-02-01" }],
      }),
    ).toThrow(/before the asset was acquired/);
  });

  it("flags an improvement that re-opens a fully depreciated schedule", () => {
    const s = computeDepreciationSchedule({
      asset: SAMPLE_EQUIPMENT,
      config: { ...SAMPLE_EQUIPMENT_CONFIG, proRataTemporis: false },
      events: [
        {
          ...SAMPLE_IMPROVEMENT,
          id: "evt_late",
          assetId: "asset_laptop",
          componentId: "cmp_laptop",
          occurredOn: "2031-02-01",
          amount: { amount: "2400.00", commodity: "EUR" },
        },
      ],
    });
    expect(lastRow(s).year).toBe(2031);
    expect(lastRow(s).notes).toContain("post_completion_improvement");
    expect(totalOf(s)).toBe("14400.00");
  });

  it("refuses a basis so small every yearly amount rounds to zero", () => {
    const asset: Asset = {
      ...SAMPLE_EQUIPMENT,
      components: [
        { ...componentOf(SAMPLE_EQUIPMENT, 0), cost: { amount: "0.10", commodity: "EUR" } },
      ],
    };
    expect(() =>
      computeDepreciationSchedule({
        asset,
        config: {
          ...SAMPLE_EQUIPMENT_CONFIG,
          method: { kind: "linear_percentage", annualRatePercent: "2" },
        },
      }),
    ).toThrow(/rounds to zero/);
  });

  it("yields an empty, complete schedule for an asset with no depreciable component", () => {
    const s = computeDepreciationSchedule({
      asset: { ...SAMPLE_PROPERTY, components: [componentOf(SAMPLE_PROPERTY, 1)] },
      config: SAMPLE_PROPERTY_CONFIG,
    });
    expect(s.acquisitionBasis).toBe("0.00");
    expect(s.rows).toEqual([]);
    expect(s.totalDepreciation).toBe("0.00");
    expect(s.complete).toBe(true);
  });

  it("keeps a land-only schedule empty even when the land is improved", () => {
    const s = computeDepreciationSchedule({
      asset: { ...SAMPLE_PROPERTY, components: [componentOf(SAMPLE_PROPERTY, 1)] },
      config: SAMPLE_PROPERTY_CONFIG,
      events: [{ ...SAMPLE_IMPROVEMENT, componentId: "cmp_land" }],
    });
    expect(s.rows).toEqual([]);
    expect(s.totalDepreciation).toBe("0.00");
    expect(s.complete).toBe(true);
  });

  it("rejects a malformed acquisition or event date", () => {
    expect(() =>
      computeDepreciationSchedule({
        asset: { ...SAMPLE_PROPERTY, acquiredOn: "2024-13-01" },
        config: SAMPLE_PROPERTY_CONFIG,
      }),
    ).toThrow(/invalid month/);
    expect(() =>
      computeDepreciationSchedule({
        asset: SAMPLE_PROPERTY,
        config: SAMPLE_PROPERTY_CONFIG,
        events: [{ ...SAMPLE_IMPROVEMENT, occurredOn: "01.03.2026" }],
      }),
    ).toThrow(/ISO date/);
  });
});

describe("computeDepreciationSchedule — disposal variants", () => {
  it("pro-rates a useful-life disposal year over the remaining months", () => {
    const s = computeDepreciationSchedule({
      asset: SAMPLE_EQUIPMENT,
      config: SAMPLE_EQUIPMENT_CONFIG,
      events: [
        {
          ...SAMPLE_DISPOSAL,
          id: "evt_laptop_sale",
          assetId: "asset_laptop",
          occurredOn: "2027-03-15",
          proceeds: undefined,
        },
      ],
    });
    expect(s.rows.map((r) => [r.year, r.monthsInService, r.amount])).toEqual([
      [2025, 3, "1000.00"],
      [2026, 12, "4000.00"],
      // 7 000 remaining over 21 remaining months × 3 months = 1 000.
      [2027, 3, "1000.00"],
    ]);
    expect(lastRow(s).notes).toEqual(["pro_rata", "disposal_year"]);
    expect(lastRow(s).closingBookValue).toBe("6000.00");
    expect(s.disposedOn).toBe("2027-03-15");
    expect(s.complete).toBe(true);
  });

  it("takes a full year in the disposal year when pro rata is disabled", () => {
    const s = computeDepreciationSchedule({
      asset: SAMPLE_PROPERTY,
      config: { ...SAMPLE_PROPERTY_CONFIG, proRataTemporis: false },
      events: [SAMPLE_DISPOSAL],
    });
    expect(s.rows.map((r) => r.year)).toEqual([2024, 2025, 2026, 2027]);
    const last = rowFor(s, 2027);
    expect(last.monthsInService).toBe(12);
    expect(last.amount).toBe("6360.00");
    expect(last.notes).toEqual(["disposal_year"]);
    expect(totalOf(s)).toBe("25440.00");
  });

  it("does not label a disposal-year amount as a final remainder", () => {
    // Disposal in the last scheduled year of a 3-year life: the remaining
    // book value is taken, but flagged as disposal, not as remainder.
    const s = computeDepreciationSchedule({
      asset: SAMPLE_EQUIPMENT,
      config: { ...SAMPLE_EQUIPMENT_CONFIG, proRataTemporis: false },
      events: [
        {
          ...SAMPLE_DISPOSAL,
          id: "evt_laptop_sale",
          assetId: "asset_laptop",
          occurredOn: "2027-12-31",
        },
      ],
    });
    expect(lastRow(s).amount).toBe("4000.00");
    expect(lastRow(s).notes).toEqual(["disposal_year"]);
    expect(lastRow(s).closingBookValue).toBe("0.00");
  });
});
