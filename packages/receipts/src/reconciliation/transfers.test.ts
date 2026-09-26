import { describe, expect, it } from "vitest";
import type { MatchableTransaction } from "./matches.js";
import {
  DEFAULT_TRANSFER_AUTO_APPLY_POLICY,
  decideTransferLegs,
  type MatchableCashMovement,
  reconcileTransferLegs,
  scoreTransferLegs,
} from "./transfers.js";

function bankTx(overrides: Partial<MatchableTransaction> = {}): MatchableTransaction {
  return {
    id: "tx_1",
    amount: "-2000.00",
    currency: "EUR",
    bookedOn: "2026-03-01",
    valueDate: "2026-03-01",
    counterpartyName: "Demo Broker Bank",
    remittanceInfo: "Einzahlung Verrechnungskonto",
    account: "Suspense:Unclassified",
    sourceReliability: 0.9,
    ...overrides,
  };
}

function deposit(overrides: Partial<MatchableCashMovement> = {}): MatchableCashMovement {
  return {
    id: "mv_1",
    amount: "2000.00",
    currency: "EUR",
    date: "2026-03-01",
    brokerName: "Demo Broker",
    note: undefined,
    sourceReliability: 0.9,
    ...overrides,
  };
}

function env() {
  let n = 0;
  return { ids: () => `rev_${n++}`, nowIso: () => "2026-03-05T00:00:00Z" };
}

describe("scoreTransferLegs", () => {
  it("scores a same-day exact deposit funded by a bank outflow at 1.0", () => {
    const score = scoreTransferLegs(bankTx(), deposit());
    expect(score.exactAmount).toBe(true);
    expect(score.score).toBe(1);
    expect(score.blockers).toEqual([]);
    expect(score.reasons).toContain("broker name in counterparty/remittance");
  });

  it("pairs a bank inflow with a broker withdrawal", () => {
    const score = scoreTransferLegs(bankTx({ amount: "300.00" }), deposit({ amount: "-300.00" }));
    expect(score.blockers).toEqual([]);
    expect(score.exactAmount).toBe(true);
  });

  it("blocks same-direction, cross-currency, and zero pairs", () => {
    expect(scoreTransferLegs(bankTx({ amount: "2000.00" }), deposit()).blockers).toEqual([
      expect.stringMatching(/same direction/),
    ]);
    expect(scoreTransferLegs(bankTx({ currency: "USD" }), deposit()).blockers).toEqual([
      "currency mismatch",
    ]);
    expect(scoreTransferLegs(bankTx({ amount: "0.00" }), deposit()).blockers).toEqual([
      "zero amount",
    ]);
  });

  it("decays the date contribution and drops it outside the window", () => {
    const near = scoreTransferLegs(bankTx({ bookedOn: "2026-03-02" }), deposit());
    const far = scoreTransferLegs(bankTx({ bookedOn: "2026-03-20" }), deposit());
    expect(near.score).toBeLessThan(1);
    expect(near.score).toBeGreaterThan(far.score);
    expect(far.reasons).toContain("date 19 days apart");
  });

  it("warns on unknown currency and low reliability so the pair is held for review", () => {
    const score = scoreTransferLegs(bankTx({ currency: " " }), deposit({ sourceReliability: 0.2 }));
    expect(score.warnings).toEqual(["unknown currency", "low source reliability"]);
  });
});

describe("decideTransferLegs", () => {
  it("auto-matches a same-day exact transfer under the default policy", () => {
    expect(decideTransferLegs(bankTx(), deposit()).outcome).toBe("auto_match");
  });

  it("holds an exact transfer for review when the dates drift", () => {
    const result = decideTransferLegs(bankTx({ bookedOn: "2026-03-03" }), deposit());
    expect(result.outcome).toBe("review");
    expect(result.reasons.join(" ")).toMatch(/needs review/);
  });

  it("holds a large transfer for review even when it scores 1.0", () => {
    const result = decideTransferLegs(
      bankTx({ amount: "-25000.00" }),
      deposit({ amount: "25000.00" }),
    );
    expect(result.score.score).toBe(1);
    expect(result.outcome).toBe("review");
    expect(result.reasons.join(" ")).toMatch(/exceeds 10000/);
  });

  it("never auto-matches an inexact amount", () => {
    const result = decideTransferLegs(bankTx({ amount: "-1999.00" }), deposit());
    expect(result.outcome).not.toBe("auto_match");
  });

  it("respects a disabled policy", () => {
    const result = decideTransferLegs(bankTx(), deposit(), {
      ...DEFAULT_TRANSFER_AUTO_APPLY_POLICY,
      enabled: false,
    });
    expect(result.outcome).toBe("review");
  });
});

