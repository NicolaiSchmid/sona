import { describe, expect, it } from "vitest";
import {
  ACCOUNT_DETAILS_FIXTURE,
  BALANCES_FIXTURE,
  SESSION_FIXTURE,
  TRANSACTIONS_FIXTURE,
} from "./fixtures.js";
import {
  accountUidsFromSession,
  normalizeAccount,
  normalizeBalance,
  normalizeTransaction,
} from "./normalize.js";
import type { EbTransaction } from "./types.js";

/** Asserts a fixture element exists (keeps tests free of non-null assertions). */
function req<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("missing fixture element");
  }
  return value;
}

describe("accountUidsFromSession", () => {
  it("handles object and string account references", () => {
    expect(accountUidsFromSession(SESSION_FIXTURE)).toEqual(["acc_demo_1", "acc_demo_2"]);
  });
});

describe("normalizeAccount", () => {
  it("uses the stable identification hash, not the session uid", () => {
    const account = normalizeAccount(ACCOUNT_DETAILS_FIXTURE);
    expect(account.externalId).toBe("idhash_demo_1");
    expect(account.iban).toBe("DE00000000000000000000");
    expect(account.currency).toBe("EUR");
    expect(account.raw).toEqual(ACCOUNT_DETAILS_FIXTURE);
  });

  it("prefers identification_hash over a session-scoped uid", () => {
    const account = normalizeAccount({ uid: "session_only", identification_hash: "stable_1" });
    expect(account.externalId).toBe("stable_1");
  });

  it("falls back to IBAN, then a stable hash, when no identification hash exists", () => {
    expect(normalizeAccount({ account_id: { iban: "DE123" } }).externalId).toBe("DE123");
    const a = normalizeAccount({ name: "No id" });
    const b = normalizeAccount({ name: "No id" });
    expect(a.externalId).toBe(b.externalId);
    expect(a.externalId.startsWith("eb_")).toBe(true);
  });

  it("excludes the session uid from the fallback hash", () => {
    // Same account re-authorized in a new session (new uid) must keep its id.
    const a = normalizeAccount({ name: "X", currency: "EUR", uid: "session_1" });
    const b = normalizeAccount({ name: "X", currency: "EUR", uid: "session_2" });
    expect(a.externalId).toBe(b.externalId);
  });
});

describe("normalizeBalance", () => {
  it("carries amount, currency and reference date", () => {
    const balance = normalizeBalance("acc_demo_1", req(BALANCES_FIXTURE.balances[0]));
    expect(balance).toMatchObject({
      accountExternalId: "acc_demo_1",
      amount: "1234.56",
      currency: "EUR",
      type: "CLBD",
      referenceDate: "2026-01-31",
    });
  });
});

describe("normalizeTransaction", () => {
  it("signs debits negative and keeps the counterparty + remittance", () => {
    const debit = normalizeTransaction("acc_demo_1", req(TRANSACTIONS_FIXTURE.transactions[0]));
    expect(debit.amount).toBe("-84.23");
    expect(debit.counterpartyName).toBe("Example Handwerk GmbH");
    expect(debit.remittanceInfo).toBe("Rechnung 2026-0042");
    expect(debit.externalId).toBe("txn_demo_out");
  });

  it("keeps credits positive and uses the debtor as counterparty", () => {
    const credit = normalizeTransaction("acc_demo_1", req(TRANSACTIONS_FIXTURE.transactions[1]));
    expect(credit.amount).toBe("2500.00");
    expect(credit.counterpartyName).toBe("Tenant Mietzahlung");
  });

  it("exposes the booking status for downstream gating", () => {
    const pending = normalizeTransaction("acc", {
      transaction_amount: { amount: "5.00", currency: "EUR" },
      credit_debit_indicator: "DBIT",
      status: "PDNG",
      entry_reference: "e1",
    });
    expect(pending.status).toBe("PDNG");
  });

  it("disambiguates identical hash-fallback transactions by index", () => {
    const tx: EbTransaction = {
      transaction_amount: { amount: "9.99", currency: "EUR" },
      credit_debit_indicator: "DBIT",
      booking_date: "2026-01-10",
    };
    const first = normalizeTransaction("acc", tx, { index: 0 });
    const second = normalizeTransaction("acc", tx, { index: 1 });
    expect(first.externalId).not.toBe(second.externalId);
    // Same index is stable across runs.
    expect(normalizeTransaction("acc", tx, { index: 0 }).externalId).toBe(first.externalId);
  });

  it("derives a stable hash id when entry_reference is missing", () => {
    const tx: EbTransaction = {
      transaction_amount: { amount: "5.00", currency: "EUR" },
      credit_debit_indicator: "DBIT",
    };
    const a = normalizeTransaction("acc_demo_1", tx);
    const b = normalizeTransaction("acc_demo_1", tx);
    expect(a.externalId).toBe(b.externalId);
    expect(a.externalId.startsWith("eb_")).toBe(true);
  });

  it("excludes volatile provider fields from the fallback hash", () => {
    const base: EbTransaction = {
      transaction_amount: { amount: "5.00", currency: "EUR" },
      credit_debit_indicator: "DBIT",
      booking_date: "2026-01-01",
    };
    const withVolatile = { ...base, transaction_id: "detail_only_999" } as EbTransaction;
    expect(normalizeTransaction("acc", base).externalId).toBe(
      normalizeTransaction("acc", withVolatile).externalId,
    );
  });
});
