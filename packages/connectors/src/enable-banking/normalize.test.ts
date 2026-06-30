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
  it("preserves stable id, iban and raw payload", () => {
    const account = normalizeAccount(ACCOUNT_DETAILS_FIXTURE);
    expect(account.externalId).toBe("acc_demo_1");
    expect(account.iban).toBe("DE00000000000000000000");
    expect(account.currency).toBe("EUR");
    expect(account.raw).toEqual(ACCOUNT_DETAILS_FIXTURE);
  });

  it("falls back to a stable hash id when uid and iban are missing", () => {
    const a = normalizeAccount({ name: "No id" });
    const b = normalizeAccount({ name: "No id" });
    expect(a.externalId).toBe(b.externalId);
    expect(a.externalId.startsWith("eb_")).toBe(true);
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
});
