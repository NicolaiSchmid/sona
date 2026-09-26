import { DEFAULT_ACCOUNTS, type EvidenceLink } from "@sona/core";
import { describe, expect, it } from "vitest";
import type { DbClient } from "../runner.js";
import { type AuditEvent, SqliteAuditEventRepository } from "./audit-events.js";
import { EVIDENCE_RECORD_TYPES, SqliteEvidenceLinkRepository } from "./evidence-links.js";
import { requiredNumber, row } from "./helpers.js";
import {
  type CreateLedgerTransactionInput,
  type LedgerPostingInput,
  SqliteLedgerRepository,
  UnbalancedLedgerTransactionError,
} from "./ledger.js";
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

      const first = await ledger.createTransaction(
        "ws_1",
        draft("tx_1", { idempotencyKey: "import:1" }),
      );
      const replay = await ledger.createTransaction(
        "ws_1",
        draft("tx_1_retry", { idempotencyKey: "import:1", description: "changed" }),
      );
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
          reviewState: "user_reviewed",
          postings: [eur(BANK, "-20.00"), eur(MAINTENANCE, "20.00")],
        }),
      );
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
      const original = (
        await ledger.createTransaction(
          "ws_1",
          draft("tx_1", { reviewState: "suggested", idempotencyKey: "import:1" }),
        )
      ).transaction;

      const result = await ledger.supersedeTransaction("ws_1", {
        supersedesTransactionId: "tx_1",
        replacement: draft("tx_2", {
          postings: [eur(BANK, "-84.23"), eur(MAINTENANCE, "84.23")],
          reviewState: "user_reviewed",
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
        reviewState: "user_reviewed",
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
      expect(
        t.db
          .prepare(
            "SELECT from_state, to_state, actor, notes FROM review_events WHERE workspace_id = ? AND target_type = 'ledger_transaction' AND target_id = ?",
          )
          .all("ws_1", "tx_1"),
      ).toEqual([
        {
          from_state: "suggested",
          to_state: "superseded",
          actor: "user:test",
          notes: "classified after receipt arrived",
        },
      ]);
      // The original idempotency key still resolves to the superseded transaction.
      expect(
        await ledger.createTransaction("ws_1", draft("tx_replay", { idempotencyKey: "import:1" })),
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
});
