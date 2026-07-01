import type { RawSourceRecord } from "@sona/core";
import { describe, expect, it } from "vitest";
import { EnableBankingApiError, type EnableBankingClient } from "./client.js";
import {
  ACCOUNT_DETAILS_FIXTURE,
  BALANCES_FIXTURE,
  SESSION_FIXTURE,
  TRANSACTIONS_FIXTURE,
} from "./fixtures.js";
import {
  type BankRecordStore,
  type RawRecordStore,
  runEnableBankingSync,
  type SyncEnv,
  type SyncRunStore,
} from "./sync.js";

interface Harness {
  client: EnableBankingClient;
  rawStore: RawRecordStore;
  bankStore: BankRecordStore;
  runStore: SyncRunStore;
  env: SyncEnv;
  events: string[];
  raws: RawSourceRecord[];
  runEvents: Array<[string, unknown]>;
}

function harness(options: { failTransactionsFor?: string } = {}): Harness {
  const events: string[] = [];
  const raws: RawSourceRecord[] = [];
  const runEvents: Array<[string, unknown]> = [];
  let counter = 0;

  const client: EnableBankingClient = {
    getApplication: async () => ({ name: "demo" }),
    listAspsps: async () => ({ aspsps: [] }),
    startAuth: async () => ({ url: "https://auth.example" }),
    exchangeCode: async () => SESSION_FIXTURE,
    getSession: async () => SESSION_FIXTURE,
    getAccountDetails: async ({ accountUid }) => ({
      ...ACCOUNT_DETAILS_FIXTURE,
      uid: accountUid,
      identification_hash: `idhash_${accountUid}`,
    }),
    getBalances: async () => BALANCES_FIXTURE,
    getTransactions: async ({ accountUid }) => {
      if (options.failTransactionsFor === accountUid) {
        throw new EnableBankingApiError(503, "GET", `/accounts/${accountUid}/transactions`, "");
      }
      return TRANSACTIONS_FIXTURE;
    },
  };

  const rawStore: RawRecordStore = {
    append: async (record) => {
      raws.push(record);
      events.push(`raw:${record.recordType}`);
    },
  };
  const bankStore: BankRecordStore = {
    saveAccount: async () => {
      events.push("account");
    },
    saveBalance: async () => {
      events.push("balance");
    },
    saveTransaction: async () => {
      events.push("transaction");
    },
  };
  const runStore: SyncRunStore = {
    start: async (run) => {
      runEvents.push(["start", run]);
    },
    recordError: async (err) => {
      runEvents.push(["error", err]);
    },
    finish: async (run) => {
      runEvents.push(["finish", run]);
    },
  };
  const env: SyncEnv = {
    ids: () => `id_${counter++}`,
    nowIso: () => "2026-02-01T00:00:00Z",
  };

  return { client, rawStore, bankStore, runStore, env, events, raws, runEvents };
}

const baseInput = { workspaceId: "ws_1", sourceId: "src_1", sessionId: "sess_demo_1" };

describe("runEnableBankingSync", () => {
  it("syncs all accounts and writes raw records before normalized ones", async () => {
    const h = harness();
    const summary = await runEnableBankingSync({ ...baseInput, ...h });

    expect(summary.accountsSynced).toBe(2);
    expect(summary.balancesSynced).toBe(2);
    expect(summary.transactionsSynced).toBe(4);
    expect(summary.errors).toEqual([]);

    // Raw kinds are all present.
    const kinds = h.raws.map((r) => r.recordType).sort();
    expect(kinds).toEqual([
      "bank_account",
      "bank_account",
      "bank_balance",
      "bank_balance",
      "bank_transaction",
      "bank_transaction",
    ]);

    // The first account's raw is appended before its normalized account is saved.
    expect(h.events.indexOf("raw:bank_account")).toBeLessThan(h.events.indexOf("account"));

    const finish = h.runEvents.find(([kind]) => kind === "finish");
    expect((finish?.[1] as { status: string }).status).toBe("succeeded");
  });

  it("records a per-account error without failing the whole sync", async () => {
    const h = harness({ failTransactionsFor: "acc_demo_2" });
    const summary = await runEnableBankingSync({ ...baseInput, ...h });

    expect(summary.accountsSynced).toBe(2);
    expect(summary.transactionsSynced).toBe(2); // only acc_demo_1
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]?.accountUid).toBe("acc_demo_2");

    expect(h.runEvents.some(([kind]) => kind === "error")).toBe(true);
    const finish = h.runEvents.find(([kind]) => kind === "finish");
    expect((finish?.[1] as { status: string }).status).toBe("completed_with_errors");
  });

  it("follows continuation keys to import every transaction page", async () => {
    const h = harness();
    const single = { uid: "acc_one" };
    h.client.getSession = async () => ({ session_id: "s", accounts: [single] });
    let call = 0;
    h.client.getTransactions = async ({ continuationKey }) => {
      call += 1;
      if (continuationKey === undefined) {
        return {
          transactions: [
            {
              entry_reference: "p1a",
              transaction_amount: { amount: "1.00", currency: "EUR" },
              credit_debit_indicator: "DBIT",
            },
          ],
          continuation_key: "page2",
        };
      }
      return {
        transactions: [
          {
            entry_reference: "p2a",
            transaction_amount: { amount: "2.00", currency: "EUR" },
            credit_debit_indicator: "DBIT",
          },
        ],
      };
    };

    const summary = await runEnableBankingSync({ ...baseInput, ...h });

    expect(call).toBe(2);
    expect(summary.transactionsSynced).toBe(2);
    // One raw transaction page record per page.
    expect(h.raws.filter((r) => r.recordType === "bank_transaction")).toHaveLength(2);
  });

  it("stops paginating on a null continuation key", async () => {
    const h = harness();
    h.client.getSession = async () => ({
      session_id: "s",
      status: "AUTHORIZED",
      accounts: [{ uid: "acc_one" }],
    });
    let call = 0;
    h.client.getTransactions = async () => {
      call += 1;
      return { transactions: [], continuation_key: null };
    };

    const summary = await runEnableBankingSync({ ...baseInput, ...h });
    expect(call).toBe(1);
    expect(summary.errors).toEqual([]);
  });

  it("fails the run for a non-authorized session", async () => {
    const h = harness();
    h.client.getSession = async () => ({ session_id: "s", status: "EXPIRED", accounts: [] });

    await expect(runEnableBankingSync({ ...baseInput, ...h })).rejects.toThrow(/not authorized/);
    const finish = h.runEvents.find(([kind]) => kind === "finish");
    expect((finish?.[1] as { status: string }).status).toBe("failed");
  });

  it("finishes the run as failed when the session fetch throws", async () => {
    const h = harness();
    h.client.getSession = async () => {
      throw new EnableBankingApiError(403, "GET", "/sessions/x", "consent revoked");
    };

    await expect(runEnableBankingSync({ ...baseInput, ...h })).rejects.toBeInstanceOf(
      EnableBankingApiError,
    );

    const finish = h.runEvents.find(([kind]) => kind === "finish");
    expect((finish?.[1] as { status: string }).status).toBe("failed");
    expect(h.runEvents.some(([kind]) => kind === "error")).toBe(true);
  });
});
