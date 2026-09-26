import { describe, expect, it } from "vitest";
import {
  absDecimal,
  decimalsEqual,
  divideRoundHalfAwayFromZero,
  fromScaledBigInt,
  InvalidDecimalError,
  isNegativeDecimal,
  isValidDecimalString,
  isZeroDecimal,
  negateDecimal,
  sumDecimals,
  toScaledBigInt,
} from "./decimal";
import { moneyAmountsEqual } from "./types";

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

describe("scaled bigint helpers", () => {
  it("round-trips decimals through a fixed scale", () => {
    expect(toScaledBigInt("250000", 2)).toBe(25000000n);
    expect(toScaledBigInt("-84.23", 2)).toBe(-8423n);
    expect(toScaledBigInt("2.5", 4)).toBe(25000n);
    expect(fromScaledBigInt(25000000n, 2)).toBe("250000.00");
    expect(fromScaledBigInt(-5n, 2)).toBe("-0.05");
    expect(fromScaledBigInt(7n, 0)).toBe("7");
  });

  it("refuses to drop fractional digits when narrowing", () => {
    expect(() => toScaledBigInt("1.234", 2)).toThrow(/fractional/);
    expect(() => toScaledBigInt("nope", 2)).toThrow(InvalidDecimalError);
  });

  it("negates decimals canonically", () => {
    expect(negateDecimal("6360.00")).toBe("-6360.00");
    expect(negateDecimal("-1.5")).toBe("1.5");
    expect(negateDecimal("0")).toBe("0");
    expect(negateDecimal("0.00")).toBe("0.00");
  });

  it("compares decimals by value, not by textual scale", () => {
    expect(decimalsEqual("6360", "6360.00")).toBe(true);
    expect(decimalsEqual("-0.5", "-0.50")).toBe(true);
    expect(decimalsEqual("0", "-0")).toBe(true);
    expect(decimalsEqual("6360.00", "6360.01")).toBe(false);
    expect(() => decimalsEqual("nope", "1")).toThrow(InvalidDecimalError);
  });

  it("compares money by value and commodity", () => {
    const eur = { amount: "6360", commodity: "EUR" };
    expect(moneyAmountsEqual(eur, { amount: "6360.00", commodity: "EUR" })).toBe(true);
    expect(moneyAmountsEqual(eur, { amount: "6360", commodity: "USD" })).toBe(false);
    expect(moneyAmountsEqual(eur, { amount: "6360.01", commodity: "EUR" })).toBe(false);
  });

  it("divides with deterministic half-away-from-zero rounding", () => {
    expect(divideRoundHalfAwayFromZero(5n, 2n)).toBe(3n);
    expect(divideRoundHalfAwayFromZero(-5n, 2n)).toBe(-3n);
    expect(divideRoundHalfAwayFromZero(4n, 2n)).toBe(2n);
    expect(divideRoundHalfAwayFromZero(7n, 3n)).toBe(2n);
    expect(divideRoundHalfAwayFromZero(8n, 3n)).toBe(3n);
    expect(() => divideRoundHalfAwayFromZero(1n, 0n)).toThrow(RangeError);
  });
});

describe("sign helpers", () => {
  it("detects strictly negative values and treats negative zero as zero", () => {
    expect(isNegativeDecimal("-0.01")).toBe(true);
    expect(isNegativeDecimal("-1")).toBe(true);
    expect(isNegativeDecimal("0")).toBe(false);
    expect(isNegativeDecimal("-0")).toBe(false);
    expect(isNegativeDecimal("-0.00")).toBe(false);
    expect(isNegativeDecimal("1.5")).toBe(false);
    expect(() => isNegativeDecimal("1,5")).toThrow(InvalidDecimalError);
  });

  it("negates to a canonical string, preserving scale and dropping negative zero", () => {
    expect(negateDecimal("84.23")).toBe("-84.23");
    expect(negateDecimal("-84.23")).toBe("84.23");
    expect(negateDecimal("-0")).toBe("0");
    expect(negateDecimal("-0.00")).toBe("0.00");
    expect(negateDecimal("0.00")).toBe("0.00");
    expect(negateDecimal("007.50")).toBe("-7.50");
    expect(negateDecimal("0.5")).toBe("-0.5");
    expect(() => negateDecimal("")).toThrow(InvalidDecimalError);
    expect(() => negateDecimal("+1")).toThrow(InvalidDecimalError);
  });

  it("takes the absolute value canonically", () => {
    expect(absDecimal("-84.23")).toBe("84.23");
    expect(absDecimal("84.23")).toBe("84.23");
    expect(absDecimal("-0")).toBe("0");
    expect(absDecimal("-0.00")).toBe("0.00");
    expect(absDecimal("-000.10")).toBe("0.10");
    expect(absDecimal("-1000")).toBe("1000");
    expect(() => absDecimal("abc")).toThrow(InvalidDecimalError);
  });

  it("round-trips negate and abs without changing zero-padded scale", () => {
    for (const value of ["-0.10", "12.000", "-5", "0.0"]) {
      expect(negateDecimal(negateDecimal(value))).toBe(value);
      expect(isNegativeDecimal(absDecimal(value))).toBe(false);
    }
  });
});
