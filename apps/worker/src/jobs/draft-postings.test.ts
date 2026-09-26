import { createRawSourceRecord, SUSPENSE_ACCOUNTS, sumDecimals } from "@sona/core";
import {
  bankTransactionId,
  createWorkspaceBankRecordStore,
  type NormalizedTransaction,
} from "@sona/db";
import { describe, expect, it } from "vitest";
import { countRows, createTestHarness, SRC_1, type TestHarness, WS_1 } from "../test-support.js";
import {
  type DraftPostingSource,
  draftIdempotencyKey,
  draftTransactionId,
  ensureDraftPosting,
} from "./draft-postings.js";

const BANK_ACCOUNT = "Assets:Bank:Synthetic:acct_a";
const RAW_ID = "raw_page_0";

function normalized(overrides: Partial<NormalizedTransaction> = {}): NormalizedTransaction {
  return {
    accountExternalId: "acct_a",
    externalId: "txn_1",
    bookedOn: "2026-02-10",
    valueDate: "2026-02-11",
    amount: "-12.34",
    currency: "EUR",
    status: "BOOK",
    counterpartyName: "Synthetic Vendor",
    remittanceInfo: "Invoice 1",
    raw: {},
    ...overrides,
  };
}

/**
 * Persists the raw record and bank transaction the draft links back to
 * (evidence links require both endpoints to exist), then returns the draft input.
 */
async function persisted(
  h: TestHarness,
  overrides: Partial<NormalizedTransaction> = {},
): Promise<DraftPostingSource> {
  const transaction = normalized(overrides);
  const rawRecords = h.worker.repositories.rawRecords;
  if ((await rawRecords.getById(WS_1, RAW_ID)) === undefined) {
    await rawRecords.append(
      createRawSourceRecord({
        id: RAW_ID,
        workspaceId: WS_1,
        sourceId: SRC_1,
        externalId: "acct_a:transactions:0",
        recordType: "bank_transaction",
        payloadJson: { page: 0 },
        observedAt: h.clock.now(),
        createdAt: h.clock.now(),
      }),
    );
  }
  await createWorkspaceBankRecordStore(h.worker.repositories.bankRecords, WS_1).saveTransaction(
    transaction,
    { rawRecordId: RAW_ID },
  );
  return {
    ...transaction,
    bankTransactionId: bankTransactionId(
      SRC_1,
      transaction.accountExternalId,
      transaction.externalId,
    ),
    rawRecordId: RAW_ID,
  };
}

async function harnessWithAccounts(): Promise<TestHarness> {
  const h = await createTestHarness();
  await h.worker.repositories.ledger.ensureDefaultAccounts(WS_1, {
    createdAt: h.clock.now(),
    accountIdFor: () => h.ids(),
  });
  return h;
}

function deps(h: TestHarness) {
  return {
    ledger: h.worker.repositories.ledger,
    evidenceLinks: h.worker.repositories.evidenceLinks,
    reviewQueue: h.worker.repositories.reviewQueue,
    ids: h.ids,
  };
}

