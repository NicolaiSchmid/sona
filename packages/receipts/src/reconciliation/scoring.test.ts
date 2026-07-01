import { describe, expect, it } from "vitest";
import type { MatchableDocument, MatchableTransaction } from "./matches.js";
import { scoreMatch, vendorSimilarity } from "./scoring.js";

function tx(overrides: Partial<MatchableTransaction> = {}): MatchableTransaction {
  return {
    id: "tx_1",
    amount: "-84.23",
    currency: "EUR",
    bookedOn: "2026-01-15",
    valueDate: "2026-01-15",
    counterpartyName: "AMAZON MARKETPLACE",
    remittanceInfo: "Rechnung 2026-0042",
    account: "Expenses:WorkRelated",
    sourceReliability: 0.9,
    ...overrides,
  };
}

function doc(overrides: Partial<MatchableDocument> = {}): MatchableDocument {
  return {
    id: "doc_1",
    totalAmount: "84.23",
    currency: "EUR",
    documentDate: "2026-01-15",
    dueDate: undefined,
    vendorName: "Amazon EU SARL",
    invoiceNumber: "2026-0042",
    paymentReference: undefined,
    confidence: 0.9,
    sourceReliability: 0.8,
    ...overrides,
  };
}

describe("scoreMatch", () => {
  it("scores a fully aligned pair near 1.0 with an exact amount", () => {
    const result = scoreMatch(tx(), doc());
    expect(result.exactAmount).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0.97);
    expect(result.reasons).toContain("exact amount");
    expect(result.blockers).toEqual([]);
  });

  it("blocks on a currency mismatch", () => {
    const result = scoreMatch(tx({ currency: "EUR" }), doc({ currency: "USD" }));
    expect(result.score).toBe(0);
    expect(result.blockers).toContain("currency mismatch");
  });

  it("lowers the score as the date distance grows", () => {
    const near = scoreMatch(tx(), doc({ documentDate: "2026-01-15" }));
    const far = scoreMatch(tx(), doc({ documentDate: "2026-03-15" }));
    expect(far.score).toBeLessThan(near.score);
    expect(far.exactAmount).toBe(true); // amount still matches
  });

  it("credits a matching amount even without a date", () => {
    const result = scoreMatch(tx({ bookedOn: undefined }), doc({ documentDate: undefined }));
    expect(result.exactAmount).toBe(true);
    expect(result.dateDistanceDays).toBeUndefined();
  });

  it("does not credit a mismatched amount", () => {
    const result = scoreMatch(tx({ amount: "-10.00" }), doc({ totalAmount: "84.23" }));
    expect(result.exactAmount).toBe(false);
    expect(result.reasons).not.toContain("exact amount");
  });
});

describe("vendorSimilarity", () => {
  it("scores related vendor names positively", () => {
    expect(vendorSimilarity("Amazon EU SARL", "AMAZON MARKETPLACE")).toBeGreaterThan(0);
  });

  it("scores unrelated vendors at zero", () => {
    expect(vendorSimilarity("Rewe Markt", "Amazon")).toBe(0);
    expect(vendorSimilarity(undefined, "Amazon")).toBe(0);
  });
});
