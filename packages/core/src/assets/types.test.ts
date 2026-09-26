import { describe, expect, it } from "vitest";
import { SAMPLE_IMPROVEMENT, SAMPLE_PROPERTY, SAMPLE_PROPERTY_CONFIG } from "./fixtures";
import { assetEventSchema, assetSchema, depreciationScheduleConfigSchema } from "./types";

describe("assetSchema", () => {
  it("accepts the synthetic property", () => {
    expect(assetSchema.safeParse(SAMPLE_PROPERTY).success).toBe(true);
  });

  it("rejects component or side-cost commodities that differ from the asset", () => {
    const badComponent = assetSchema.safeParse({
      ...SAMPLE_PROPERTY,
      components: [
        { ...SAMPLE_PROPERTY.components[0], cost: { amount: "1.00", commodity: "USD" } },
      ],
    });
    expect(badComponent.success).toBe(false);
    const badSideCost = assetSchema.safeParse({
      ...SAMPLE_PROPERTY,
      acquisitionSideCosts: [
        { ...SAMPLE_PROPERTY.acquisitionSideCosts[0], amount: { amount: "1", commodity: "USD" } },
      ],
    });
    expect(badSideCost.success).toBe(false);
  });

  it("rejects duplicate component ids, negative costs, and malformed dates", () => {
    const [building] = SAMPLE_PROPERTY.components;
    expect(
      assetSchema.safeParse({ ...SAMPLE_PROPERTY, components: [building, building] }).success,
    ).toBe(false);
    expect(
      assetSchema.safeParse({
        ...SAMPLE_PROPERTY,
        components: [{ ...building, cost: { amount: "-1.00", commodity: "EUR" } }],
      }).success,
    ).toBe(false);
    expect(assetSchema.safeParse({ ...SAMPLE_PROPERTY, acquiredOn: "15.07.2024" }).success).toBe(
      false,
    );
    expect(assetSchema.safeParse({ ...SAMPLE_PROPERTY, components: [] }).success).toBe(false);
  });
});

describe("depreciationScheduleConfigSchema", () => {
  it("accepts both configured methods", () => {
    expect(depreciationScheduleConfigSchema.safeParse(SAMPLE_PROPERTY_CONFIG).success).toBe(true);
    expect(
      depreciationScheduleConfigSchema.safeParse({
        ...SAMPLE_PROPERTY_CONFIG,
        method: { kind: "linear_useful_life", usefulLifeYears: 10 },
      }).success,
    ).toBe(true);
  });

  it("rejects a zero or negative rate and a non-integer useful life", () => {
    expect(
      depreciationScheduleConfigSchema.safeParse({
        ...SAMPLE_PROPERTY_CONFIG,
        method: { kind: "linear_percentage", annualRatePercent: "0.0" },
      }).success,
    ).toBe(false);
    expect(
      depreciationScheduleConfigSchema.safeParse({
        ...SAMPLE_PROPERTY_CONFIG,
        method: { kind: "linear_percentage", annualRatePercent: "-2" },
      }).success,
    ).toBe(false);
    expect(
      depreciationScheduleConfigSchema.safeParse({
        ...SAMPLE_PROPERTY_CONFIG,
        method: { kind: "linear_useful_life", usefulLifeYears: 2.5 },
      }).success,
    ).toBe(false);
  });

  it("caps the rate at four fractional digits", () => {
    const parse = (annualRatePercent: string) =>
      depreciationScheduleConfigSchema.safeParse({
        ...SAMPLE_PROPERTY_CONFIG,
        method: { kind: "linear_percentage", annualRatePercent },
      }).success;
    expect(parse("3.3333")).toBe(true);
    expect(parse("3.33333")).toBe(false);
  });

  it("requires positive versions and account paths", () => {
    expect(
      depreciationScheduleConfigSchema.safeParse({ ...SAMPLE_PROPERTY_CONFIG, version: 0 }).success,
    ).toBe(false);
    expect(
      depreciationScheduleConfigSchema.safeParse({ ...SAMPLE_PROPERTY_CONFIG, expenseAccount: "" })
        .success,
    ).toBe(false);
  });
});

describe("assetEventSchema", () => {
  it("discriminates improvements from disposals", () => {
    expect(assetEventSchema.safeParse(SAMPLE_IMPROVEMENT).success).toBe(true);
    expect(assetEventSchema.safeParse({ ...SAMPLE_IMPROVEMENT, kind: "disposal" }).success).toBe(
      true,
    );
    expect(assetEventSchema.safeParse({ ...SAMPLE_IMPROVEMENT, kind: "repair" }).success).toBe(
      false,
    );
  });

  it("requires a component for improvements", () => {
    const { componentId: _omitted, ...withoutComponent } = SAMPLE_IMPROVEMENT;
    expect(assetEventSchema.safeParse(withoutComponent).success).toBe(false);
  });
});
