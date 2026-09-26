import { DEFAULT_ACCOUNTS, type EvidenceLink } from "@sona/core";
import { describe, expect, it } from "vitest";
import type { DbClient } from "../runner.js";
import { type AuditEvent, SqliteAuditEventRepository } from "./audit-events.js";
import { EVIDENCE_RECORD_TYPES, SqliteEvidenceLinkRepository } from "./evidence-links.js";
import { requiredNumber, row, withTransaction, withTransactionAsync } from "./helpers.js";
import {
  type CreateLedgerTransactionInput,
  LedgerError,
  type LedgerPostingInput,
  SqliteLedgerRepository,
  UnbalancedLedgerTransactionError,
} from "./ledger.js";
import { SqliteReviewEventRepository } from "./review-events.js";
import { createTestDatabase } from "./test-support.js";

const AT = "2026-02-01T00:00:00Z";

const eur = (account: string, amount: string, memo?: string): LedgerPostingInput => ({
  account,
  amount: { amount, commodity: "EUR" },
  ...(memo === undefined ? {} : { memo }),
});
const usd = (account: string, amount: string): LedgerPostingInput => ({
  account,
  amount: { amount, commodity: "USD" },
});

const BANK = "Assets:Bank";
const SUSPENSE = "Suspense:Unclassified";
const MAINTENANCE = "Expenses:RealEstate:Maintenance";

async function seedAccounts(ledger: SqliteLedgerRepository, workspaceId: string): Promise<void> {
  await ledger.ensureDefaultAccounts(workspaceId, {
    createdAt: AT,
    accountId: (path) => `acct:${workspaceId}:${path}`,
  });
}

function draft(
  id: string,
  overrides: Partial<CreateLedgerTransactionInput> = {},
): CreateLedgerTransactionInput {
  return {
    id,
    bookedOn: "2026-02-01",
    description: `Synthetic transaction ${id}`,
    postings: [eur(BANK, "-84.23"), eur(SUSPENSE, "84.23")],
    createdAt: AT,
    ...overrides,
  };
}

function count(db: DbClient, table: string, workspaceId: string): number {
  const result = row(
    db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(workspaceId),
  );
  if (result === undefined) {
    throw new Error("count query returned no row");
  }
  return requiredNumber(result, "n");
}

function auditEvent(id: string, overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id,
    workspaceId: "ws_1",
    action: "ledger.transaction.created",
    actor: "user:test",
    targetType: "ledger_transaction",
    targetId: "tx_1",
    metadata: { postings: 2 },
    createdAt: AT,
    ...overrides,
  };
}

describe("SqliteLedgerRepository accounts", () => {
  it("installs the default account tree idempotently and infers kinds from paths", async () => {
    const t = createTestDatabase();
    try {
      const ledger = new SqliteLedgerRepository(t.db);
      await seedAccounts(ledger, "ws_1");
      await seedAccounts(ledger, "ws_1");

      const accounts = await ledger.listAccounts("ws_1");
      expect(accounts).toHaveLength(DEFAULT_ACCOUNTS.length);
      expect(await ledger.getAccountByPath("ws_1", "Suspense:NeedsReceipt")).toMatchObject({
        kind: "suspense",
        receiptRequired: true,
      });
      expect(await ledger.listAccounts("ws_2")).toEqual([]);

      const created = await ledger.upsertAccount("ws_1", {
        id: "acct_giro",
        path: "Assets:Bank:DKB:Giro",
        commodity: "EUR",
        createdAt: AT,
      });
      expect(created).toMatchObject({ id: "acct_giro", kind: "asset", commodity: "EUR" });
      const updated = await ledger.upsertAccount("ws_1", {
        id: "acct_other_id",
        path: "Assets:Bank:DKB:Giro",
        receiptRequired: true,
        createdAt: AT,
      });
      expect(updated).toMatchObject({
        id: "acct_giro",
        receiptRequired: true,
        commodity: undefined,
      });
    } finally {
      t.close();
    }
  });

  it("rejects invalid paths, uninferable kinds, and kinds that contradict the root", async () => {
    const t = createTestDatabase();
    try {
      const ledger = new SqliteLedgerRepository(t.db);
      await expect(
        ledger.upsertAccount("ws_1", { id: "a", path: "Assets::Giro", createdAt: AT }),
      ).rejects.toThrow(/invalid ledger account path/i);
      await expect(
        ledger.upsertAccount("ws_1", { id: "a", path: "Mystery:Box", createdAt: AT }),
      ).rejects.toThrow(/no inferable kind/i);
      await expect(
        ledger.upsertAccount("ws_1", {
          id: "a",
          path: "Assets:Bank",
          kind: "expense",
          createdAt: AT,
        }),
      ).rejects.toThrow(/conflicts with the root/i);
      expect(
        await ledger.upsertAccount("ws_1", {
          id: "a",
          path: "Mystery:Box",
          kind: "asset",
          createdAt: AT,
        }),
      ).toMatchObject({ kind: "asset" });
    } finally {
      t.close();
    }
  });

  it("keeps existing account ids when the default tree is re-installed with another id generator", async () => {
    const t = createTestDatabase();
    try {
      const ledger = new SqliteLedgerRepository(t.db);
      await seedAccounts(ledger, "ws_1");
      await ledger.upsertAccount("ws_1", {
        id: "acct_giro",
        path: "Assets:Bank:DKB:Giro",
        createdAt: AT,
      });

      const reinstalled = await ledger.ensureDefaultAccounts("ws_1", {
        createdAt: "2026-03-01T00:00:00Z",
        accountId: (path) => `other:${path}`,
      });

      expect(reinstalled.map((account) => account.id)).toEqual(
        DEFAULT_ACCOUNTS.map((account) => `acct:ws_1:${account.path}`),
      );
      expect(count(t.db, "ledger_accounts", "ws_1")).toBe(DEFAULT_ACCOUNTS.length + 1);
      expect(
        t.db.prepare("SELECT COUNT(*) AS n FROM ledger_accounts WHERE id LIKE 'other:%'").get(),
      ).toEqual({ n: 0 });
      expect(await ledger.getAccountByPath("ws_1", "Assets:Bank:DKB:Giro")).toMatchObject({
        id: "acct_giro",
      });
    } finally {
      t.close();
    }
  });

  it("never overwrites a user-configured account when re-installing defaults", async () => {
    const t = createTestDatabase();
    try {
      const ledger = new SqliteLedgerRepository(t.db);
      await seedAccounts(ledger, "ws_1");
      // The user tightens receipt policy and restricts a bank account's commodity.
      await ledger.upsertAccount("ws_1", {
        id: "ignored",
        path: "Expenses:Insurance",
        receiptRequired: true,
        commodity: "EUR",
        createdAt: AT,
      });

      await seedAccounts(ledger, "ws_1");
      const ensured = await ledger.ensureAccount("ws_1", {
        id: "ignored_too",
        path: "Expenses:Insurance",
        receiptRequired: false,
        createdAt: AT,
      });

      expect(ensured).toMatchObject({
        id: "acct:ws_1:Expenses:Insurance",
        receiptRequired: true,
        commodity: "EUR",
      });
      expect(await ledger.getAccountByPath("ws_1", "Expenses:Insurance")).toEqual(ensured);
    } finally {
      t.close();
    }
  });

  it("refuses kind or commodity changes that contradict existing postings", async () => {
    const t = createTestDatabase();
    try {
      const ledger = new SqliteLedgerRepository(t.db);
      await seedAccounts(ledger, "ws_1");
      await ledger.upsertAccount("ws_1", {
        id: "acct_mystery",
        path: "Mystery:Box",
        kind: "asset",
        createdAt: AT,
      });
      await ledger.createTransaction(
        "ws_1",
        draft("tx_1", { postings: [eur("Mystery:Box", "-1.00"), eur(SUSPENSE, "1.00")] }),
      );

      await expect(
        ledger.upsertAccount("ws_1", {
          id: "acct_mystery",
          path: "Mystery:Box",
          kind: "expense",
          createdAt: AT,
        }),
      ).rejects.toThrow(/cannot change the kind/);
      await expect(
        ledger.upsertAccount("ws_1", {
          id: "ignored",
          path: SUSPENSE,
          commodity: "USD",
          createdAt: AT,
        }),
      ).rejects.toThrow(/postings in another commodity/);
      // A restriction that matches every existing posting is fine.
      expect(
        await ledger.upsertAccount("ws_1", {
          id: "ignored",
          path: SUSPENSE,
          commodity: "EUR",
          createdAt: AT,
        }),
      ).toMatchObject({ commodity: "EUR" });
      expect(await ledger.getAccountByPath("ws_1", "Mystery:Box")).toMatchObject({ kind: "asset" });
    } finally {
      t.close();
    }
  });
});

