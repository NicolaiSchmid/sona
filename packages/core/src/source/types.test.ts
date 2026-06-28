import { describe, expect, it } from "vitest";
import { createRawSourceRecord, supersedeRawSourceRecord } from "./types";

const baseInput = {
  id: "raw_1",
  workspaceId: "ws_1",
  sourceId: "src_1",
  externalId: "ext_1",
  recordType: "bank_transaction" as const,
  payloadJson: { amount: "-12.00", currency: "EUR" },
  observedAt: "2026-01-02T10:00:00Z",
  createdAt: "2026-01-02T10:00:01Z",
};

describe("raw source records", () => {
  it("computes a stable payload hash independent of key order", () => {
    const a = createRawSourceRecord(baseInput);
    const b = createRawSourceRecord({
      ...baseInput,
      id: "raw_2",
      payloadJson: { currency: "EUR", amount: "-12.00" },
    });
    expect(a.payloadHash).toBe(b.payloadHash);
  });

  it("freezes the record so it cannot be mutated in place", () => {
    const record = createRawSourceRecord(baseInput);
    expect(Object.isFrozen(record)).toBe(true);
    expect(() => {
      // @ts-expect-error - readonly field, runtime mutation must also fail
      record.externalId = "tampered";
    }).toThrow();
    expect(record.externalId).toBe("ext_1");
  });

  it("supersedes via a new appended record without mutating the original", () => {
    const original = createRawSourceRecord(baseInput);
    const correction = supersedeRawSourceRecord(original, {
      id: "raw_2",
      externalId: "ext_1",
      recordType: "bank_transaction",
      payloadJson: { amount: "-12.50", currency: "EUR" },
      observedAt: "2026-01-03T10:00:00Z",
      createdAt: "2026-01-03T10:00:01Z",
    });

    expect(correction.id).toBe("raw_2");
    expect(correction.supersedesRecordId).toBe("raw_1");
    expect(correction.workspaceId).toBe(original.workspaceId);
    expect(correction.payloadHash).not.toBe(original.payloadHash);
    // original is untouched
    expect(original.supersedesRecordId).toBeUndefined();
    expect(original.payloadJson).toEqual({ amount: "-12.00", currency: "EUR" });
  });
});
