import { createRawSourceRecord } from "@sona/core";
import { describe, expect, it } from "vitest";
import {
  bankAccountId,
  bankTransactionId,
  createWorkspaceBankRecordStore,
  SqliteBankRecordRepository,
} from "./bank-records.js";
import { SqliteRawRecordRepository } from "./raw-records.js";
import { createTestDatabase, type TestDatabase } from "./test-support.js";
import type { NormalizedTransaction } from "./types.js";

const T0 = "2026-02-01T00:00:00Z";

function transaction(overrides: Partial<NormalizedTransaction> = {}): NormalizedTransaction {
  return {
    accountExternalId: "acct_a",
    externalId: "txn",
    bookedOn: "2026-02-10",
    valueDate: "2026-02-10",
    amount: "-10.00",
    currency: "EUR",
    status: "BOOK",
    counterpartyName: "Synthetic Vendor",
    remittanceInfo: undefined,
    raw: {},
    ...overrides,
  };
}

/** Seeds one raw record per workspace and returns a store bound to `ws_1`. */
async function seed(t: TestDatabase) {
  const rawRepo = new SqliteRawRecordRepository(t.db);
  const bankRepo = new SqliteBankRecordRepository(t.db);
  for (const [workspaceId, sourceId] of [
    ["ws_1", "src_1"],
    ["ws_2", "src_2"],
  ] as const) {
    await rawRepo.append(
      createRawSourceRecord({
        id: `raw_${workspaceId}`,
        workspaceId,
        sourceId,
        externalId: "page-0",
        recordType: "bank_transaction",
        payloadJson: { page: 0 },
        observedAt: T0,
        createdAt: T0,
      }),
    );
  }
  return {
    bankRepo,
    ws1: createWorkspaceBankRecordStore(bankRepo, "ws_1"),
    ws2: createWorkspaceBankRecordStore(bankRepo, "ws_2"),
  };
}

describe("bank record ids", () => {
  it("derive deterministic primary keys from source, account, and external ids", () => {
    expect(bankAccountId("src_1", "acct_a")).toBe("bank_account:src_1:acct_a");
    expect(bankTransactionId("src_1", "acct_a", "txn_1")).toBe(
      "bank_transaction:src_1:acct_a:txn_1",
    );
  });
});

describe("SqliteBankRecordRepository.listTransactions", () => {
  it("returns the row id, orders by the effective date, and falls back to value_date when booked_on is unknown", async () => {
    const t = createTestDatabase();
    try {
      const { bankRepo, ws1 } = await seed(t);
      const link = { rawRecordId: "raw_ws_1" };
      await ws1.saveTransaction(transaction({ externalId: "late", bookedOn: "2026-03-01" }), link);
      await ws1.saveTransaction(transaction({ externalId: "early", bookedOn: "2026-01-05" }), link);
      // No booking date yet: the value date positions it.
      await ws1.saveTransaction(
        transaction({ externalId: "value_only", bookedOn: undefined, valueDate: "2026-02-01" }),
        link,
      );
      // Neither date: undated.
      await ws1.saveTransaction(
        transaction({ externalId: "undated", bookedOn: undefined, valueDate: undefined }),
        link,
      );

      const all = await bankRepo.listTransactions("ws_1");
      expect(all.map((row) => row.externalId)).toEqual(["undated", "early", "value_only", "late"]);
      expect(all[1]?.id).toBe(bankTransactionId("src_1", "acct_a", "early"));

      // The window is applied to COALESCE(booked_on, value_date), inclusive on both ends.
      const windowed = await bankRepo.listTransactions("ws_1", {
        from: "2026-02-01",
        to: "2026-03-01",
      });
      expect(windowed.map((row) => row.externalId)).toEqual(["value_only", "late"]);
      expect(
        (await bankRepo.listTransactions("ws_1", { from: "2026-01-06" })).map(
          (row) => row.externalId,
        ),
      ).toEqual(["value_only", "late"]);
      expect(
        (await bankRepo.listTransactions("ws_1", { to: "2026-01-31" })).map(
          (row) => row.externalId,
        ),
      ).toEqual(["early"]);
      // Undated rows never satisfy a window bound.
      expect(
        (await bankRepo.listTransactions("ws_1", { from: "2000-01-01" })).some(
          (row) => row.externalId === "undated",
        ),
      ).toBe(false);
    } finally {
      t.close();
    }
  });

  it("honours the limit after ordering and rejects a non-positive one", async () => {
    const t = createTestDatabase();
    try {
      const { bankRepo, ws1 } = await seed(t);
      const link = { rawRecordId: "raw_ws_1" };
      await ws1.saveTransaction(transaction({ externalId: "c", bookedOn: "2026-02-03" }), link);
      await ws1.saveTransaction(transaction({ externalId: "a", bookedOn: "2026-02-01" }), link);
      await ws1.saveTransaction(transaction({ externalId: "b", bookedOn: "2026-02-02" }), link);

      expect(
        (await bankRepo.listTransactions("ws_1", { limit: 2 })).map((row) => row.externalId),
      ).toEqual(["a", "b"]);
      await expect(bankRepo.listTransactions("ws_1", { limit: 0 })).rejects.toThrow(
        /positive integer/,
      );
      await expect(bankRepo.listTransactions("ws_1", { limit: 1.5 })).rejects.toThrow(
        /positive integer/,
      );
    } finally {
      t.close();
    }
  });

  it("spans sources and accounts within one workspace but never crosses workspaces", async () => {
    const t = createTestDatabase();
    try {
      const { bankRepo, ws1, ws2 } = await seed(t);
      await ws1.saveTransaction(transaction({ accountExternalId: "acct_a", externalId: "t1" }), {
        rawRecordId: "raw_ws_1",
      });
      await ws1.saveTransaction(transaction({ accountExternalId: "acct_b", externalId: "t2" }), {
        rawRecordId: "raw_ws_1",
      });
      await ws2.saveTransaction(transaction({ externalId: "t_other" }), {
        rawRecordId: "raw_ws_2",
      });

      const ws1Rows = await bankRepo.listTransactions("ws_1");
      expect(ws1Rows.map((row) => [row.accountExternalId, row.externalId])).toEqual([
        ["acct_a", "t1"],
        ["acct_b", "t2"],
      ]);
      expect(ws1Rows.every((row) => row.workspaceId === "ws_1")).toBe(true);
      expect((await bankRepo.listTransactions("ws_2")).map((row) => row.externalId)).toEqual([
        "t_other",
      ]);
      expect(await bankRepo.listTransactions("ws_3")).toEqual([]);
    } finally {
      t.close();
    }
  });
});
