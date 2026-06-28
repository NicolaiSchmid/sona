import { describe, expect, it } from "vitest";
import { validateBalancedTransaction } from "./balance";

const eur = (amount: string) => ({ amount: { amount, commodity: "EUR" } });
const usd = (amount: string) => ({ amount: { amount, commodity: "USD" } });

describe("validateBalancedTransaction", () => {
  it("passes when two EUR postings sum to zero", () => {
    const result = validateBalancedTransaction([eur("-84.23"), eur("84.23")]);
    expect(result.balanced).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.totalsByCommodity).toEqual({ EUR: "0.00" });
  });

  it("fails when the EUR sum is non-zero", () => {
    const result = validateBalancedTransaction([eur("-84.23"), eur("80.00")]);
    expect(result.balanced).toBe(false);
    expect(result.errors[0]).toContain("EUR does not balance");
    expect(result.totalsByCommodity["EUR"]).toBe("-4.23");
  });

  it("balances commodities independently", () => {
    const balanced = validateBalancedTransaction([
      eur("-100.00"),
      eur("100.00"),
      usd("-50.00"),
      usd("50.00"),
    ]);
    expect(balanced.balanced).toBe(true);

    const oneOff = validateBalancedTransaction([
      eur("-100.00"),
      eur("100.00"),
      usd("-50.00"),
      usd("49.99"),
    ]);
    expect(oneOff.balanced).toBe(false);
    expect(oneOff.errors.join(" ")).toContain("USD does not balance");
    expect(oneOff.errors.join(" ")).not.toContain("EUR does not balance");
  });

  it("sums amounts with differing scales exactly", () => {
    const result = validateBalancedTransaction([eur("-1.1"), eur("0.10"), eur("1.000")]);
    expect(result.totalsByCommodity["EUR"]).toBe("0.000");
    expect(result.balanced).toBe(true);
  });

  it("fails clearly on an invalid decimal string", () => {
    const result = validateBalancedTransaction([eur("not-a-number"), eur("84.23")]);
    expect(result.balanced).toBe(false);
    expect(result.errors[0]).toContain("invalid amount");
  });

  it("rejects an empty posting list", () => {
    const result = validateBalancedTransaction([]);
    expect(result.balanced).toBe(false);
    expect(result.errors[0]).toContain("no postings");
  });
});