describe("SqliteLedgerRepository transactions", () => {
  it("writes a balanced transaction with its postings and reads it back", async () => {
    const t = createTestDatabase();
    try {
      const ledger = new SqliteLedgerRepository(t.db);
      await seedAccounts(ledger, "ws_1");

      const result = await ledger.createTransaction(
        "ws_1",
        draft("tx_1", {
          postings: [eur(BANK, "-84.23", "card payment"), eur(SUSPENSE, "84.23")],
          idempotencyKey: "bank:src_1:txn_ext_1",
        }),
      );

      expect(result.created).toBe(true);
      expect(result.transaction).toEqual({
        id: "tx_1",
        workspaceId: "ws_1",
        bookedOn: "2026-02-01",
        description: "Synthetic transaction tx_1",
        reviewState: "draft",
        createdAt: AT,
        idempotencyKey: "bank:src_1:txn_ext_1",
        supersedesTransactionId: undefined,
        supersededByTransactionId: undefined,
        postings: [
          {
            id: "tx_1:001",
            transactionId: "tx_1",
            account: BANK,
            amount: { amount: "-84.23", commodity: "EUR" },
            memo: "card payment",
          },
          {
            id: "tx_1:002",
            transactionId: "tx_1",
            account: SUSPENSE,
            amount: { amount: "84.23", commodity: "EUR" },
            memo: undefined,
          },
        ],
      });
      expect(await ledger.getTransaction("ws_1", "tx_1")).toEqual(result.transaction);
    } finally {
      t.close();
    }
  });

  it("rejects unbalanced postings per commodity and writes nothing", async () => {
    const t = createTestDatabase();
    try {
      const ledger = new SqliteLedgerRepository(t.db);
      await seedAccounts(ledger, "ws_1");

      const unbalanced = draft("tx_bad", {
        postings: [
          eur(BANK, "-100.00"),
          eur(SUSPENSE, "100.00"),
          usd(BANK, "-50.00"),
          usd(SUSPENSE, "49.99"),
        ],
      });
      await expect(ledger.createTransaction("ws_1", unbalanced)).rejects.toBeInstanceOf(
        UnbalancedLedgerTransactionError,
      );
      await expect(ledger.createTransaction("ws_1", unbalanced)).rejects.toThrow(
        /USD does not balance/,
      );
      await expect(
        ledger.createTransaction("ws_1", draft("tx_single", { postings: [eur(BANK, "0")] })),
      ).rejects.toThrow(/at least two postings/);

      expect(count(t.db, "ledger_transactions", "ws_1")).toBe(0);
      expect(count(t.db, "ledger_postings", "ws_1")).toBe(0);
    } finally {
      t.close();
    }
  });

  it("rejects unknown accounts, commodity restrictions, bad dates, and rolls back partial writes", async () => {
    const t = createTestDatabase();
    try {
      const ledger = new SqliteLedgerRepository(t.db);
      await seedAccounts(ledger, "ws_1");
      await ledger.upsertAccount("ws_1", {
        id: "acct_usd",
        path: "Assets:Broker:USD",
        commodity: "USD",
        createdAt: AT,
      });

      await expect(
        ledger.createTransaction(
          "ws_1",
          draft("tx_unknown", { postings: [eur(BANK, "-1.00"), eur("Expenses:Nope", "1.00")] }),
        ),
      ).rejects.toThrow(/unknown ledger accounts.*Expenses:Nope/i);
      await expect(
        ledger.createTransaction(
          "ws_1",
          draft("tx_commodity", {
            postings: [eur("Assets:Broker:USD", "-1.00"), eur(SUSPENSE, "1.00")],
          }),
        ),
      ).rejects.toThrow(/only accepts USD/);
      await expect(
        ledger.createTransaction("ws_1", draft("tx_date", { bookedOn: "01.02.2026" })),
      ).rejects.toThrow(/YYYY-MM-DD/);
      // Accounts belong to ws_1 only; ws_2 must not be able to book against them.
      await expect(ledger.createTransaction("ws_2", draft("tx_other_ws"))).rejects.toThrow(
        /unknown ledger accounts/i,
      );

      expect(count(t.db, "ledger_transactions", "ws_1")).toBe(0);
      expect(count(t.db, "ledger_transactions", "ws_2")).toBe(0);
      expect(count(t.db, "ledger_postings", "ws_1")).toBe(0);
    } finally {
      t.close();
    }
  });

  it("returns the existing transaction for a repeated idempotency key", async () => {
    const t = createTestDatabase();
    try {
      const ledger = new SqliteLedgerRepository(t.db);
      await seedAccounts(ledger, "ws_1");
      await seedAccounts(ledger, "ws_2");

      const imported = draft("tx_1", { idempotencyKey: "import:1" });
      const first = await ledger.createTransaction("ws_1", imported);
      // A retry carries the same content under a fresh id: the key wins, nothing is written.
      const replay = await ledger.createTransaction("ws_1", { ...imported, id: "tx_1_retry" });
      // The same key in another workspace is a different transaction.
      const other = await ledger.createTransaction(
        "ws_2",
        draft("tx_ws2", { idempotencyKey: "import:1" }),
      );

      expect(replay.created).toBe(false);
      expect(replay.transaction).toEqual(first.transaction);
      expect(other.created).toBe(true);
      expect(count(t.db, "ledger_transactions", "ws_1")).toBe(1);
      expect(count(t.db, "ledger_postings", "ws_1")).toBe(2);
      // The same key with different financial content is a conflict, never a silent merge.
      for (const divergent of [
        draft("tx_1_diverged", { idempotencyKey: "import:1", description: "changed" }),
        draft("tx_1_diverged", {
          idempotencyKey: "import:1",
          postings: [eur(BANK, "-84.24"), eur(SUSPENSE, "84.24")],
        }),
      ]) {
        const attempt = ledger.createTransaction("ws_1", divergent);
        await expect(attempt).rejects.toBeInstanceOf(LedgerError);
        await expect(attempt).rejects.toMatchObject({ code: "idempotency_conflict" });
      }
      expect(count(t.db, "ledger_transactions", "ws_1")).toBe(1);
      // Without a key, a duplicate id is a hard error rather than a silent merge.
      await expect(ledger.createTransaction("ws_1", draft("tx_1"))).rejects.toThrow(
        /UNIQUE|PRIMARY KEY/i,
      );
    } finally {
      t.close();
    }
  });

  it("lists by date range, account, and review state within a workspace only", async () => {
    const t = createTestDatabase();
    try {
      const ledger = new SqliteLedgerRepository(t.db);
      await seedAccounts(ledger, "ws_1");
      await seedAccounts(ledger, "ws_2");

      await ledger.createTransaction("ws_1", draft("tx_jan", { bookedOn: "2026-01-15" }));
      await ledger.createTransaction(
        "ws_1",
        draft("tx_feb", {
          bookedOn: "2026-02-10",
          postings: [eur(BANK, "-20.00"), eur(MAINTENANCE, "20.00")],
        }),
      );
      await ledger.transitionReviewState("ws_1", {
        id: "tx_feb",
        toState: "user_reviewed",
        actor: "user:test",
        at: AT,
      });
      await ledger.createTransaction("ws_1", draft("tx_mar", { bookedOn: "2026-03-01" }));
      await ledger.createTransaction("ws_2", draft("tx_ws2", { bookedOn: "2026-02-10" }));

      const ids = (list: Awaited<ReturnType<typeof ledger.listTransactions>>) =>
        list.map((transaction) => transaction.id);

      expect(ids(await ledger.listTransactions("ws_1"))).toEqual(["tx_jan", "tx_feb", "tx_mar"]);
      expect(
        ids(await ledger.listTransactions("ws_1", { from: "2026-02-01", to: "2026-02-28" })),
      ).toEqual(["tx_feb"]);
      expect(ids(await ledger.listTransactions("ws_1", { account: MAINTENANCE }))).toEqual([
        "tx_feb",
      ]);
      expect(ids(await ledger.listTransactions("ws_1", { account: BANK }))).toHaveLength(3);
      expect(
        ids(await ledger.listTransactions("ws_1", { reviewStates: ["user_reviewed"] })),
      ).toEqual(["tx_feb"]);
      expect(await ledger.listTransactions("ws_1", { reviewStates: [] })).toEqual([]);
      for (const transaction of await ledger.listTransactions("ws_1")) {
        expect(transaction.postings).toHaveLength(2);
      }

      expect(await ledger.getTransaction("ws_2", "tx_jan")).toBeUndefined();
      expect(ids(await ledger.listTransactions("ws_2"))).toEqual(["tx_ws2"]);
    } finally {
      t.close();
    }
  });

  it("supersedes append-only: original postings are preserved and only its state changes", async () => {
    const t = createTestDatabase();
    try {
      const ledger = new SqliteLedgerRepository(t.db);
      await seedAccounts(ledger, "ws_1");
      const imported = draft("tx_1", { reviewState: "suggested", idempotencyKey: "import:1" });
      const original = (await ledger.createTransaction("ws_1", imported)).transaction;

      const result = await ledger.supersedeTransaction("ws_1", {
        supersedesTransactionId: "tx_1",
        replacement: draft("tx_2", {
          postings: [eur(BANK, "-84.23"), eur(MAINTENANCE, "84.23")],
          reviewState: "suggested",
        }),
        actor: "user:test",
        supersededAt: "2026-02-02T00:00:00Z",
        notes: "classified after receipt arrived",
      });

      expect(result.created).toBe(true);
      expect(result.superseded).toEqual({
        ...original,
        reviewState: "superseded",
        supersededByTransactionId: "tx_2",
      });
      expect(result.replacement).toMatchObject({
        id: "tx_2",
        reviewState: "suggested",
        supersedesTransactionId: "tx_1",
        supersededByTransactionId: undefined,
      });
      expect(result.replacement.postings.map((posting) => posting.account)).toEqual([
        BANK,
        MAINTENANCE,
      ]);
      // Both transactions remain readable and the original's postings are untouched.
      expect(await ledger.getTransaction("ws_1", "tx_1")).toEqual(result.superseded);
      expect(count(t.db, "ledger_postings", "ws_1")).toBe(4);
      const reviewEvents = new SqliteReviewEventRepository(t.db);
      const target = { type: "ledger_transaction", id: "tx_1" };
      expect(await reviewEvents.listForTarget("ws_1", target)).toEqual([
        {
          id: "review_event:ledger_transaction:tx_1:2026-02-02T00:00:00Z",
          workspaceId: "ws_1",
          targetType: "ledger_transaction",
          targetId: "tx_1",
          fromState: "suggested",
          toState: "superseded",
          actor: "user:test",
          notes: "classified after receipt arrived",
          createdAt: "2026-02-02T00:00:00Z",
        },
      ]);
      expect(await reviewEvents.listForTarget("ws_2", target)).toEqual([]);
      // The original idempotency key still resolves to the superseded transaction.
      expect(
        await ledger.createTransaction("ws_1", { ...imported, id: "tx_replay" }),
      ).toMatchObject({ created: false, transaction: { id: "tx_1", reviewState: "superseded" } });
    } finally {
      t.close();
    }
  });

  it("supersession is idempotent, single-shot, and atomic", async () => {
    const t = createTestDatabase();
    try {
      const ledger = new SqliteLedgerRepository(t.db);
      await seedAccounts(ledger, "ws_1");
      await ledger.createTransaction("ws_1", draft("tx_1"));

      const supersede = (replacement: CreateLedgerTransactionInput) =>
        ledger.supersedeTransaction("ws_1", {
          supersedesTransactionId: "tx_1",
          replacement,
          actor: "user:test",
          supersededAt: "2026-02-02T00:00:00Z",
        });

      // An unbalanced replacement leaves the original completely untouched.
      await expect(
        supersede(draft("tx_bad", { postings: [eur(BANK, "-1.00"), eur(SUSPENSE, "2.00")] })),
      ).rejects.toBeInstanceOf(UnbalancedLedgerTransactionError);
      expect(await ledger.getTransaction("ws_1", "tx_1")).toMatchObject({
        reviewState: "draft",
        supersededByTransactionId: undefined,
      });
      expect(count(t.db, "ledger_transactions", "ws_1")).toBe(1);

      await expect(supersede(draft("tx_1"))).rejects.toThrow(/cannot supersede itself/);

      const first = await supersede(draft("tx_2", { idempotencyKey: "fix:1" }));
      const retry = await supersede(draft("tx_2", { idempotencyKey: "fix:1" }));
      expect(first.created).toBe(true);
      expect(retry.created).toBe(false);
      expect(retry.replacement.id).toBe("tx_2");
      await expect(supersede(draft("tx_3"))).rejects.toThrow(/already superseded by tx_2/);
      expect(count(t.db, "ledger_transactions", "ws_1")).toBe(2);

      await expect(
        ledger.supersedeTransaction("ws_2", {
          supersedesTransactionId: "tx_1",
          replacement: draft("tx_ws2"),
          actor: "user:test",
          supersededAt: "2026-02-02T00:00:00Z",
        }),
      ).rejects.toThrow(/not found in workspace/);
    } finally {
      t.close();
    }
  });

  it("accepts a multi-commodity transaction when every commodity balances on its own", async () => {
    const t = createTestDatabase();
    try {
      const ledger = new SqliteLedgerRepository(t.db);
      await seedAccounts(ledger, "ws_1");

      const result = await ledger.createTransaction(
        "ws_1",
        draft("tx_fx", {
          postings: [
            eur(BANK, "-100.00"),
            usd("Assets:Broker", "108.50"),
            usd(SUSPENSE, "-108.50"),
            eur(SUSPENSE, "100.00"),
          ],
        }),
      );

      expect(result.created).toBe(true);
      expect(result.transaction.postings.map((posting) => posting.amount)).toEqual([
        { amount: "-100.00", commodity: "EUR" },
        { amount: "108.50", commodity: "USD" },
        { amount: "-108.50", commodity: "USD" },
        { amount: "100.00", commodity: "EUR" },
      ]);
      expect(await ledger.getTransaction("ws_1", "tx_fx")).toEqual(result.transaction);
      expect(count(t.db, "ledger_postings", "ws_1")).toBe(4);
    } finally {
      t.close();
    }
  });

  it("rejects malformed amounts and creation in the superseded state without writing", async () => {
    const t = createTestDatabase();
    try {
      const ledger = new SqliteLedgerRepository(t.db);
      await seedAccounts(ledger, "ws_1");

      const comma = draft("tx_comma", {
        postings: [eur(BANK, "-12,50"), eur(SUSPENSE, "12.50")],
      });
      await expect(ledger.createTransaction("ws_1", comma)).rejects.toBeInstanceOf(
        UnbalancedLedgerTransactionError,
      );
      await expect(ledger.createTransaction("ws_1", comma)).rejects.toThrow(
        /invalid amount "-12,50"/,
      );
      await expect(
        ledger.createTransaction(
          "ws_1",
          draft("tx_exp", { postings: [eur(BANK, "-1e2"), eur(SUSPENSE, "100")] }),
        ),
      ).rejects.toThrow(/invalid amount "-1e2"/);
      // Reviewed/exported/superseded states need a recorded transition; bypass the type to prove the runtime gate.
      for (const reviewState of ["user_reviewed", "advisor_reviewed", "exported", "superseded"]) {
        const attempt = ledger.createTransaction(
          "ws_1",
          draft("tx_gated", { reviewState: reviewState as never }),
        );
        await expect(attempt).rejects.toThrow(/cannot be assigned on creation/);
        await expect(attempt).rejects.toMatchObject({ code: "invalid_review_state" });
      }

      expect(count(t.db, "ledger_transactions", "ws_1")).toBe(0);
      expect(count(t.db, "ledger_postings", "ws_1")).toBe(0);
    } finally {
      t.close();
    }
  });

  it("defaults to draft, stores an explicit review state, and round-trips memos", async () => {
    const t = createTestDatabase();
    try {
      const ledger = new SqliteLedgerRepository(t.db);
      await seedAccounts(ledger, "ws_1");

      const created = await ledger.createTransaction("ws_1", draft("tx_draft"));
      const suggested = await ledger.createTransaction(
        "ws_1",
        draft("tx_suggested", {
          reviewState: "suggested",
          postings: [
            eur(BANK, "-5.00", "Kaffee & Kuchen — Beleg #12 / 'quoted' \"double\""),
            eur(SUSPENSE, "5.00", ""),
          ],
        }),
      );

      expect(created.transaction.reviewState).toBe("draft");
      expect(suggested.transaction.reviewState).toBe("suggested");
      expect(
        (await ledger.getTransaction("ws_1", "tx_suggested"))?.postings.map(
          (posting) => posting.memo,
        ),
      ).toEqual(["Kaffee & Kuchen — Beleg #12 / 'quoted' \"double\"", ""]);
    } finally {
      t.close();
    }
  });

  it("preserves posting order past nine postings via zero-padded ids", async () => {
    const t = createTestDatabase();
    try {
      const ledger = new SqliteLedgerRepository(t.db);
      await seedAccounts(ledger, "ws_1");

      const legs = Array.from({ length: 11 }, (_, index) =>
        eur(index % 2 === 0 ? SUSPENSE : MAINTENANCE, "1.00", `leg ${index + 1}`),
      );
      const result = await ledger.createTransaction(
        "ws_1",
        draft("tx_many", { postings: [...legs, eur(BANK, "-11.00", "leg 12")] }),
      );

      const readBack = await ledger.getTransaction("ws_1", "tx_many");
      expect(readBack).toEqual(result.transaction);
      expect(readBack?.postings.map((posting) => posting.id)).toEqual(
        Array.from({ length: 12 }, (_, index) => `tx_many:${String(index + 1).padStart(3, "0")}`),
      );
      expect(readBack?.postings.map((posting) => posting.memo)).toEqual(
        Array.from({ length: 12 }, (_, index) => `leg ${index + 1}`),
      );
      expect(readBack?.postings.at(-1)?.account).toBe(BANK);
      expect((await ledger.listTransactions("ws_1"))[0]?.postings).toHaveLength(12);
    } finally {
      t.close();
    }
  });

  it("supports open-ended date bounds, combined filters, and a stable sort order", async () => {
    const t = createTestDatabase();
    try {
      const ledger = new SqliteLedgerRepository(t.db);
      await seedAccounts(ledger, "ws_1");

      // Inserted out of order on purpose: the list sorts by bookedOn, then createdAt, then id.
      await ledger.createTransaction(
        "ws_1",
        draft("tx_d", { bookedOn: "2026-02-10", createdAt: "2026-02-10T09:00:00Z" }),
      );
      await ledger.createTransaction(
        "ws_1",
        draft("tx_c", { bookedOn: "2026-02-10", createdAt: "2026-02-10T08:00:00Z" }),
      );
      await ledger.createTransaction(
        "ws_1",
        draft("tx_b", { bookedOn: "2026-02-10", createdAt: "2026-02-10T08:00:00Z" }),
      );
      await ledger.createTransaction(
        "ws_1",
        draft("tx_a", {
          bookedOn: "2026-01-31",
          createdAt: "2026-02-10T10:00:00Z",
          postings: [eur(BANK, "-20.00"), eur(MAINTENANCE, "20.00")],
        }),
      );
      await ledger.createTransaction("ws_1", draft("tx_e", { bookedOn: "2026-03-01" }));
      for (const id of ["tx_a", "tx_e"]) {
        await ledger.transitionReviewState("ws_1", {
          id,
          toState: "user_reviewed",
          actor: "user:test",
          at: AT,
        });
      }

      const ids = (list: Awaited<ReturnType<typeof ledger.listTransactions>>) =>
        list.map((transaction) => transaction.id);

      expect(ids(await ledger.listTransactions("ws_1"))).toEqual([
        "tx_a",
        "tx_b",
        "tx_c",
        "tx_d",
        "tx_e",
      ]);
      expect(ids(await ledger.listTransactions("ws_1", { from: "2026-02-10" }))).toEqual([
        "tx_b",
        "tx_c",
        "tx_d",
        "tx_e",
      ]);
      expect(ids(await ledger.listTransactions("ws_1", { to: "2026-02-10" }))).toEqual([
        "tx_a",
        "tx_b",
        "tx_c",
        "tx_d",
      ]);
      expect(
        ids(await ledger.listTransactions("ws_1", { from: "2026-02-11", to: "2026-02-10" })),
      ).toEqual([]);
      expect(
        ids(
          await ledger.listTransactions("ws_1", {
            account: BANK,
            reviewStates: ["user_reviewed", "exported"],
          }),
        ),
      ).toEqual(["tx_a", "tx_e"]);
      expect(
        ids(
          await ledger.listTransactions("ws_1", { account: MAINTENANCE, reviewStates: ["draft"] }),
        ),
      ).toEqual([]);
      expect(
        ids(
          await ledger.listTransactions("ws_1", {
            from: "2026-02-01",
            account: BANK,
            reviewStates: ["draft"],
          }),
        ),
      ).toEqual(["tx_b", "tx_c", "tx_d"]);
      expect(ids(await ledger.listTransactions("ws_1", { limit: 2 }))).toEqual(["tx_a", "tx_b"]);
      expect(ids(await ledger.listTransactions("ws_1", { from: "2026-03-01", limit: 5 }))).toEqual([
        "tx_e",
      ]);
      await expect(ledger.listTransactions("ws_1", { limit: 0 })).rejects.toMatchObject({
        code: "invalid_input",
      });
    } finally {
      t.close();
    }
  });

  it("rejects a replacement whose idempotency key belongs to another transaction and changes nothing", async () => {
    const t = createTestDatabase();
    try {
      const ledger = new SqliteLedgerRepository(t.db);
      await seedAccounts(ledger, "ws_1");
      await ledger.createTransaction("ws_1", draft("tx_1", { idempotencyKey: "import:1" }));
      await ledger.createTransaction("ws_1", draft("tx_other", { idempotencyKey: "import:other" }));
      const before = await ledger.getTransaction("ws_1", "tx_1");

      const supersede = (idempotencyKey: string) =>
        ledger.supersedeTransaction("ws_1", {
          supersedesTransactionId: "tx_1",
          replacement: draft("tx_fix", {
            idempotencyKey,
            postings: [eur(BANK, "-84.23"), eur(MAINTENANCE, "84.23")],
          }),
          actor: "user:test",
          supersededAt: "2026-02-02T00:00:00Z",
        });

      await expect(supersede("import:other")).rejects.toThrow(
        /already belongs to ledger transaction tx_other/,
      );
      // Reusing the original's own key is rejected too: a correction cannot alias its predecessor.
      await expect(supersede("import:1")).rejects.toThrow(
        /already belongs to ledger transaction tx_1/,
      );

      expect(await ledger.getTransaction("ws_1", "tx_1")).toEqual(before);
      expect(await ledger.getTransaction("ws_1", "tx_fix")).toBeUndefined();
      expect(count(t.db, "ledger_transactions", "ws_1")).toBe(2);
      expect(count(t.db, "ledger_postings", "ws_1")).toBe(4);
      expect(count(t.db, "ledger_transaction_supersessions", "ws_1")).toBe(0);
      expect(count(t.db, "review_events", "ws_1")).toBe(0);
      // The original remains correctable with a fresh key afterwards.
      expect((await supersede("fix:1")).created).toBe(true);
      expect(count(t.db, "ledger_transaction_supersessions", "ws_1")).toBe(1);
    } finally {
      t.close();
    }
  });

  it("supports a linear correction chain and keeps superseded transactions listable", async () => {
    const t = createTestDatabase();
    try {
      const ledger = new SqliteLedgerRepository(t.db);
      await seedAccounts(ledger, "ws_1");
      await ledger.createTransaction("ws_1", draft("tx_1"));

      const supersede = (
        supersedesTransactionId: string,
        replacement: CreateLedgerTransactionInput,
      ) =>
        ledger.supersedeTransaction("ws_1", {
          supersedesTransactionId,
          replacement,
          actor: "user:test",
          supersededAt: "2026-02-02T00:00:00Z",
        });

      await supersede(
        "tx_1",
        draft("tx_2", { postings: [eur(BANK, "-84.23"), eur(MAINTENANCE, "84.23")] }),
      );
      const second = await supersede(
        "tx_2",
        draft("tx_3", {
          reviewState: "suggested",
          postings: [eur(BANK, "-84.23"), eur("Expenses:Insurance", "84.23")],
        }),
      );

      expect(second.superseded).toMatchObject({
        id: "tx_2",
        reviewState: "superseded",
        supersedesTransactionId: "tx_1",
        supersededByTransactionId: "tx_3",
      });
      expect(second.replacement).toMatchObject({
        id: "tx_3",
        supersedesTransactionId: "tx_2",
        supersededByTransactionId: undefined,
      });

      const ids = (list: Awaited<ReturnType<typeof ledger.listTransactions>>) =>
        list.map((transaction) => transaction.id);
      expect(ids(await ledger.listTransactions("ws_1"))).toEqual(["tx_1", "tx_2", "tx_3"]);
      expect(ids(await ledger.listTransactions("ws_1", { account: SUSPENSE }))).toEqual(["tx_1"]);
      expect(ids(await ledger.listTransactions("ws_1", { account: MAINTENANCE }))).toEqual([
        "tx_2",
      ]);
      expect(ids(await ledger.listTransactions("ws_1", { account: "Expenses:Insurance" }))).toEqual(
        ["tx_3"],
      );
      expect(
        ids(
          await ledger.listTransactions("ws_1", {
            reviewStates: ["draft", "suggested", "user_reviewed", "advisor_reviewed", "exported"],
          }),
        ),
      ).toEqual(["tx_3"]);
      expect(ids(await ledger.listTransactions("ws_1", { reviewStates: ["superseded"] }))).toEqual([
        "tx_1",
        "tx_2",
      ]);

      await expect(supersede("tx_1", draft("tx_4"))).rejects.toThrow(/already superseded by tx_2/);
      await expect(supersede("tx_2", draft("tx_4"))).rejects.toThrow(/already superseded by tx_3/);
      expect(count(t.db, "ledger_transactions", "ws_1")).toBe(3);
      expect(count(t.db, "review_events", "ws_1")).toBe(2);
    } finally {
      t.close();
    }
  });

  it("changes review state only through recorded, actor-attributed transitions", async () => {
    const t = createTestDatabase();
    try {
      const ledger = new SqliteLedgerRepository(t.db);
      const reviewEvents = new SqliteReviewEventRepository(t.db);
      await seedAccounts(ledger, "ws_1");
      await ledger.createTransaction("ws_1", draft("tx_1"));
      const target = { type: "ledger_transaction", id: "tx_1" };
      const transition = (
        overrides: Partial<Parameters<typeof ledger.transitionReviewState>[1]> = {},
        workspaceId = "ws_1",
      ) =>
        ledger.transitionReviewState(workspaceId, {
          id: "tx_1",
          toState: "user_reviewed",
          actor: "user:test",
          at: "2026-02-02T00:00:00Z",
          notes: "checked against receipt",
          ...overrides,
        });

      const reviewed = await transition();
      expect(reviewed.reviewState).toBe("user_reviewed");
      // Repeating the same transition is a no-op and records nothing new.
      expect((await transition()).reviewState).toBe("user_reviewed");
      expect(await reviewEvents.listForTarget("ws_1", target)).toEqual([
        {
          id: "review_event:ledger_transaction:tx_1:2026-02-02T00:00:00Z",
          workspaceId: "ws_1",
          targetType: "ledger_transaction",
          targetId: "tx_1",
          fromState: "draft",
          toState: "user_reviewed",
          actor: "user:test",
          notes: "checked against receipt",
          createdAt: "2026-02-02T00:00:00Z",
        },
      ]);

      await expect(transition({}, "ws_2")).rejects.toMatchObject({ code: "not_found" });
      await expect(
        transition({ actor: "  ", toState: "advisor_reviewed", at: "2026-02-03T00:00:00Z" }),
      ).rejects.toThrow(/actor is required/);
      await expect(
        transition({ toState: "superseded" as never, at: "2026-02-03T00:00:00Z" }),
      ).rejects.toMatchObject({ code: "invalid_review_state" });
      expect(await ledger.getTransaction("ws_1", "tx_1")).toMatchObject({
        reviewState: "user_reviewed",
      });
      expect(count(t.db, "review_events", "ws_1")).toBe(1);

      // Superseded transactions are terminal.
      await ledger.supersedeTransaction("ws_1", {
        supersedesTransactionId: "tx_1",
        replacement: draft("tx_2", { postings: [eur(BANK, "-84.23"), eur(MAINTENANCE, "84.23")] }),
        actor: "user:test",
        supersededAt: "2026-02-04T00:00:00Z",
      });
      await expect(
        transition({ toState: "advisor_reviewed", at: "2026-02-05T00:00:00Z" }),
      ).rejects.toMatchObject({ code: "already_superseded" });
      expect((await reviewEvents.listForTarget("ws_1", target)).map((e) => e.toState)).toEqual([
        "user_reviewed",
        "superseded",
      ]);
    } finally {
      t.close();
    }
  });
});

