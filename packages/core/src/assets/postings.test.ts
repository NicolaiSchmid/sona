import { describe, expect, it } from "vitest";
import { evidenceLinkSchema } from "../evidence/types";
import { validateBalancedTransaction } from "../ledger/balance";
import { SAMPLE_DISPOSAL, SAMPLE_PROPERTY, SAMPLE_PROPERTY_CONFIG } from "./fixtures";
import {
  buildDepreciationDraft,
  depreciationTransactionId,
  planDepreciationDrafts,
  type RecordedDepreciation,
} from "./postings";
import { computeDepreciationSchedule, type DepreciationScheduleRow } from "./schedule";

const CREATED_AT = "2026-01-05T09:00:00Z";
const schedule = computeDepreciationSchedule({
  asset: SAMPLE_PROPERTY,
  config: SAMPLE_PROPERTY_CONFIG,
});

function rowFor(year: number): DepreciationScheduleRow {
  const row = schedule.rows.find((r) => r.year === year);
  if (row === undefined) {
    throw new Error(`no row for ${year}`);
  }
  return row;
}

describe("buildDepreciationDraft", () => {
  const draft = buildDepreciationDraft({
    asset: SAMPLE_PROPERTY,
    config: SAMPLE_PROPERTY_CONFIG,
    schedule,
    row: rowFor(2025),
    createdAt: CREATED_AT,
  });

  it("produces a balanced expense vs accumulated-depreciation transaction", () => {
    expect(validateBalancedTransaction(draft.transaction.postings).balanced).toBe(true);
    expect(draft.transaction.postings).toHaveLength(2);
    const [expense, accumulated] = draft.transaction.postings;
    expect(expense?.account).toBe("Expenses:RealEstate:Depreciation:Musterstrasse 1");
    expect(expense?.amount).toEqual({ amount: "6360.00", commodity: "EUR" });
    expect(accumulated?.account).toBe("Assets:RealEstate:Musterstrasse 1:AccumulatedDepreciation");
    expect(accumulated?.amount).toEqual({ amount: "-6360.00", commodity: "EUR" });
  });

  it("is a draft that requires review and says so", () => {
    expect(draft.transaction.reviewState).toBe("draft");
    expect(draft.transaction.description).toContain("Suggested depreciation 2025");
    expect(draft.transaction.description).toContain("review required");
    expect(draft.transaction.description).toContain("configured schedule v1");
    expect(draft.transaction.description.toLowerCase()).not.toContain("deductible");
    for (const posting of draft.transaction.postings) {
      expect(posting.memo).toContain("configured rule v1");
    }
  });

  it("books on 31 December of the schedule year in the asset's workspace", () => {
    expect(draft.transaction.bookedOn).toBe("2025-12-31");
    expect(draft.transaction.workspaceId).toBe("ws_1");
    expect(draft.transaction.createdAt).toBe(CREATED_AT);
  });

  it("uses deterministic ids so regeneration is reproducible", () => {
    expect(draft.transaction.id).toBe(depreciationTransactionId("asset_flat", 1, 2025));
    expect(draft.transaction.postings.map((p) => p.id)).toEqual([
      "depr:asset_flat:v1:2025:expense",
      "depr:asset_flat:v1:2025:accumulated",
    ]);
    for (const posting of draft.transaction.postings) {
      expect(posting.transactionId).toBe(draft.transaction.id);
    }
  });

  it("links the transaction to its schedule config and evidence documents", () => {
    for (const link of draft.evidenceLinks) {
      expect(() => evidenceLinkSchema.parse(link)).not.toThrow();
      expect(link.workspaceId).toBe("ws_1");
    }
    const generated = draft.evidenceLinks.find((l) => l.kind === "generated_from");
    expect(generated).toMatchObject({
      fromType: "ledger_transaction",
      fromId: draft.transaction.id,
      toType: "asset_depreciation_schedule",
      toId: "cfg_flat_v1",
    });
    const substantiating = draft.evidenceLinks.filter((l) => l.kind === "substantiates");
    expect(substantiating.map((l) => l.fromId)).toEqual([
      "doc_purchase_contract",
      "doc_transfer_tax",
      "doc_notary",
    ]);
    for (const link of substantiating) {
      expect(link.fromType).toBe("document");
      expect(link.toId).toBe(draft.transaction.id);
    }
  });

  it("books a disposal-year draft on the disposal date", () => {
    const disposed = computeDepreciationSchedule({
      asset: SAMPLE_PROPERTY,
      config: SAMPLE_PROPERTY_CONFIG,
      events: [SAMPLE_DISPOSAL],
    });
    const last = disposed.rows[disposed.rows.length - 1];
    if (last === undefined) {
      throw new Error("expected rows");
    }
    const d = buildDepreciationDraft({
      asset: SAMPLE_PROPERTY,
      config: SAMPLE_PROPERTY_CONFIG,
      schedule: disposed,
      row: last,
      createdAt: CREATED_AT,
    });
    expect(d.transaction.bookedOn).toBe("2027-04-20");
  });

  it("rejects a schedule computed for a different asset or config", () => {
    expect(() =>
      buildDepreciationDraft({
        asset: { ...SAMPLE_PROPERTY, id: "asset_other" },
        config: SAMPLE_PROPERTY_CONFIG,
        schedule,
        row: rowFor(2025),
        createdAt: CREATED_AT,
      }),
    ).toThrow(/does not belong/);
  });
});

