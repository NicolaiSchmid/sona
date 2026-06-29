import { describe, expect, it } from "vitest";
import { InvalidDecimalError, isValidDecimalString, isZeroDecimal, sumDecimals } from "./decimal";

describe("decimal helpers", () => {
  it("validates decimal strings", () => {
    expect(isValidDecimalString("0")).toBe(true);
    expect(isValidDecimalString("-84.23")).toBe(true);
    expect(isValidDecimalString("1000.00")).toBe(true);
    expect(isValidDecimalString("")).toBe(false);
    expect(isValidDecimalString("1.2.3")).toBe(false);
    expect(isValidDecimalString("1,23")).toBe(false);
    expect(isValidDecimalString("+1")).toBe(false);
    expect(isValidDecimalString("abc")).toBe(false);
  });

  it("sums decimals exactly across scales", () => {
    expect(sumDecimals(["-84.23", "84.23"])).toBe("0.00");
    expect(sumDecimals(["0.1", "0.2"])).toBe("0.3");
    expect(sumDecimals(["1.1", "0.10", "1.000"])).toBe("2.200");
    expect(sumDecimals([])).toBe("0");
    expect(sumDecimals(["10"])).toBe("10");
  });

  it("avoids floating point error", () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754, but must be exact here.
    expect(sumDecimals(["0.1", "0.2", "-0.3"])).toBe("0.0");
  });

  it("detects zero regardless of scale", () => {
    expect(isZeroDecimal("0")).toBe(true);
    expect(isZeroDecimal("0.00")).toBe(true);
    expect(isZeroDecimal("-0")).toBe(true);
    expect(isZeroDecimal("0.01")).toBe(false);
  });

  it("throws InvalidDecimalError on bad input", () => {
    expect(() => sumDecimals(["nope"])).toThrow(InvalidDecimalError);
  });
});
