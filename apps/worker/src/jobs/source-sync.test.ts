import { SUSPENSE_ACCOUNTS, sumDecimals } from "@sona/core";
import type { PersistedLedgerTransaction } from "@sona/db";
import { describe, expect, it } from "vitest";
import {
  countRows,
  createTestHarness,
  SESSION_1,
  SRC_1,
  SYNTHETIC_TRANSACTIONS,
  syntheticAccount,
  syntheticSource,
  WS_1,
  WS_2,
} from "../test-support.js";
import { accountSegment, bankAccountPath } from "./draft-postings.js";

function assertBalanced(transaction: PersistedLedgerTransaction): void {
  const byCommodity = new Map<string, string[]>();
  for (const posting of transaction.postings) {
    const list = byCommodity.get(posting.amount.commodity) ?? [];
    list.push(posting.amount.amount);
    byCommodity.set(posting.amount.commodity, list);
  }
  for (const [commodity, amounts] of byCommodity) {
    expect(sumDecimals(amounts), `${transaction.id} ${commodity}`).toMatch(/^-?0(\.0+)?$/);
  }
}

describe("account path helpers", () => {
  it("sanitizes labels into valid account segments", () => {
    expect(accountSegment("Synthetic Bank src_1")).toBe("Synthetic Bank src_1");
    expect(accountSegment("DE:Giro/Main")).toBe("DE_Giro_Main");
    expect(accountSegment("  ")).toBe("Unknown");
    expect(accountSegment("-dash")).toBe("A-dash");
    expect(bankAccountPath("src_1", "idhash_1")).toBe("Assets:Bank:src_1:idhash_1");
  });
});