describe("SqliteEvidenceLinkRepository", () => {
  const link = (overrides: Partial<EvidenceLink> = {}): EvidenceLink => ({
    id: "el_1",
    workspaceId: "ws_1",
    fromType: EVIDENCE_RECORD_TYPES.document,
    fromId: "doc_1",
    toType: EVIDENCE_RECORD_TYPES.ledgerTransaction,
    toId: "tx_1",
    kind: "substantiates",
    createdAt: AT,
    ...overrides,
  });

  it("deduplicates identical edges within a workspace and lists by either endpoint", async () => {
    const t = createTestDatabase();
    try {
      const repo = new SqliteEvidenceLinkRepository(t.db);

      const first = await repo.link(link({ notes: "receipt total matches" }));
      const duplicate = await repo.link(link({ id: "el_dup", notes: "different notes" }));
      const otherKind = await repo.link(link({ id: "el_2", kind: "imported_as" }));
      const otherWorkspace = await repo.link(link({ id: "el_ws2", workspaceId: "ws_2" }));

      expect(first.created).toBe(true);
      expect(duplicate).toEqual({ link: first.link, created: false });
      expect(otherKind.created).toBe(true);
      expect(otherWorkspace.created).toBe(true);

      expect(await repo.getById("ws_1", "el_dup")).toBeUndefined();
      expect(await repo.getById("ws_1", "el_1")).toEqual({
        ...link(),
        notes: "receipt total matches",
      });
      expect((await repo.listForTransaction("ws_1", "tx_1")).map((l) => l.id)).toEqual([
        "el_1",
        "el_2",
      ]);
      expect((await repo.listForDocument("ws_1", "doc_1")).map((l) => l.id)).toEqual([
        "el_1",
        "el_2",
      ]);
      expect(await repo.listForTransaction("ws_2", "tx_1")).toEqual([
        link({ id: "el_ws2", workspaceId: "ws_2" }),
      ]);
      expect(await repo.listForDocument("ws_1", "doc_missing")).toEqual([]);
    } finally {
      t.close();
    }
  });

  it("validates links at the write boundary", async () => {
    const t = createTestDatabase();
    try {
      const repo = new SqliteEvidenceLinkRepository(t.db);
      await expect(repo.link(link({ kind: "made_up" as EvidenceLink["kind"] }))).rejects.toThrow();
      await expect(repo.link(link({ fromId: "" }))).rejects.toThrow();
      expect(count(t.db, "evidence_links", "ws_1")).toBe(0);
    } finally {
      t.close();
    }
  });

  it("treats direction and kind as part of the edge and lists any record type", async () => {
    const t = createTestDatabase();
    try {
      const repo = new SqliteEvidenceLinkRepository(t.db);
      const raw = EVIDENCE_RECORD_TYPES.rawSourceRecord;
      const tx = EVIDENCE_RECORD_TYPES.ledgerTransaction;

      const forward = await repo.link(
        link({
          id: "el_fwd",
          fromType: raw,
          fromId: "raw_1",
          toType: tx,
          toId: "tx_1",
          kind: "imported_as",
        }),
      );
      const reverse = await repo.link(
        link({
          id: "el_rev",
          fromType: tx,
          fromId: "tx_1",
          toType: raw,
          toId: "raw_1",
          kind: "imported_as",
        }),
      );
      const replay = await repo.link(
        link({
          id: "el_replay",
          fromType: raw,
          fromId: "raw_1",
          toType: tx,
          toId: "tx_1",
          kind: "imported_as",
          notes: "second pipeline run",
          createdAt: "2026-02-03T00:00:00Z",
        }),
      );

      expect(forward.created).toBe(true);
      expect(reverse.created).toBe(true);
      expect(replay).toEqual({ link: forward.link, created: false });
      expect(count(t.db, "evidence_links", "ws_1")).toBe(2);

      const idsFor = async (workspaceId: string, type: string, id: string) =>
        (await repo.listForRecord(workspaceId, { type, id })).map((l) => l.id);
      expect(await idsFor("ws_1", raw, "raw_1")).toEqual(["el_fwd", "el_rev"]);
      expect(await idsFor("ws_1", tx, "tx_1")).toEqual(["el_fwd", "el_rev"]);
      // The type is part of the endpoint: a matching id under another type is a different record.
      expect(await idsFor("ws_1", raw, "tx_1")).toEqual([]);
      expect(await idsFor("ws_2", raw, "raw_1")).toEqual([]);
    } finally {
      t.close();
    }
  });
});