describe("reconcileTransferLegs", () => {
  it("auto-matches the unique counterpart and leaves nothing for review", () => {
    const result = reconcileTransferLegs({
      workspaceId: "ws_1",
      transactions: [bankTx(), bankTx({ id: "tx_other", amount: "-84.23" })],
      movements: [deposit()],
      ...env(),
    });
    expect(result.autoMatched.map((m) => [m.bankTransactionId, m.cashMovementId])).toEqual([
      ["tx_1", "mv_1"],
    ]);
    expect(result.reviewItems).toEqual([]);
    expect(result.unmatchedMovementIds).toEqual([]);
  });

  it("queues an unmatched broker cash movement for review", () => {
    const result = reconcileTransferLegs({
      workspaceId: "ws_1",
      transactions: [bankTx({ amount: "-84.23" })],
      movements: [deposit()],
      ...env(),
    });
    expect(result.autoMatched).toEqual([]);
    expect(result.unmatchedMovementIds).toEqual(["mv_1"]);
    expect(result.reviewItems).toEqual([
      {
        id: "rev_0",
        workspaceId: "ws_1",
        targetType: "portfolio_cash_movement",
        targetId: "mv_1",
        state: "draft",
        reason: expect.objectContaining({ kind: "unmatched_broker_cash_movement" }),
        createdAt: "2026-03-05T00:00:00Z",
        updatedAt: "2026-03-05T00:00:00Z",
      },
    ]);
  });

  it("sends a movement with two plausible bank legs to review instead of guessing", () => {
    const result = reconcileTransferLegs({
      workspaceId: "ws_1",
      transactions: [bankTx(), bankTx({ id: "tx_2", bookedOn: "2026-03-02" })],
      movements: [deposit()],
      ...env(),
    });
    expect(result.autoMatched).toEqual([]);
    expect(result.reviewItems).toHaveLength(1);
    const item = result.reviewItems[0];
    expect(item?.targetType).toBe("transfer_leg_match");
    expect(item?.state).toBe("suggested");
    const reason = item?.reason as { candidates: Array<{ bankTransactionId: string }> };
    expect(reason.candidates.map((c) => c.bankTransactionId).sort()).toEqual(["tx_1", "tx_2"]);
  });

  it("does not let two movements claim the same bank transaction", () => {
    const result = reconcileTransferLegs({
      workspaceId: "ws_1",
      transactions: [bankTx()],
      movements: [deposit(), deposit({ id: "mv_2" })],
      ...env(),
    });
    expect(result.autoMatched).toEqual([]);
    expect(result.reviewItems.map((i) => i.targetId).sort()).toEqual(["mv_1", "mv_2"]);
  });

  it("excludes blocked pairs from the match list", () => {
    const result = reconcileTransferLegs({
      workspaceId: "ws_1",
      transactions: [bankTx({ amount: "2000.00" })],
      movements: [deposit()],
      ...env(),
    });
    expect(result.matches).toEqual([]);
    expect(result.unmatchedMovementIds).toEqual(["mv_1"]);
  });

  it("treats a weak candidate as no counterpart: the movement is queued as unmatched", () => {
    const weak = bankTx({
      id: "tx_weak",
      amount: "-1999.00",
      bookedOn: "2026-03-20",
      counterpartyName: "Unrelated Shop",
      remittanceInfo: undefined,
    });
    const result = reconcileTransferLegs({
      workspaceId: "ws_1",
      transactions: [weak],
      movements: [deposit()],
      ...env(),
    });
    expect(result.matches.map((m) => [m.bankTransactionId, m.outcome])).toEqual([
      ["tx_weak", "candidate"],
    ]);
    expect(result.autoMatched).toEqual([]);
    expect(result.unmatchedMovementIds).toEqual(["mv_1"]);
    expect(result.reviewItems.map((i) => i.targetType)).toEqual(["portfolio_cash_movement"]);
  });

  it("passes score options through so a wider date window is honored", () => {
    const fiveDaysLater = bankTx({ bookedOn: "2026-03-06" });
    const strict = reconcileTransferLegs({
      workspaceId: "ws_1",
      transactions: [fiveDaysLater],
      movements: [deposit()],
      ...env(),
    });
    expect(strict.matches[0]?.score.reasons).toContain("date 5 days apart");
    expect(strict.matches[0]?.score.score).toBe(0.8);

    const wide = reconcileTransferLegs({
      workspaceId: "ws_1",
      transactions: [fiveDaysLater],
      movements: [deposit()],
      scoreOptions: { maxDateDistanceDays: 10 },
      policy: { ...DEFAULT_TRANSFER_AUTO_APPLY_POLICY, maxDateDistanceDays: 10, minScore: 0.9 },
      ...env(),
    });
    expect(wide.matches[0]?.score.reasons).toContain("date within 5 day(s)");
    expect(wide.matches[0]?.score.score).toBe(0.9);
    expect(wide.autoMatched).toHaveLength(1);
  });

  it("scores with the policy's window when no score options are given", () => {
    const fiveDaysLater = bankTx({ bookedOn: "2026-03-06" });
    const result = reconcileTransferLegs({
      workspaceId: "ws_1",
      transactions: [fiveDaysLater],
      movements: [deposit()],
      policy: { ...DEFAULT_TRANSFER_AUTO_APPLY_POLICY, maxDateDistanceDays: 10 },
      ...env(),
    });
    expect(result.matches[0]?.score.reasons).toContain("date within 5 day(s)");
  });

  it("never auto-matches on amount and date alone under the default policy", () => {
    // Same day, exact amount, but the bank counterparty is an unrelated payee:
    // 0.7 + 0.2 = 0.9 < minScore 0.95, so this stays with a human.
    const result = reconcileTransferLegs({
      workspaceId: "ws_1",
      transactions: [bankTx({ counterpartyName: "Landlord Rent", remittanceInfo: "Miete" })],
      movements: [deposit()],
      ...env(),
    });
    expect(result.matches[0]?.score.score).toBe(0.9);
    expect(result.autoMatched).toEqual([]);
    expect(result.reviewItems.map((i) => i.targetType)).toEqual(["transfer_leg_match"]);
  });

  it("auto-matches several movements when each has exactly one counterpart", () => {
    const result = reconcileTransferLegs({
      workspaceId: "ws_1",
      transactions: [bankTx(), bankTx({ id: "tx_2", amount: "300.00", bookedOn: "2026-03-10" })],
      movements: [deposit(), deposit({ id: "mv_2", amount: "-300.00", date: "2026-03-10" })],
      ...env(),
    });
    expect(result.autoMatched.map((m) => [m.bankTransactionId, m.cashMovementId]).sort()).toEqual([
      ["tx_1", "mv_1"],
      ["tx_2", "mv_2"],
    ]);
    expect(result.reviewItems).toEqual([]);
  });

  it("records score, reasons, and scorer version for each review candidate", () => {
    const result = reconcileTransferLegs({
      workspaceId: "ws_1",
      transactions: [bankTx(), bankTx({ id: "tx_2", bookedOn: "2026-03-02" })],
      movements: [deposit()],
      ...env(),
    });
    const reason = result.reviewItems[0]?.reason as {
      kind: string;
      scorerVersion: string;
      candidates: Array<{ bankTransactionId: string; score: number; reasons: string[] }>;
    };
    expect(reason.kind).toBe("transfer_leg_candidates");
    expect(reason.scorerVersion).toBe("transfer-legs@1");
    expect(reason.candidates.map((c) => c.bankTransactionId).sort()).toEqual(["tx_1", "tx_2"]);
    for (const candidate of reason.candidates) {
      expect(candidate.score).toBeGreaterThan(0.9);
    }
    // The same-day pair would have auto-matched alone; the second plausible
    // leg is what holds it for review.
    const contested = reason.candidates.find((c) => c.bankTransactionId === "tx_1");
    expect(contested?.reasons.join(" ")).toMatch(/multiple plausible matches/);
  });
});

