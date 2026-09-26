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
  DepreciationScheduleError,
  type DepreciationScheduleRow,
  describeDepreciationMethod,
} from "./schedule";
import type { Asset, AssetComponent, DepreciationScheduleConfig } from "./types";

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
    expect(allocation.components.map((c) => c.allocatedSideCosts)).toEqual([
      "0.33",
      "0.33",
      "0.34",
    ]);
    expect(sumDecimals(allocation.components.map((c) => c.allocatedSideCosts))).toBe("1.00");
  });

  it("rejects an asset without any positive component cost", () => {
    const asset: Asset = {
      ...SAMPLE_PROPERTY,
      components: [{ ...componentOf(SAMPLE_PROPERTY, 0), cost: { amount: "0", commodity: "EUR" } }],
    };
    expect(() => allocateAcquisitionCosts(asset)).toThrow(DepreciationScheduleError);
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
    }
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
    ).toThrow(DepreciationScheduleError);
    expect(() =>
      computeDepreciationSchedule({
        asset: SAMPLE_PROPERTY,
        config: { ...SAMPLE_PROPERTY_CONFIG, workspaceId: "ws_2" },
      }),
    ).toThrow(DepreciationScheduleError);
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