describe("SqliteAuditEventRepository", () => {
  it("is append-only and isolated per workspace", async () => {
    const t = createTestDatabase();
    try {
      const repo = new SqliteAuditEventRepository(t.db);
      await repo.append(auditEvent("audit_1"));
      await expect(repo.append(auditEvent("audit_1", { action: "tampered" }))).rejects.toThrow(
        /append-only/,
      );
      await repo.append(auditEvent("audit_ws2", { workspaceId: "ws_2", metadata: undefined }));

      expect(await repo.getById("ws_1", "audit_1")).toEqual(auditEvent("audit_1"));
      expect(await repo.getById("ws_2", "audit_1")).toBeUndefined();
      expect(await repo.getById("ws_2", "audit_ws2")).toEqual({
        id: "audit_ws2",
        workspaceId: "ws_2",
        action: "ledger.transaction.created",
        actor: "user:test",
        targetType: "ledger_transaction",
        targetId: "tx_1",
        createdAt: AT,
      });
      expect((await repo.list("ws_1")).events.map((event) => event.id)).toEqual(["audit_1"]);
      expect("update" in repo).toBe(false);
      expect("delete" in repo).toBe(false);
    } finally {
      t.close();
    }
  });

  it("paginates oldest-first with a keyset cursor", async () => {
    const t = createTestDatabase();
    try {
      const repo = new SqliteAuditEventRepository(t.db);
      // Two events share a timestamp so the cursor must break ties on id.
      await repo.append(auditEvent("audit_b", { createdAt: "2026-02-01T00:00:01Z" }));
      await repo.append(auditEvent("audit_a", { createdAt: "2026-02-01T00:00:01Z" }));
      await repo.append(auditEvent("audit_c", { createdAt: "2026-02-01T00:00:02Z" }));
      await repo.append(auditEvent("audit_0", { createdAt: "2026-02-01T00:00:00Z" }));

      const page1 = await repo.list("ws_1", { limit: 2 });
      expect(page1.events.map((event) => event.id)).toEqual(["audit_0", "audit_a"]);
      expect(page1.nextCursor).toEqual({ createdAt: "2026-02-01T00:00:01Z", id: "audit_a" });

      const page2 = await repo.list("ws_1", { limit: 2, after: page1.nextCursor });
      expect(page2.events.map((event) => event.id)).toEqual(["audit_b", "audit_c"]);
      expect(page2.nextCursor).toBeUndefined();

      const page3 = await repo.list("ws_1", {
        limit: 2,
        after: { createdAt: "2026-02-01T00:00:02Z", id: "audit_c" },
      });
      expect(page3.events).toEqual([]);
      await expect(repo.list("ws_1", { limit: 0 })).rejects.toThrow(/positive integer/);
    } finally {
      t.close();
    }
  });

  it("round-trips nested metadata and bounds the page size", async () => {
    const t = createTestDatabase();
    try {
      const repo = new SqliteAuditEventRepository(t.db);
      const metadata = {
        postings: [
          { account: "Assets:Bank", amount: "-1.00" },
          { account: SUSPENSE, amount: "1.00" },
        ],
        suggestion: { confidence: 0.42, rule: null, tags: ["synthetic", "ümlaut"] },
        flags: [true, false],
      };
      await repo.append(auditEvent("audit_meta", { metadata }));
      expect((await repo.getById("ws_1", "audit_meta"))?.metadata).toEqual(metadata);

      const page = await repo.list("ws_1", { limit: 5000 });
      expect(page.events.map((event) => event.id)).toEqual(["audit_meta"]);
      expect(page.nextCursor).toBeUndefined();
      for (const limit of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(repo.list("ws_1", { limit })).rejects.toThrow(/positive integer/);
      }
    } finally {
      t.close();
    }
  });

  it("never returns another workspace's events, even through a foreign cursor", async () => {
    const t = createTestDatabase();
    try {
      const repo = new SqliteAuditEventRepository(t.db);
      await repo.append(auditEvent("audit_ws1_a", { createdAt: "2026-02-01T00:00:00Z" }));
      await repo.append(auditEvent("audit_ws1_b", { createdAt: "2026-02-01T00:00:02Z" }));
      await repo.append(
        auditEvent("audit_ws2_a", { workspaceId: "ws_2", createdAt: "2026-02-01T00:00:01Z" }),
      );
      await repo.append(
        auditEvent("audit_ws2_b", { workspaceId: "ws_2", createdAt: "2026-02-01T00:00:03Z" }),
      );

      const ws1 = await repo.list("ws_1", { limit: 1 });
      expect(ws1.events.map((event) => event.id)).toEqual(["audit_ws1_a"]);
      expect(ws1.nextCursor).toEqual({ createdAt: "2026-02-01T00:00:00Z", id: "audit_ws1_a" });

      const ws2 = await repo.list("ws_2", { limit: 10, after: ws1.nextCursor });
      expect(ws2.events.map((event) => event.id)).toEqual(["audit_ws2_a", "audit_ws2_b"]);
      expect(ws2.events.every((event) => event.workspaceId === "ws_2")).toBe(true);
      expect(await repo.getById("ws_2", "audit_ws1_a")).toBeUndefined();
    } finally {
      t.close();
    }
  });
});