describe("decideTransferLegs gates", () => {
  it("treats the review-above amount as inclusive: exactly 10000 may auto-match", () => {
    const atLimit = decideTransferLegs(
      bankTx({ amount: "-10000.00" }),
      deposit({ amount: "10000.00" }),
    );
    expect(atLimit.outcome).toBe("auto_match");
    expect(atLimit.reasons.join(" ")).not.toMatch(/exceeds/);

    const overLimit = decideTransferLegs(
      bankTx({ amount: "-10000.01" }),
      deposit({ amount: "10000.01" }),
    );
    expect(overLimit.outcome).toBe("review");
    expect(overLimit.reasons.join(" ")).toMatch(/exceeds 10000/);
  });

  it("forces review on warnings even for an otherwise perfect pair", () => {
    const unknownCurrency = decideTransferLegs(bankTx({ currency: " " }), deposit());
    expect(unknownCurrency.score.exactAmount).toBe(true);
    expect(unknownCurrency.outcome).toBe("review");
    expect(unknownCurrency.reasons).toContain("unknown currency");

    const unreliable = decideTransferLegs(bankTx({ sourceReliability: 0.1 }), deposit());
    expect(unreliable.outcome).toBe("review");
    expect(unreliable.reasons).toContain("low source reliability");
  });

  it("returns no_match with the blockers as reasons", () => {
    const result = decideTransferLegs(bankTx({ amount: "2000.00" }), deposit());
    expect(result.outcome).toBe("no_match");
    expect(result.reasons).toEqual([expect.stringMatching(/same direction/)]);
  });

  it("classifies a low score as a candidate, not a review item", () => {
    const result = decideTransferLegs(
      bankTx({
        amount: "-1999.00",
        bookedOn: "2026-03-20",
        counterpartyName: "Unrelated Shop",
        remittanceInfo: undefined,
      }),
      deposit(),
    );
    expect(result.score.score).toBe(0);
    expect(result.outcome).toBe("candidate");
    expect(result.reasons.join(" ")).toMatch(/below candidate threshold 0.5/);
  });

  it("never auto-matches when the movement has no date", () => {
    const result = decideTransferLegs(bankTx(), deposit({ date: undefined }));
    expect(result.score.dateDistanceDays).toBeUndefined();
    expect(result.score.exactAmount).toBe(true);
    expect(result.outcome).toBe("review");
  });

  it("scores dates against the policy's window, not the default", () => {
    const wide = decideTransferLegs(bankTx({ bookedOn: "2026-03-06" }), deposit(), {
      ...DEFAULT_TRANSFER_AUTO_APPLY_POLICY,
      maxDateDistanceDays: 10,
      minScore: 0.9,
    });
    expect(wide.score.reasons).toContain("date within 5 day(s)");
    expect(wide.score.score).toBe(0.9);
    expect(wide.outcome).toBe("auto_match");
  });
});

