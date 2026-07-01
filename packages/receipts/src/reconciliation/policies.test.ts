import { describe, expect, it } from "vitest";
import type { MatchableTransaction, MatchScore } from "./matches.js";
import { accountMatchesPattern, DEFAULT_AUTO_APPLY_POLICY, decideMatch } from "./policies.js";

function strongScore(overrides: Partial<MatchScore> = {}): MatchScore {
  return {
    score: 0.99,
    exactAmount: true,
    dateDistanceDays: 1,
    reasons: ["exact amount"],
    blockers: [],
    ...overrides,
  };
}

function tx(overrides: Partial<MatchableTransaction> = {}): MatchableTransaction {
  return {
    id: "tx_1",
    amount: "-84.23",
    currency: "EUR",
    bookedOn: "2026-01-15",
    valueDate: "2026-01-15",
    counterpartyName: "Vendor",
    remittanceInfo: undefined,
    account: "Expenses:WorkRelated",
    sourceReliability: 0.9,
    ...overrides,
  };
}

describe("accountMatchesPattern", () => {
  it("supports exact and prefix (`*`) patterns", () => {
    expect(accountMatchesPattern("Expenses:Medical:Dentist", "Expenses:Medical:*")).toBe(true);
    expect(accountMatchesPattern("Expenses:Medical", "Expenses:Medical:*")).toBe(false);
    expect(accountMatchesPattern("Expenses:TaxAdvice", "Expenses:TaxAdvice")).toBe(true);
    expect(accountMatchesPattern("Expenses:WorkRelated", "Expenses:Medical:*")).toBe(false);
  });
});

describe("decideMatch", () => {
  it("auto-applies a strong, exact, in-window, low-value match", () => {
    const result = decideMatch({ score: strongScore(), transaction: tx() });
    expect(result.outcome).toBe("auto_match");
  });

  it("forces review for a high-value amount", () => {
    const result = decideMatch({ score: strongScore(), transaction: tx({ amount: "-2500.00" }) });
    expect(result.outcome).toBe("review");
    expect(result.reasons.join(" ")).toContain("exceeds");
  });

  it("forces review for real-estate improvement postings", () => {
    const result = decideMatch({
      score: strongScore(),
      transaction: tx({ account: "Expenses:RealEstate:Improvements" }),
    });
    expect(result.outcome).toBe("review");
  });

  it("forces review for medical documents via glob", () => {
    const result = decideMatch({
      score: strongScore(),
      transaction: tx({ account: "Expenses:Medical:Dentist" }),
    });
    expect(result.outcome).toBe("review");
  });

  it("treats a low score as a weak candidate", () => {
    const result = decideMatch({ score: strongScore({ score: 0.3 }), transaction: tx() });
    expect(result.outcome).toBe("candidate");
  });

  it("returns no_match when there is a blocker", () => {
    const result = decideMatch({
      score: strongScore({ blockers: ["currency mismatch"] }),
      transaction: tx(),
    });
    expect(result.outcome).toBe("no_match");
  });

  it("never auto-applies when the policy is disabled", () => {
    const result = decideMatch({
      score: strongScore(),
      transaction: tx(),
      policy: { ...DEFAULT_AUTO_APPLY_POLICY, enabled: false },
    });
    expect(result.outcome).toBe("review");
  });

  it("requires an exact amount to auto-apply under the default policy", () => {
    const result = decideMatch({
      score: strongScore({ exactAmount: false }),
      transaction: tx(),
    });
    expect(result.outcome).toBe("review");
  });
});