describe("withTransaction", () => {
  it("commits the callback result and rolls back every write when the callback throws", () => {
    const t = createTestDatabase();
    try {
      const insert = (id: string) =>
        t.db
          .prepare(
            "INSERT INTO audit_events (id, workspace_id, action, actor, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(id, "ws_1", "test.write", "system", AT);

      expect(
        withTransaction(t.db, () => {
          insert("audit_committed");
          return 42;
        }),
      ).toBe(42);

      // Application error after a write: the write is gone and the same error surfaces.
      const failure = new Error("synthetic failure after a write");
      let caught: unknown;
      try {
        withTransaction(t.db, () => {
          insert("audit_rolled_back");
          throw failure;
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(failure);

      // Constraint error on a later statement: the earlier statement is rolled back too.
      expect(() =>
        withTransaction(t.db, () => {
          insert("audit_first_of_pair");
          insert("audit_first_of_pair");
        }),
      ).toThrow(/UNIQUE constraint failed/i);

      expect(count(t.db, "audit_events", "ws_1")).toBe(1);
      expect(
        t.db.prepare("SELECT id FROM audit_events WHERE workspace_id = ? ORDER BY id").all("ws_1"),
      ).toEqual([{ id: "audit_committed" }]);
      // No transaction is left open, so the connection is immediately reusable.
      expect(withTransaction(t.db, () => count(t.db, "audit_events", "ws_1"))).toBe(1);
    } finally {
      t.close();
    }
  });

  it("nests through savepoints and composes async repository writes atomically", async () => {
    const t = createTestDatabase();
    try {
      const insert = (id: string) =>
        t.db
          .prepare(
            "INSERT INTO audit_events (id, workspace_id, action, actor, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(id, "ws_1", "test.write", "system", AT);
      const auditIds = () =>
        t.db
          .prepare("SELECT id FROM audit_events WHERE workspace_id = ? ORDER BY id")
          .all("ws_1")
          .map((r) => (r as { id: string }).id);

      // An inner failure rolls back only the inner unit; the outer unit still commits.
      withTransaction(t.db, () => {
        insert("outer");
        expect(() =>
          withTransaction(t.db, () => {
            insert("inner_failed");
            throw new Error("inner");
          }),
        ).toThrow("inner");
        withTransaction(t.db, () => insert("inner_ok"));
      });
      expect(auditIds()).toEqual(["inner_ok", "outer"]);

      // An outer failure rolls back a nested unit that had already released its savepoint.
      expect(() =>
        withTransaction(t.db, () => {
          withTransaction(t.db, () => insert("inner_then_outer_fails"));
          throw new Error("outer");
        }),
      ).toThrow("outer");
      expect(auditIds()).toEqual(["inner_ok", "outer"]);

      // Async composition: ledger transaction + evidence link land together or not at all.
      const ledger = new SqliteLedgerRepository(t.db);
      const links = new SqliteEvidenceLinkRepository(t.db);
      await seedAccounts(ledger, "ws_1");
      const importedAs: EvidenceLink = {
        id: "el_atomic",
        workspaceId: "ws_1",
        fromType: EVIDENCE_RECORD_TYPES.rawSourceRecord,
        fromId: "raw_1",
        toType: EVIDENCE_RECORD_TYPES.ledgerTransaction,
        toId: "tx_atomic",
        kind: "imported_as",
        createdAt: AT,
      };
      await expect(
        withTransactionAsync(t.db, async () => {
          await ledger.createTransaction("ws_1", draft("tx_atomic"));
          await links.link(importedAs);
          throw new Error("job failed after both writes");
        }),
      ).rejects.toThrow("job failed after both writes");
      expect(await ledger.getTransaction("ws_1", "tx_atomic")).toBeUndefined();
      expect(await links.getById("ws_1", "el_atomic")).toBeUndefined();

      const committed = await withTransactionAsync(t.db, async () => {
        const created = await ledger.createTransaction("ws_1", draft("tx_atomic"));
        await links.link(importedAs);
        return created.transaction.id;
      });
      expect(committed).toBe("tx_atomic");
      expect(await links.listForTransaction("ws_1", "tx_atomic")).toHaveLength(1);
    } finally {
      t.close();
    }
  });
});