describe("decideTransferLegs default policy thresholds", () => {
  it("needs the broker name on top of an exact same-day amount to auto-match", () => {
    // Amount (0.7) + same day (0.2) = 0.9: exact and in window, but below minScore.
    const unrelated = decideTransferLegs(
      bankTx({ counterpartyName: "Landlord Rent", remittanceInfo: "Miete" }),
      deposit(),
    );
    expect(unrelated.score.score).toBe(0.9);
    expect(unrelated.score.reasons).not.toContain("broker name in counterparty/remittance");
    expect(unrelated.outcome).toBe("review");
    expect(unrelated.reasons.join(" ")).toMatch(/needs review/);

    // The recognizable broker (0.1) lifts the same pair to 1.0 and auto-match.
    const recognized = decideTransferLegs(bankTx(), deposit());
    expect(recognized.score.score).toBe(1);
    expect(recognized.score.reasons).toContain("broker name in counterparty/remittance");
    expect(recognized.outcome).toBe("auto_match");
  });

  it("holds a one-day drift for review even with the broker recognized", () => {
    // 0.7 + 0.2 * (1 - 1/3) + 0.1 = 0.9333 < 0.95.
    const oneDayOff = decideTransferLegs(bankTx({ bookedOn: "2026-03-02" }), deposit());
    expect(oneDayOff.score.exactAmount).toBe(true);
    expect(oneDayOff.score.dateDistanceDays).toBe(1);
    expect(oneDayOff.score.score).toBe(0.9333);
    expect(oneDayOff.outcome).toBe("review");
    expect(oneDayOff.reasons.join(" ")).toMatch(/needs review/);
  });

  it("finds the broker in the remittance text when the counterparty is opaque", () => {
    const viaRemittance = decideTransferLegs(
      bankTx({ counterpartyName: "Clearing 0815", remittanceInfo: "Einzahlung Demo Broker" }),
      deposit(),
    );
    expect(viaRemittance.score.score).toBe(1);
    expect(viaRemittance.outcome).toBe("auto_match");
  });
});

describe("scoreTransferLegs malformed amounts", () => {
  it("blocks a non-decimal amount instead of throwing", () => {
    expect(scoreTransferLegs(bankTx({ amount: "abc" }), deposit()).blockers).toEqual([
      "invalid amount",
    ]);
    expect(scoreTransferLegs(bankTx(), deposit({ amount: "2.000,00" })).blockers).toEqual([
      "invalid amount",
    ]);
    const score = scoreTransferLegs(bankTx({ amount: "" }), deposit());
    expect(score.score).toBe(0);
    expect(score.exactAmount).toBe(false);
  });

  it("lets reconcileTransferLegs continue past a malformed pair and match the others", () => {
    const result = reconcileTransferLegs({
      workspaceId: "ws_1",
      transactions: [bankTx({ id: "tx_bad", amount: "abc" }), bankTx({ id: "tx_ok" })],
      movements: [deposit({ id: "mv_bad", amount: "n/a" }), deposit({ id: "mv_ok" })],
      ...env(),
    });
    expect(result.autoMatched.map((m) => [m.bankTransactionId, m.cashMovementId])).toEqual([
      ["tx_ok", "mv_ok"],
    ]);
    // The malformed movement is queued for review, not dropped or matched.
    expect(result.unmatchedMovementIds).toEqual(["mv_bad"]);
    expect(result.reviewItems.map((r) => r.targetId)).toEqual(["mv_bad"]);
  });
});