describe("ensureDraftPosting", () => {
  it("skips zero amounts and transactions without any date, writing nothing", async () => {
    const h = await harnessWithAccounts();
    try {
      const zero = await ensureDraftPosting(deps(h), {
        context: h.context,
        bankAccountPath: BANK_ACCOUNT,
        transaction: await persisted(h, { externalId: "zero", amount: "0.00" }),
        now: h.clock.now(),
      });
      expect(zero).toEqual({ state: "skipped", transaction: undefined, reason: "zero amount" });

      const undated = await ensureDraftPosting(deps(h), {
        context: h.context,
        bankAccountPath: BANK_ACCOUNT,
        transaction: await persisted(h, {
          externalId: "undated",
          bookedOn: undefined,
          valueDate: undefined,
        }),
        now: h.clock.now(),
      });
      expect(undated).toMatchObject({ state: "skipped", reason: "no booking or value date" });

      expect(countRows(h.db, "ledger_transactions", WS_1)).toBe(0);
      expect(countRows(h.db, "evidence_links", WS_1)).toBe(0);
    } finally {
      h.close();
    }
  });

  it("falls back to the value date, treats a missing status as booked, and balances non-EUR legs", async () => {
    const h = await harnessWithAccounts();
    try {
      const result = await ensureDraftPosting(deps(h), {
        context: h.context,
        bankAccountPath: BANK_ACCOUNT,
        transaction: await persisted(h, {
          externalId: "usd",
          bookedOn: undefined,
          valueDate: "2026-02-11",
          status: undefined,
          amount: "250.00",
          currency: "USD",
        }),
        now: h.clock.now(),
      });
      expect(result.state).toBe("created");
      const draft = result.transaction ?? fail("expected a draft");
      expect(draft).toMatchObject({
        id: draftTransactionId(bankTransactionId(SRC_1, "acct_a", "usd")),
        idempotencyKey: draftIdempotencyKey(bankTransactionId(SRC_1, "acct_a", "usd")),
        bookedOn: "2026-02-11",
        reviewState: "draft",
      });
      expect(draft.postings.map((p) => [p.account, p.amount.amount, p.amount.commodity])).toEqual([
        [BANK_ACCOUNT, "250.00", "USD"],
        [SUSPENSE_ACCOUNTS.unclassified, "-250.00", "USD"],
      ]);
      expect(sumDecimals(draft.postings.map((p) => p.amount.amount))).toMatch(/^-?0(\.0+)?$/);
      expect(draft.postings.every((p) => p.amount.commodity === "USD")).toBe(true);
    } finally {
      h.close();
    }
  });

  it("builds the description from counterparty and remittance, truncating at 200 characters", async () => {
    const h = await harnessWithAccounts();
    try {
      const counterparty = "C".repeat(150);
      const remittance = "R".repeat(100);
      const long = await ensureDraftPosting(deps(h), {
        context: h.context,
        bankAccountPath: BANK_ACCOUNT,
        transaction: await persisted(h, {
          externalId: "long",
          counterpartyName: counterparty,
          remittanceInfo: remittance,
        }),
        now: h.clock.now(),
      });
      const description = long.transaction?.description ?? "";
      expect(description).toHaveLength(200);
      expect(description.endsWith("…")).toBe(true);
      expect(description.startsWith(`${counterparty} — RRR`)).toBe(true);

      const bare = await ensureDraftPosting(deps(h), {
        context: h.context,
        bankAccountPath: BANK_ACCOUNT,
        transaction: await persisted(h, {
          externalId: "bare",
          counterpartyName: undefined,
          remittanceInfo: "   ",
        }),
        now: h.clock.now(),
      });
      expect(bare.transaction?.description).toBe("Bank transaction");
    } finally {
      h.close();
    }
  });

  it("is idempotent: a rerun reports unchanged and adds no rows or evidence links", async () => {
    const h = await harnessWithAccounts();
    try {
      const transaction = await persisted(h);
      const input = {
        context: h.context,
        bankAccountPath: BANK_ACCOUNT,
        transaction,
        now: h.clock.now(),
      };
      const first = await ensureDraftPosting(deps(h), input);
      expect(first.state).toBe("created");
      const links = await h.worker.repositories.evidenceLinks.listForTransaction(
        WS_1,
        first.transaction?.id ?? "",
      );
      expect(links.map((l) => [l.fromType, l.fromId, l.kind]).sort()).toEqual([
        ["bank_transaction", transaction.bankTransactionId, "imported_as"],
        ["raw_source_record", RAW_ID, "imported_as"],
      ]);
      const snapshot = () => ({
        ledger: countRows(h.db, "ledger_transactions", WS_1),
        postings: countRows(h.db, "ledger_postings", WS_1),
        links: countRows(h.db, "evidence_links", WS_1),
        accounts: countRows(h.db, "ledger_accounts", WS_1),
      });
      const before = snapshot();

      h.clock.advance(60_000);
      const again = await ensureDraftPosting(deps(h), { ...input, now: h.clock.now() });
      expect(again.state).toBe("unchanged");
      expect(again.transaction?.id).toBe(first.transaction?.id);
      expect(snapshot()).toEqual(before);
    } finally {
      h.close();
    }
  });

  it("supersedes only worker-owned drafts and carries receipts over to the replacement", async () => {
    const h = await harnessWithAccounts();
    try {
      const first = await ensureDraftPosting(deps(h), {
        context: h.context,
        bankAccountPath: BANK_ACCOUNT,
        transaction: await persisted(h),
        now: h.clock.now(),
      });
      const draft = first.transaction ?? fail("expected a draft");
      // A receipt already substantiates the draft.
      await h.worker.repositories.documents.save({
        id: "doc_r",
        workspaceId: WS_1,
        contentHash: "b".repeat(64),
        mimeType: "application/pdf",
        originalFilename: "r.pdf",
        storageUri: "sona-document://ws_1/doc_r",
        sourceKind: "upload",
        sourceMetadata: undefined,
        retentionState: "active",
        createdAt: h.clock.now(),
      });
      await h.worker.repositories.evidenceLinks.link({
        id: h.ids(),
        workspaceId: WS_1,
        fromType: "document",
        fromId: "doc_r",
        toType: "ledger_transaction",
        toId: draft.id,
        kind: "substantiates",
        createdAt: h.clock.now(),
      });

      // Correction 1: the draft is still the worker's, so it is superseded and
      // the receipt follows the replacement.
      h.clock.advance(60_000);
      const corrected = await ensureDraftPosting(deps(h), {
        context: h.context,
        bankAccountPath: BANK_ACCOUNT,
        transaction: await persisted(h, { amount: "-13.00" }),
        now: h.clock.now(),
      });
      expect(corrected.state).toBe("superseded");
      const replacement = corrected.transaction ?? fail("expected a replacement");
      expect(replacement.id).toBe(`${draftTransactionId(draft.id.slice("ledger_tx:".length))}:r1`);
      expect(replacement.idempotencyKey).toBe(
        `${draftIdempotencyKey(draft.id.slice("ledger_tx:".length))}:r1`,
      );
      const carried = await h.worker.repositories.evidenceLinks.listForTransaction(
        WS_1,
        replacement.id,
      );
      expect(carried.filter((l) => l.kind === "substantiates").map((l) => l.fromId)).toEqual([
        "doc_r",
      ]);

      // Correction 2 flips back to the original amount: compared against the
      // head, not the original, so a second replacement (r2) is created.
      h.clock.advance(60_000);
      const flipped = await ensureDraftPosting(deps(h), {
        context: h.context,
        bankAccountPath: BANK_ACCOUNT,
        transaction: await persisted(h, { amount: "-12.34" }),
        now: h.clock.now(),
      });
      expect(flipped.state).toBe("superseded");
      expect(flipped.transaction?.id).toMatch(/:r2$/);
      expect(flipped.transaction?.postings.map((p) => p.amount.amount).sort()).toEqual([
        "-12.34",
        "12.34",
      ]);
      expect(countRows(h.db, "ledger_transactions", WS_1)).toBe(3);

      // A human classifies the head: further corrections must not touch it.
      const head = flipped.transaction ?? fail("expected a head");
      await h.worker.repositories.ledger.transitionReviewState(WS_1, {
        id: head.id,
        toState: "user_reviewed",
        actor: "user_1",
        at: h.clock.now(),
      });
      h.clock.advance(60_000);
      const held = await ensureDraftPosting(deps(h), {
        context: h.context,
        bankAccountPath: BANK_ACCOUNT,
        transaction: await persisted(h, { amount: "-99.00" }),
        now: h.clock.now(),
      });
      expect(held.state).toBe("needs_review");
      expect(held.transaction?.id).toBe(head.id);
      expect(held.reason).toMatch(/user_reviewed/);
      expect(countRows(h.db, "ledger_transactions", WS_1)).toBe(3);
      expect((await h.worker.repositories.ledger.getTransaction(WS_1, head.id))?.reviewState).toBe(
        "user_reviewed",
      );
      const items = await h.worker.repositories.reviewQueue.listByState(WS_1, "suggested");
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        targetType: "ledger_transaction",
        targetId: head.id,
        reason: {
          kind: "bank_correction",
          ledgerTransactionId: head.id,
          reviewState: "user_reviewed",
          reported: { amount: "-99.00", currency: "EUR" },
        },
      });
      // Re-reporting the same correction does not open a second item.
      await ensureDraftPosting(deps(h), {
        context: h.context,
        bankAccountPath: BANK_ACCOUNT,
        transaction: await persisted(h, { amount: "-99.00" }),
        now: h.clock.now(),
      });
      expect(await h.worker.repositories.reviewQueue.listByState(WS_1, "suggested")).toHaveLength(
        1,
      );
    } finally {
      h.close();
    }
  });

  it("refuses to write a draft for another workspace's bank transaction", async () => {
    const h = await harnessWithAccounts();
    try {
      const transaction = await persisted(h);
      await h.worker.repositories.ledger.ensureDefaultAccounts("ws_2", {
        createdAt: h.clock.now(),
        accountIdFor: () => h.ids(),
      });
      // The evidence endpoints live in ws_1; ws_2 cannot link to them, and the
      // whole draft is rolled back with the failed link.
      await expect(
        ensureDraftPosting(deps(h), {
          context: h.otherContext,
          bankAccountPath: BANK_ACCOUNT,
          transaction,
          now: h.clock.now(),
        }),
      ).rejects.toThrow(/not found in workspace/);
      expect(countRows(h.db, "evidence_links", "ws_2")).toBe(0);
    } finally {
      h.close();
    }
  });
});

function fail(message: string): never {
  throw new Error(message);
}