describe("planDepreciationDrafts", () => {
  it("creates one draft per asset-year up to the requested year", () => {
    const plan = planDepreciationDrafts({
      asset: SAMPLE_PROPERTY,
      config: SAMPLE_PROPERTY_CONFIG,
      schedule,
      recorded: [],
      throughYear: 2026,
      createdAt: CREATED_AT,
    });
    expect(plan.create.map((d) => d.year)).toEqual([2024, 2025, 2026]);
    expect(plan.skipped).toEqual([]);
    expect(plan.discrepancies).toEqual([]);
    for (const draft of plan.create) {
      expect(draft.transaction.reviewState).toBe("draft");
      expect(validateBalancedTransaction(draft.transaction.postings).balanced).toBe(true);
    }
  });

  it("is idempotent: recorded years are skipped, never rebuilt", () => {
    const recorded: RecordedDepreciation[] = [
      {
        year: 2024,
        transactionId: "depr:asset_flat:v1:2024",
        amount: { amount: "3180.00", commodity: "EUR" },
        reviewState: "user_reviewed",
      },
      {
        year: 2025,
        transactionId: "depr:asset_flat:v1:2025",
        amount: { amount: "6360.0", commodity: "EUR" },
        reviewState: "draft",
      },
    ];
    const plan = planDepreciationDrafts({
      asset: SAMPLE_PROPERTY,
      config: SAMPLE_PROPERTY_CONFIG,
      schedule,
      recorded,
      throughYear: 2026,
      createdAt: CREATED_AT,
    });
    expect(plan.create.map((d) => d.year)).toEqual([2026]);
    expect(plan.skipped.map((s) => s.year)).toEqual([2024, 2025]);
    // "6360.0" and "6360.00" are the same amount; no discrepancy.
    expect(plan.discrepancies).toEqual([]);
  });

  it("reports, but does not correct, a reviewed year that disagrees with the recomputed schedule", () => {
    const recorded: RecordedDepreciation[] = [
      {
        year: 2025,
        transactionId: "tx_manual_2025",
        amount: { amount: "6000.00", commodity: "EUR" },
        reviewState: "user_reviewed",
      },
    ];
    const plan = planDepreciationDrafts({
      asset: SAMPLE_PROPERTY,
      config: SAMPLE_PROPERTY_CONFIG,
      schedule,
      recorded,
      throughYear: 2025,
      createdAt: CREATED_AT,
    });
    expect(plan.create.map((d) => d.year)).toEqual([2024]);
    expect(plan.skipped).toEqual([
      { year: 2025, transactionId: "tx_manual_2025", reason: "already_recorded" },
    ]);
    expect(plan.discrepancies).toEqual([
      {
        year: 2025,
        transactionId: "tx_manual_2025",
        recordedAmount: "6000.00",
        scheduledAmount: "6360.00",
        reviewState: "user_reviewed",
        resolution: "adjustment_posting_required",
      },
    ]);
  });

  it("treats a superseded recording as absent so the year can be regenerated", () => {
    const plan = planDepreciationDrafts({
      asset: SAMPLE_PROPERTY,
      config: SAMPLE_PROPERTY_CONFIG,
      schedule,
      recorded: [
        {
          year: 2024,
          transactionId: "tx_old",
          amount: { amount: "1.00", commodity: "EUR" },
          reviewState: "superseded",
        },
      ],
      throughYear: 2024,
      createdAt: CREATED_AT,
    });
    expect(plan.create.map((d) => d.year)).toEqual([2024]);
    expect(plan.discrepancies).toEqual([]);
  });
});