describe("source_sync job", () => {
  it("syncs a source and creates balanced draft postings linked to raw and bank records", async () => {
    const h = await createTestHarness();
    try {
      const { job } = await h.worker.queue.enqueue(h.context, "source_sync", { sourceId: SRC_1 });
      const [outcome] = await h.worker.runOnce();
      expect(outcome).toMatchObject({ state: "succeeded", kind: "source_sync" });
      expect(h.gatewayCalls).toEqual([{ workspaceId: WS_1, sourceId: SRC_1 }]);

      const runs = await h.worker.queue.listRuns(h.context, job.id);
      expect(runs[0]?.result).toMatchObject({
        syncStatus: "succeeded",
        accountsSynced: 1,
        transactionsSynced: 2,
        drafts: { created: 2, unchanged: 0, superseded: 0, skipped: 0 },
        errors: [],
      });

      const ledger = h.worker.repositories.ledger;
      const drafts = await ledger.listTransactions(WS_1);
      expect(drafts).toHaveLength(2);
      for (const draft of drafts) {
        assertBalanced(draft);
        expect(draft.reviewState).toBe("draft");
        expect(draft.postings.map((p) => p.account).sort()).toEqual(
          [bankAccountPath(SRC_1, "idhash_synth_1"), SUSPENSE_ACCOUNTS.unclassified].sort(),
        );
      }
      const outflow = drafts.find((d) => d.description.startsWith("Example Handwerk"));
      expect(outflow?.postings.map((p) => p.amount.amount).sort()).toEqual(["-84.23", "84.23"]);
      expect(outflow?.bookedOn).toBe("2026-01-15");
      expect(outflow?.idempotencyKey).toBe(
        "draft_posting:bank_transaction:src_1:idhash_synth_1:txn_synth_handwerk",
      );

      // Provenance: evidence links from bank transaction and raw record, run provenance, audit.
      const links = await h.worker.repositories.evidenceLinks.listForTransaction(
        WS_1,
        outflow?.id ?? "",
      );
      expect(links.map((l) => [l.fromType, l.kind]).sort()).toEqual([
        ["bank_transaction", "imported_as"],
        ["raw_source_record", "imported_as"],
      ]);
      const rawLink = links.find((l) => l.fromType === "raw_source_record");
      expect(
        await h.worker.repositories.rawRecords.getById(WS_1, rawLink?.fromId ?? ""),
      ).toMatchObject({ recordType: "bank_transaction" });
      expect(runs[0]?.produced).toEqual(
        expect.arrayContaining(drafts.map((d) => ({ type: "ledger_transaction", id: d.id }))),
      );
      expect(countRows(h.db, "ledger_transactions", WS_2)).toBe(0);
    } finally {
      h.close();
    }
  });

  it("re-running the sync in a new window creates no new raw, bank, ledger, or evidence rows", async () => {
    const h = await createTestHarness();
    try {
      await h.worker.queue.enqueue(h.context, "source_sync", { sourceId: SRC_1, window: "w1" });
      await h.worker.runOnce();
      const snapshot = () => ({
        raw: countRows(h.db, "raw_source_records", WS_1),
        bank: countRows(h.db, "bank_transactions", WS_1),
        ledger: countRows(h.db, "ledger_transactions", WS_1),
        postings: countRows(h.db, "ledger_postings", WS_1),
        links: countRows(h.db, "evidence_links", WS_1),
        accounts: countRows(h.db, "ledger_accounts", WS_1),
      });
      const before = snapshot();
      expect(before.ledger).toBe(2);

      h.clock.advance(60 * 60_000);
      const again = await h.worker.queue.enqueue(h.context, "source_sync", {
        sourceId: SRC_1,
        window: "w2",
      });
      expect(again.created).toBe(true);
      const [outcome] = await h.worker.runOnce();
      expect(outcome?.state).toBe("succeeded");
      const runs = await h.worker.queue.listRuns(h.context, again.job.id);
      expect(runs[0]?.result).toMatchObject({
        drafts: { created: 0, unchanged: 2, superseded: 0, skipped: 0 },
      });
      // Sync runs are the only rows that grow: one per sync.
      expect(snapshot()).toEqual(before);
      expect(countRows(h.db, "source_sync_runs", WS_1)).toBe(2);
    } finally {
      h.close();
    }
  });

  it("supersedes a draft when the bank corrects an imported transaction, never editing in place", async () => {
    const h = await createTestHarness();
    try {
      await h.worker.queue.enqueue(h.context, "source_sync", { sourceId: SRC_1, window: "w1" });
      await h.worker.runOnce();
      const ledger = h.worker.repositories.ledger;
      const original = (await ledger.listTransactions(WS_1)).find((d) =>
        d.description.startsWith("Example Handwerk"),
      );
      expect(original).toBeDefined();

      // The bank re-reports the same entry with a corrected amount.
      const session = h.bank.sessions.get(SESSION_1);
      if (session === undefined) {
        throw new Error("missing session");
      }
      session.accounts = [
        syntheticAccount({
          transactions: [
            {
              ...SYNTHETIC_TRANSACTIONS.handwerk,
              transaction_amount: { amount: "85.00", currency: "EUR" },
            },
            SYNTHETIC_TRANSACTIONS.rent,
          ],
        }),
      ];
      h.clock.advance(60 * 60_000);
      const second = await h.worker.queue.enqueue(h.context, "source_sync", {
        sourceId: SRC_1,
        window: "w2",
      });
      const [outcome] = await h.worker.runOnce();
      expect(outcome?.state).toBe("succeeded");
      expect((await h.worker.queue.listRuns(h.context, second.job.id))[0]?.result).toMatchObject({
        drafts: { created: 0, unchanged: 1, superseded: 1, skipped: 0 },
      });

      const superseded = await ledger.getTransaction(WS_1, original?.id ?? "");
      expect(superseded?.reviewState).toBe("superseded");
      expect(superseded?.postings.map((p) => p.amount.amount).sort()).toEqual(["-84.23", "84.23"]);
      const replacement = await ledger.getTransaction(
        WS_1,
        superseded?.supersededByTransactionId ?? "",
      );
      expect(replacement?.postings.map((p) => p.amount.amount).sort()).toEqual(["-85.00", "85.00"]);
      expect(replacement?.reviewState).toBe("draft");
      assertBalanced(replacement ?? original ?? fail());

      // A third identical sync is a no-op against the corrected head.
      h.clock.advance(60 * 60_000);
      const third = await h.worker.queue.enqueue(h.context, "source_sync", {
        sourceId: SRC_1,
        window: "w3",
      });
      await h.worker.runOnce();
      expect((await h.worker.queue.listRuns(h.context, third.job.id))[0]?.result).toMatchObject({
        drafts: { created: 0, unchanged: 2, superseded: 0, skipped: 0 },
      });
      expect(countRows(h.db, "ledger_transactions", WS_1)).toBe(3);
    } finally {
      h.close();
    }
  });

  it("skips pending transactions and reports them", async () => {
    const h = await createTestHarness({
      bankSessions: {
        [SESSION_1]: {
          status: "AUTHORIZED",
          accounts: [
            syntheticAccount({
              transactions: [SYNTHETIC_TRANSACTIONS.pending, SYNTHETIC_TRANSACTIONS.handwerk],
            }),
          ],
        },
      },
    });
    try {
      const { job } = await h.worker.queue.enqueue(h.context, "source_sync", { sourceId: SRC_1 });
      await h.worker.runOnce();
      expect((await h.worker.queue.listRuns(h.context, job.id))[0]?.result).toMatchObject({
        transactionsSynced: 2,
        drafts: { created: 1, unchanged: 0, superseded: 0, skipped: 1 },
      });
      expect(countRows(h.db, "bank_transactions", WS_1)).toBe(2);
      expect(countRows(h.db, "ledger_transactions", WS_1)).toBe(1);
    } finally {
      h.close();
    }
  });

  it("follows continuation keys so every page of transactions gets a draft", async () => {
    const third = {
      ...SYNTHETIC_TRANSACTIONS.handwerk,
      entry_reference: "txn_synth_third",
      transaction_amount: { amount: "19.99", currency: "EUR" },
      booking_date: "2026-01-20",
      value_date: "2026-01-20",
      creditor: { name: "Third Merchant" },
      remittance_information: ["Order 3"],
    };
    const h = await createTestHarness({
      bankSessions: {
        [SESSION_1]: {
          status: "AUTHORIZED",
          accounts: [
            syntheticAccount({
              transactions: [SYNTHETIC_TRANSACTIONS.handwerk, SYNTHETIC_TRANSACTIONS.rent, third],
              pageSize: 1,
            }),
          ],
        },
      },
    });
    try {
      const { job } = await h.worker.queue.enqueue(h.context, "source_sync", { sourceId: SRC_1 });
      const [outcome] = await h.worker.runOnce();
      expect(outcome?.state).toBe("succeeded");
      expect(h.bank.transactionRequests.map((r) => r.continuationKey)).toEqual([
        undefined,
        "1",
        "2",
      ]);
      expect((await h.worker.queue.listRuns(h.context, job.id))[0]?.result).toMatchObject({
        transactionsSynced: 3,
        drafts: { created: 3, unchanged: 0, superseded: 0, skipped: 0 },
      });
      const drafts = await h.worker.repositories.ledger.listTransactions(WS_1);
      expect(drafts.map((d) => d.bookedOn).sort()).toEqual([
        "2026-01-15",
        "2026-01-20",
        "2026-01-28",
      ]);
      // Each page is its own raw record; the third draft links back to page 2.
      const thirdDraft = drafts.find((d) => d.description.startsWith("Third Merchant"));
      const links = await h.worker.repositories.evidenceLinks.listForTransaction(
        WS_1,
        thirdDraft?.id ?? "",
      );
      const rawLink = links.find((l) => l.fromType === "raw_source_record");
      expect(
        await h.worker.repositories.rawRecords.getById(WS_1, rawLink?.fromId ?? ""),
      ).toMatchObject({ payloadJson: expect.objectContaining({ page: 2 }) });
    } finally {
      h.close();
    }
  });

  it("passes the payload's transaction query to the provider for the first page only", async () => {
    const h = await createTestHarness({
      bankSessions: {
        [SESSION_1]: {
          status: "AUTHORIZED",
          accounts: [syntheticAccount({ pageSize: 1 })],
        },
      },
    });
    try {
      await h.worker.queue.enqueue(h.context, "source_sync", {
        sourceId: SRC_1,
        transactionQuery: { dateFrom: "2025-01-01", dateTo: "2026-01-31", strategy: "longest" },
      });
      const [outcome] = await h.worker.runOnce();
      expect(outcome?.state).toBe("succeeded");
      expect(h.bank.transactionRequests).toEqual([
        {
          accountUid: "acc_synth_1",
          continuationKey: undefined,
          dateFrom: "2025-01-01",
          dateTo: "2026-01-31",
          strategy: "longest",
        },
        {
          accountUid: "acc_synth_1",
          continuationKey: "1",
          dateFrom: undefined,
          dateTo: undefined,
          strategy: undefined,
        },
      ]);
    } finally {
      h.close();
    }
  });

  it("completes with errors when one account fails, still drafting the healthy account", async () => {
    const h = await createTestHarness({
      bankSessions: {
        [SESSION_1]: {
          status: "AUTHORIZED",
          accounts: [
            syntheticAccount({
              uid: "acc_bad",
              identificationHash: "idhash_bad",
              failWith: "ASPSP timeout for session_id=sess_leaky_1",
            }),
            syntheticAccount(),
          ],
        },
      },
    });
    try {
      const { job } = await h.worker.queue.enqueue(h.context, "source_sync", { sourceId: SRC_1 });
      const [outcome] = await h.worker.runOnce();
      // The job itself succeeds; the partial failure is part of its result.
      expect(outcome?.state).toBe("succeeded");
      const result = (await h.worker.queue.listRuns(h.context, job.id))[0]?.result as {
        syncStatus: string;
        accountsSynced: number;
        drafts: Record<string, number>;
        errors: Array<{ accountUid: string; message: string }>;
      };
      expect(result).toMatchObject({
        syncStatus: "completed_with_errors",
        accountsSynced: 1,
        drafts: { created: 2, unchanged: 0, superseded: 0, skipped: 0 },
      });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.accountUid).toBe("acc_bad");
      expect(result.errors[0]?.message).toContain("ASPSP timeout");
      expect(result.errors[0]?.message).not.toContain("sess_leaky_1");
      // The sync run row is redacted too, not just the job result.
      const errorJson = h.db
        .prepare("SELECT error_json FROM source_sync_runs WHERE workspace_id = ?")
        .get(WS_1) as { error_json: string };
      expect(errorJson.error_json).toContain("ASPSP timeout");
      expect(errorJson.error_json).not.toContain("sess_leaky_1");

      const runRow = h.db
        .prepare("SELECT status FROM source_sync_runs WHERE workspace_id = ?")
        .get(WS_1) as { status: string };
      expect(runRow.status).toBe("completed_with_errors");
      expect(countRows(h.db, "ledger_transactions", WS_1)).toBe(2);
      expect(countRows(h.db, "bank_accounts", WS_1)).toBe(1);
    } finally {
      h.close();
    }
  });

  it("dead-letters a sync for an unknown, paused, or unsupported source without touching the gateway", async () => {
    const h = await createTestHarness();
    try {
      await h.worker.repositories.sources.create({
        ...syntheticSource(WS_1, "src_mail"),
        kind: "email",
      });
      await h.worker.repositories.sources.setStatus(WS_1, SRC_1, "paused");
      await h.worker.queue.enqueue(h.context, "source_sync", { sourceId: "missing" });
      await h.worker.queue.enqueue(h.context, "source_sync", { sourceId: "src_mail" });
      await h.worker.queue.enqueue(h.context, "source_sync", { sourceId: SRC_1 });

      const outcomes = await h.worker.runOnce();
      expect(outcomes.map((o) => [o.state, o.error])).toEqual([
        ["dead", "NonRetryableJobError: source missing not found in workspace"],
        ["dead", "NonRetryableJobError: source kind email cannot be synced by this worker"],
        ["dead", "NonRetryableJobError: source src_1 is paused, not active"],
      ]);
      expect(h.gatewayCalls).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("retries when the provider session fails and records the failed sync run", async () => {
    const h = await createTestHarness({
      bankSessions: { [SESSION_1]: { status: "EXPIRED", accounts: [] } },
    });
    try {
      const { job } = await h.worker.queue.enqueue(h.context, "source_sync", { sourceId: SRC_1 });
      const [outcome] = await h.worker.runOnce();
      expect(outcome?.state).toBe("retry_scheduled");
      expect(outcome?.error).toMatch(/not authorized/);
      expect((await h.worker.queue.get(h.context, job.id))?.attempts).toBe(1);
      const sqliteRow = h.db
        .prepare("SELECT status FROM source_sync_runs WHERE workspace_id = ?")
        .get(WS_1) as { status: string };
      expect(sqliteRow.status).toBe("failed");
      expect(countRows(h.db, "ledger_transactions", WS_1)).toBe(0);
    } finally {
      h.close();
    }
  });

  it("keeps workspaces apart: each source syncs into its own workspace only", async () => {
    const h = await createTestHarness();
    try {
      await h.worker.queue.enqueue(h.context, "source_sync", { sourceId: SRC_1 });
      await h.worker.queue.enqueue(h.otherContext, "source_sync", { sourceId: "src_2" });
      const outcomes = await h.worker.runOnce();
      expect(outcomes.map((o) => [o.workspaceId, o.state])).toEqual([
        [WS_1, "succeeded"],
        [WS_2, "succeeded"],
      ]);
      expect(countRows(h.db, "ledger_transactions", WS_1)).toBe(2);
      expect(countRows(h.db, "ledger_transactions", WS_2)).toBe(1);
      expect(await h.worker.repositories.ledger.listTransactions(WS_2)).toHaveLength(1);
      // Enqueueing ws_1's source from ws_2 fails as unknown in that workspace.
      await h.worker.queue.enqueue(h.otherContext, "source_sync", { sourceId: SRC_1 });
      const [cross] = await h.worker.runOnce();
      expect(cross).toMatchObject({ workspaceId: WS_2, state: "dead" });
    } finally {
      h.close();
    }
  });
});

function fail(): never {
  throw new Error("expected a transaction");
}
