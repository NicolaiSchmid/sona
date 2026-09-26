import { describe, expect, it } from "vitest";
import { validateBalancedTransaction } from "../ledger/balance";
import {
  buildPortfolioDraftTransaction,
  DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS,
  type PortfolioLedgerAccounts,
  UnbalancedPortfolioDraftError,
} from "./postings";
import {
  CASH_MOVEMENT_TYPES,
  type CashMovement,
  cashDirectionFor,
  type PortfolioEvent,
  SECURITY_TRANSACTION_TYPES,
  type SecurityTransaction,
} from "./types";

const SECURITY = {
  isin: "XS0000000001",
  wkn: "TEST01",
  ticker: "TST",
  name: "Synthetic World ETF",
};

function securityTx(overrides: Partial<SecurityTransaction> = {}): SecurityTransaction {
  return {
    kind: "security_transaction",
    type: "buy",
    externalId: "evt_buy",
    brokerAccountExternalId: "depot",
    date: "2026-03-02",
    amount: { amount: "-1005.00", commodity: "EUR" },
    security: SECURITY,
    shares: "10",
    gross: undefined,
    exchangeRate: undefined,
    fees: "5.00",
    taxes: "0",
    note: undefined,
    raw: {},
    ...overrides,
  };
}

function cashMovement(overrides: Partial<CashMovement> = {}): CashMovement {
  return {
    kind: "cash_movement",
    type: "deposit",
    externalId: "evt_dep",
    brokerAccountExternalId: "konto",
    date: "2026-03-01",
    amount: { amount: "2000.00", commodity: "EUR" },
    security: undefined,
    note: undefined,
    raw: {},
    ...overrides,
  };
}

let counter = 0;
const env = {
  workspaceId: "ws_1",
  ids: () => `id_${counter++}`,
  createdAt: "2026-03-05T00:00:00Z",
};

function amountsFor(tx: ReturnType<typeof buildPortfolioDraftTransaction>, account: string) {
  return tx.postings.filter((p) => p.account === account).map((p) => p.amount);
}

describe("buildPortfolioDraftTransaction", () => {
  it("always produces a draft that balances per commodity", () => {
    const events: PortfolioEvent[] = [
      securityTx(),
      securityTx({
        type: "sell",
        externalId: "s",
        amount: { amount: "995.00", commodity: "EUR" },
        taxes: "12.50",
      }),
      securityTx({
        type: "dividend",
        externalId: "d",
        amount: { amount: "78.70", commodity: "EUR" },
        fees: "0",
        taxes: "13.89",
      }),
      securityTx({
        type: "delivery_inbound",
        externalId: "di",
        amount: { amount: "500.00", commodity: "EUR" },
        fees: "0",
      }),
      securityTx({
        type: "delivery_outbound",
        externalId: "do",
        amount: { amount: "-500.00", commodity: "EUR" },
        fees: "0",
      }),
      securityTx({
        type: "security_transfer_inbound",
        externalId: "sti",
        amount: { amount: "500.00", commodity: "EUR" },
        fees: "2.00",
        taxes: "1.00",
      }),
      securityTx({
        type: "security_transfer_outbound",
        externalId: "sto",
        amount: { amount: "-500.00", commodity: "EUR" },
        fees: "2.00",
        taxes: "1.00",
      }),
      cashMovement(),
      cashMovement({ type: "withdrawal", amount: { amount: "-300.00", commodity: "EUR" } }),
      cashMovement({ type: "transfer_in", amount: { amount: "10.00", commodity: "USD" } }),
      cashMovement({ type: "transfer_out", amount: { amount: "-10.00", commodity: "USD" } }),
      cashMovement({ type: "interest", amount: { amount: "1.23", commodity: "EUR" } }),
      cashMovement({ type: "interest_charge", amount: { amount: "-0.50", commodity: "EUR" } }),
      cashMovement({ type: "fee", amount: { amount: "-4.90", commodity: "EUR" } }),
      cashMovement({ type: "fee_refund", amount: { amount: "4.90", commodity: "EUR" } }),
      cashMovement({ type: "tax", amount: { amount: "-20.00", commodity: "EUR" } }),
      cashMovement({ type: "tax_refund", amount: { amount: "20.00", commodity: "EUR" } }),
    ];
    for (const event of events) {
      const tx = buildPortfolioDraftTransaction(event, env);
      expect(tx.reviewState).toBe("draft");
      expect(tx.sourceEventExternalId).toBe(event.externalId);
      expect(tx.bookedOn).toBe(event.date);
      const balance = validateBalancedTransaction(tx.postings);
      expect(balance.balanced, `${event.type}: ${balance.errors.join("; ")}`).toBe(true);
      expect(tx.postings.every((p) => p.transactionId === tx.id)).toBe(true);
    }
    // The sweep is exhaustive: every declared event type has a recipe under test.
    expect(new Set(events.map((e) => e.type))).toEqual(
      new Set([...SECURITY_TRANSACTION_TYPES, ...CASH_MOVEMENT_TYPES]),
    );
  });

  it("splits a buy into net cash, cost, and an explicit fee leg", () => {
    const tx = buildPortfolioDraftTransaction(securityTx(), env);
    const a = DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS;
    expect(amountsFor(tx, a.brokerCash)).toEqual([{ amount: "-1005.00", commodity: "EUR" }]);
    expect(amountsFor(tx, a.brokerSecurities)).toEqual([{ amount: "1000.00", commodity: "EUR" }]);
    expect(amountsFor(tx, a.tradeCosts)).toEqual([{ amount: "5.00", commodity: "EUR" }]);
    expect(amountsFor(tx, a.taxesWithheld)).toEqual([]);
  });

  it("books a dividend with withholding as gross income, tax leg, and net cash", () => {
    const tx = buildPortfolioDraftTransaction(
      securityTx({
        type: "dividend",
        amount: { amount: "78.70", commodity: "EUR" },
        fees: "0",
        taxes: "13.89",
      }),
      env,
    );
    const a = DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS;
    expect(amountsFor(tx, a.dividends)).toEqual([{ amount: "-92.59", commodity: "EUR" }]);
    expect(amountsFor(tx, a.taxesWithheld)).toEqual([{ amount: "13.89", commodity: "EUR" }]);
    expect(amountsFor(tx, a.brokerCash)).toEqual([{ amount: "78.70", commodity: "EUR" }]);
    expect(tx.postings).toHaveLength(3);
  });

  it("keeps a foreign-currency gross dividend in its own commodity via a conversion pair", () => {
    const tx = buildPortfolioDraftTransaction(
      securityTx({
        type: "dividend",
        amount: { amount: "78.70", commodity: "EUR" },
        gross: { amount: "100.00", commodity: "USD" },
        exchangeRate: "1.08",
        fees: "0",
        taxes: "13.89",
      }),
      env,
    );
    const a = DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS;
    expect(amountsFor(tx, a.dividends)).toEqual([{ amount: "-100.00", commodity: "USD" }]);
    expect(amountsFor(tx, a.currencyConversion)).toEqual([
      { amount: "100.00", commodity: "USD" },
      { amount: "-92.59", commodity: "EUR" },
    ]);
    const balance = validateBalancedTransaction(tx.postings);
    expect(balance.balanced).toBe(true);
    expect(balance.totalsByCommodity).toEqual({ EUR: "0.00", USD: "0.00" });
  });

  it("parks sale proceeds in disposal suspense instead of guessing a cost basis", () => {
    const tx = buildPortfolioDraftTransaction(
      securityTx({
        type: "sell",
        amount: { amount: "995.00", commodity: "EUR" },
        fees: "5.00",
        taxes: "0",
      }),
      env,
    );
    const a = DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS;
    expect(amountsFor(tx, a.disposalSuspense)).toEqual([{ amount: "-1000.00", commodity: "EUR" }]);
    // The position is left untouched until the user allocates proceeds.
    expect(amountsFor(tx, a.brokerSecurities)).toEqual([]);
    const memo = tx.postings.find((p) => p.account === a.disposalSuspense)?.memo ?? "";
    expect(memo).toMatch(/cost basis and realized gain\/loss not computed — lot review required/);
  });

  it("parks deposits in the transfer suspense account until matched", () => {
    const tx = buildPortfolioDraftTransaction(cashMovement(), env);
    const a = DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS;
    expect(amountsFor(tx, a.brokerCash)).toEqual([{ amount: "2000.00", commodity: "EUR" }]);
    expect(amountsFor(tx, a.transferSuspense)).toEqual([{ amount: "-2000.00", commodity: "EUR" }]);
  });

  it("honors configured account paths", () => {
    const accounts: PortfolioLedgerAccounts = {
      ...DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS,
      tradeCosts: "Expenses:Depot:Ordergebuehren",
      brokerCash: "Assets:Broker:Demo:Cash",
    };
    const tx = buildPortfolioDraftTransaction(securityTx(), { ...env, accounts });
    expect(amountsFor(tx, "Expenses:Depot:Ordergebuehren")).toHaveLength(1);
    expect(amountsFor(tx, "Assets:Broker:Demo:Cash")).toHaveLength(1);
    expect(amountsFor(tx, DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS.tradeCosts)).toHaveLength(0);
  });

  it("keeps period fees and trade fees in separate configurable accounts", () => {
    const a = DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS;
    const trade = buildPortfolioDraftTransaction(securityTx(), env);
    expect(amountsFor(trade, a.tradeCosts)).toEqual([{ amount: "5.00", commodity: "EUR" }]);
    expect(amountsFor(trade, a.fees)).toEqual([]);

    const income = buildPortfolioDraftTransaction(
      securityTx({
        type: "dividend",
        amount: { amount: "77.20", commodity: "EUR" },
        fees: "1.50",
        taxes: "13.89",
      }),
      env,
    );
    expect(amountsFor(income, a.fees)).toEqual([{ amount: "1.50", commodity: "EUR" }]);
    expect(amountsFor(income, a.tradeCosts)).toEqual([]);
  });

  it("rejects negative fees or taxes instead of inventing a leg", () => {
    expect(() => buildPortfolioDraftTransaction(securityTx({ fees: "-1.00" }), env)).toThrow(
      /negative fees/,
    );
  });

  it("rejects a non-decimal amount instead of emitting a draft", () => {
    expect(() =>
      buildPortfolioDraftTransaction(
        cashMovement({ amount: { amount: "not-a-number", commodity: "EUR" } }),
        env,
      ),
    ).toThrow(/Invalid decimal/);
  });

  it("exposes the balance errors when an invariant is violated", () => {
    const error = new UnbalancedPortfolioDraftError("evt", ["Commodity EUR does not balance"]);
    expect(error.errors).toEqual(["Commodity EUR does not balance"]);
    expect(error.message).toMatch(/evt/);
  });
});

describe("buildPortfolioDraftTransaction leg directions", () => {
  const a = DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS;

  it("books a sell with both fees and taxes: proceeds = net + fees + taxes", () => {
    const tx = buildPortfolioDraftTransaction(
      securityTx({
        type: "sell",
        amount: { amount: "982.50", commodity: "EUR" },
        fees: "5.00",
        taxes: "12.50",
      }),
      env,
    );
    expect(amountsFor(tx, a.brokerCash)).toEqual([{ amount: "982.50", commodity: "EUR" }]);
    expect(amountsFor(tx, a.disposalSuspense)).toEqual([{ amount: "-1000.00", commodity: "EUR" }]);
    expect(amountsFor(tx, a.tradeCosts)).toEqual([{ amount: "5.00", commodity: "EUR" }]);
    expect(amountsFor(tx, a.taxesWithheld)).toEqual([{ amount: "12.50", commodity: "EUR" }]);
    expect(tx.postings).toHaveLength(4);
  });

  it("books a buy with both fees and taxes: cost = |net| - fees - taxes", () => {
    const tx = buildPortfolioDraftTransaction(
      securityTx({
        amount: { amount: "-1010.00", commodity: "EUR" },
        fees: "5.00",
        taxes: "5.00",
      }),
      env,
    );
    expect(amountsFor(tx, a.brokerSecurities)).toEqual([{ amount: "1000.00", commodity: "EUR" }]);
    expect(amountsFor(tx, a.tradeCosts)).toEqual([{ amount: "5.00", commodity: "EUR" }]);
    // Purchase-side taxes are transaction taxes, not income tax withheld.
    expect(amountsFor(tx, a.transactionTaxes)).toEqual([{ amount: "5.00", commodity: "EUR" }]);
    expect(amountsFor(tx, a.taxesWithheld)).toEqual([]);
    expect(tx.postings).toHaveLength(4);
  });

  it("books fees and taxes on a delivery against suspense so no cash is invented", () => {
    const tx = buildPortfolioDraftTransaction(
      securityTx({
        type: "delivery_inbound",
        amount: { amount: "500.00", commodity: "EUR" },
        fees: "2.00",
        taxes: "1.00",
      }),
      env,
    );
    expect(amountsFor(tx, a.brokerSecurities)).toEqual([{ amount: "500.00", commodity: "EUR" }]);
    expect(amountsFor(tx, a.tradeCosts)).toEqual([{ amount: "2.00", commodity: "EUR" }]);
    expect(amountsFor(tx, a.taxesWithheld)).toEqual([{ amount: "1.00", commodity: "EUR" }]);
    expect(amountsFor(tx, a.transferSuspense)).toEqual([{ amount: "-503.00", commodity: "EUR" }]);
    expect(amountsFor(tx, a.brokerCash)).toEqual([]);
  });

  it("books a position transfer between securities accounts like a delivery", () => {
    for (const [type, amount, expectedSuspense] of [
      ["security_transfer_inbound", "500.00", "-500.00"],
      ["security_transfer_outbound", "-500.00", "500.00"],
    ] as const) {
      const tx = buildPortfolioDraftTransaction(
        securityTx({ type, amount: { amount, commodity: "EUR" }, fees: "0" }),
        env,
      );
      expect(amountsFor(tx, a.brokerSecurities)).toEqual([{ amount, commodity: "EUR" }]);
      expect(amountsFor(tx, a.transferSuspense)).toEqual([
        { amount: expectedSuspense, commodity: "EUR" },
      ]);
      expect(amountsFor(tx, a.brokerCash)).toEqual([]);
      expect(tx.postings.find((p) => p.account === a.transferSuspense)?.memo).toMatch(
        /position transfer counterpart/,
      );
    }
  });

  it("omits zero fee and tax legs entirely", () => {
    const tx = buildPortfolioDraftTransaction(
      securityTx({
        type: "dividend",
        amount: { amount: "50.00", commodity: "EUR" },
        fees: "0.00",
        taxes: "0",
      }),
      env,
    );
    expect(tx.postings).toHaveLength(2);
    expect(amountsFor(tx, a.dividends)).toEqual([{ amount: "-50.00", commodity: "EUR" }]);
    expect(amountsFor(tx, a.fees)).toEqual([]);
    expect(amountsFor(tx, a.taxesWithheld)).toEqual([]);
  });

  it("books a foreign dividend with fees: the EUR conversion leg carries net + fees + taxes", () => {
    const tx = buildPortfolioDraftTransaction(
      securityTx({
        type: "dividend",
        amount: { amount: "78.70", commodity: "EUR" },
        gross: { amount: "100.00", commodity: "USD" },
        exchangeRate: "1.08",
        fees: "1.50",
        taxes: "13.89",
      }),
      env,
    );
    expect(amountsFor(tx, a.brokerCash)).toEqual([{ amount: "78.70", commodity: "EUR" }]);
    expect(amountsFor(tx, a.fees)).toEqual([{ amount: "1.50", commodity: "EUR" }]);
    expect(amountsFor(tx, a.taxesWithheld)).toEqual([{ amount: "13.89", commodity: "EUR" }]);
    expect(amountsFor(tx, a.dividends)).toEqual([{ amount: "-100.00", commodity: "USD" }]);
    expect(amountsFor(tx, a.currencyConversion)).toEqual([
      { amount: "100.00", commodity: "USD" },
      { amount: "-94.09", commodity: "EUR" },
    ]);
    expect(tx.postings).toHaveLength(6);
    const memos = tx.postings
      .filter((p) => p.account === a.currencyConversion)
      .map((p) => p.memo ?? "");
    expect(memos).toEqual(["conversion", "conversion @ 1.08"]);
    expect(validateBalancedTransaction(tx.postings).totalsByCommodity).toEqual({
      EUR: "0.00",
      USD: "0.00",
    });
  });

  it("marks the conversion memo when no exchange rate was reported", () => {
    const tx = buildPortfolioDraftTransaction(
      securityTx({
        type: "dividend",
        amount: { amount: "90.00", commodity: "EUR" },
        gross: { amount: "100.00", commodity: "USD" },
        exchangeRate: undefined,
        fees: "0",
        taxes: "0",
      }),
      env,
    );
    const eurConversion = tx.postings.find(
      (p) => p.account === a.currencyConversion && p.amount.commodity === "EUR",
    );
    expect(eurConversion?.memo).toBe("conversion @ unknown rate");
    expect(eurConversion?.amount.amount).toBe("-90.00");
  });

  it("books a same-currency gross dividend without any conversion legs", () => {
    const tx = buildPortfolioDraftTransaction(
      securityTx({
        type: "dividend",
        amount: { amount: "78.70", commodity: "EUR" },
        gross: { amount: "92.59", commodity: "EUR" },
        fees: "0",
        taxes: "13.89",
      }),
      env,
    );
    expect(amountsFor(tx, a.currencyConversion)).toEqual([]);
    expect(amountsFor(tx, a.dividends)).toEqual([{ amount: "-92.59", commodity: "EUR" }]);
  });

  it("books deliveries against securities and the transfer suspense account", () => {
    const inbound = buildPortfolioDraftTransaction(
      securityTx({
        type: "delivery_inbound",
        amount: { amount: "500.00", commodity: "EUR" },
        fees: "0",
        shares: "5",
      }),
      env,
    );
    expect(amountsFor(inbound, a.brokerSecurities)).toEqual([
      { amount: "500.00", commodity: "EUR" },
    ]);
    expect(amountsFor(inbound, a.transferSuspense)).toEqual([
      { amount: "-500.00", commodity: "EUR" },
    ]);
    expect(amountsFor(inbound, a.brokerCash)).toEqual([]);
    expect(inbound.postings.map((p) => p.memo)).toEqual([
      "5 shares",
      "delivery counterpart — review required",
    ]);

    const outbound = buildPortfolioDraftTransaction(
      securityTx({
        type: "delivery_outbound",
        amount: { amount: "-500.00", commodity: "EUR" },
        fees: "0",
        shares: undefined,
      }),
      env,
    );
    // An outbound delivery leaves at a user-reported value with no lot basis,
    // so — like a sale — it goes to disposal suspense, not against the position.
    expect(amountsFor(outbound, a.brokerSecurities)).toEqual([]);
    expect(amountsFor(outbound, a.disposalSuspense)).toEqual([
      { amount: "-500.00", commodity: "EUR" },
    ]);
    expect(amountsFor(outbound, a.transferSuspense)).toEqual([
      { amount: "500.00", commodity: "EUR" },
    ]);
    expect(outbound.postings[0]?.memo).toMatch(/outbound delivery at reported value/);
  });

  it("rejects an amount whose sign contradicts the event's cash direction", () => {
    expect(() =>
      buildPortfolioDraftTransaction(
        securityTx({ type: "buy", amount: { amount: "1005.00", commodity: "EUR" } }),
        env,
      ),
    ).toThrow(/is an outflow/);
    expect(() =>
      buildPortfolioDraftTransaction(
        cashMovement({ type: "deposit", amount: { amount: "-1.00", commodity: "EUR" } }),
        env,
      ),
    ).toThrow(/is an inflow/);
    // Zero is direction-neutral.
    expect(() =>
      buildPortfolioDraftTransaction(
        cashMovement({ type: "fee", amount: { amount: "0.00", commodity: "EUR" } }),
        env,
      ),
    ).not.toThrow();
  });

  it("rejects a buy whose fees and taxes exceed the net amount", () => {
    expect(() =>
      buildPortfolioDraftTransaction(
        securityTx({ amount: { amount: "-4.00", commodity: "EUR" }, fees: "5.00" }),
        env,
      ),
    ).toThrow(/negative acquisition cost/);
  });

  it("uses fallback memos when shares are not reported", () => {
    const buy = buildPortfolioDraftTransaction(securityTx({ shares: undefined }), env);
    expect(buy.postings.find((p) => p.account === a.brokerSecurities)?.memo).toBe("acquisition");
    const sell = buildPortfolioDraftTransaction(
      securityTx({
        type: "sell",
        amount: { amount: "995.00", commodity: "EUR" },
        shares: undefined,
      }),
      env,
    );
    expect(sell.postings.find((p) => p.account === a.disposalSuspense)?.memo).toBe(
      "disposal proceeds; cost basis and realized gain/loss not computed — lot review required",
    );
    const withShares = buildPortfolioDraftTransaction(securityTx({ shares: "10.5" }), env);
    expect(withShares.postings.find((p) => p.account === a.brokerSecurities)?.memo).toBe(
      "10.5 shares",
    );
  });

  it("credits income accounts (negative) and debits expense accounts (positive)", () => {
    const cases: Array<[CashMovement["type"], string, string, string]> = [
      ["interest", "1.23", a.interest, "-1.23"],
      ["interest_charge", "-0.50", a.interestCharges, "0.50"],
      ["fee", "-4.90", a.fees, "4.90"],
      ["fee_refund", "4.90", a.fees, "-4.90"],
      ["tax", "-20.00", a.taxesWithheld, "20.00"],
      ["tax_refund", "20.00", a.taxesWithheld, "-20.00"],
    ];
    for (const [type, net, counterAccount, counterAmount] of cases) {
      const tx = buildPortfolioDraftTransaction(
        cashMovement({ type, amount: { amount: net, commodity: "EUR" } }),
        env,
      );
      expect(tx.postings, type).toHaveLength(2);
      expect(amountsFor(tx, a.brokerCash), type).toEqual([{ amount: net, commodity: "EUR" }]);
      expect(amountsFor(tx, counterAccount), type).toEqual([
        { amount: counterAmount, commodity: "EUR" },
      ]);
      expect(
        tx.postings.every((p) => p.memo === undefined),
        type,
      ).toBe(true);
    }
  });

  it("parks withdrawals and internal transfers in suspense with a matching memo", () => {
    const cases: Array<[CashMovement["type"], string, string, string]> = [
      ["withdrawal", "-300.00", "300.00", "transfer counterpart — match to bank leg"],
      ["transfer_in", "10.00", "-10.00", "internal transfer counterpart — review required"],
      ["transfer_out", "-10.00", "10.00", "internal transfer counterpart — review required"],
    ];
    for (const [type, net, counter, memo] of cases) {
      const tx = buildPortfolioDraftTransaction(
        cashMovement({ type, amount: { amount: net, commodity: "EUR" } }),
        env,
      );
      expect(amountsFor(tx, a.transferSuspense), type).toEqual([
        { amount: counter, commodity: "EUR" },
      ]);
      expect(tx.postings.find((p) => p.account === a.transferSuspense)?.memo, type).toBe(memo);
    }
  });

  it("rejects negative taxes as well as negative fees", () => {
    expect(() =>
      buildPortfolioDraftTransaction(securityTx({ fees: "0", taxes: "-0.01" }), env),
    ).toThrow(/negative taxes/);
  });

  it("assigns a fresh id to each posting, distinct from the transaction id", () => {
    const tx = buildPortfolioDraftTransaction(securityTx(), env);
    const ids = new Set(tx.postings.map((p) => p.id));
    expect(ids.size).toBe(tx.postings.length);
    expect(ids.has(tx.id)).toBe(false);
    expect(tx.workspaceId).toBe("ws_1");
    expect(tx.createdAt).toBe(env.createdAt);
  });
});

describe("buildPortfolioDraftTransaction position transfers with charges", () => {
  const a = DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS;

  it("books fees and taxes on an inbound position transfer against suspense", () => {
    const tx = buildPortfolioDraftTransaction(
      securityTx({
        type: "security_transfer_inbound",
        amount: { amount: "500.00", commodity: "EUR" },
        fees: "2.00",
        taxes: "1.00",
        shares: "5",
      }),
      env,
    );
    expect(amountsFor(tx, a.brokerSecurities)).toEqual([{ amount: "500.00", commodity: "EUR" }]);
    expect(amountsFor(tx, a.tradeCosts)).toEqual([{ amount: "2.00", commodity: "EUR" }]);
    expect(amountsFor(tx, a.taxesWithheld)).toEqual([{ amount: "1.00", commodity: "EUR" }]);
    expect(amountsFor(tx, a.transactionTaxes)).toEqual([]);
    expect(amountsFor(tx, a.transferSuspense)).toEqual([{ amount: "-503.00", commodity: "EUR" }]);
    expect(amountsFor(tx, a.brokerCash)).toEqual([]);
    expect(tx.postings).toHaveLength(4);
    expect(tx.postings.map((p) => p.memo)).toEqual([
      "5 shares",
      "trade fees",
      "taxes withheld by broker",
      "position transfer counterpart — review required",
    ]);
    expect(validateBalancedTransaction(tx.postings).totalsByCommodity).toEqual({ EUR: "0.00" });
  });

  it("books fees and taxes on an outbound position transfer against suspense", () => {
    const tx = buildPortfolioDraftTransaction(
      securityTx({
        type: "security_transfer_outbound",
        amount: { amount: "-500.00", commodity: "EUR" },
        fees: "2.00",
        taxes: "1.00",
        shares: undefined,
      }),
      env,
    );
    expect(amountsFor(tx, a.brokerSecurities)).toEqual([{ amount: "-500.00", commodity: "EUR" }]);
    expect(amountsFor(tx, a.tradeCosts)).toEqual([{ amount: "2.00", commodity: "EUR" }]);
    expect(amountsFor(tx, a.taxesWithheld)).toEqual([{ amount: "1.00", commodity: "EUR" }]);
    // Counterpart = -(net + fees + taxes) = -(-500 + 2 + 1) = 497.
    expect(amountsFor(tx, a.transferSuspense)).toEqual([{ amount: "497.00", commodity: "EUR" }]);
    expect(amountsFor(tx, a.brokerCash)).toEqual([]);
    expect(tx.postings[0]?.memo).toBe("position transfer");
    expect(validateBalancedTransaction(tx.postings).balanced).toBe(true);
  });

  it("describes position transfers with spaced type words", () => {
    const tx = buildPortfolioDraftTransaction(
      securityTx({
        type: "security_transfer_inbound",
        amount: { amount: "500.00", commodity: "EUR" },
        fees: "0",
      }),
      env,
    );
    expect(tx.description).toBe("security transfer inbound Synthetic World ETF (XS0000000001)");
  });
});

describe("buildPortfolioDraftTransaction tax leg routing", () => {
  const a = DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS;

  it("routes purchase taxes to transaction taxes and every other security tax to withheld", () => {
    const cases: Array<[SecurityTransaction["type"], string]> = [
      ["buy", "-101.00"],
      ["sell", "99.00"],
      ["dividend", "9.00"],
      ["delivery_inbound", "100.00"],
      ["delivery_outbound", "-100.00"],
      ["security_transfer_inbound", "100.00"],
      ["security_transfer_outbound", "-100.00"],
    ];
    expect(new Set(cases.map(([type]) => type))).toEqual(new Set(SECURITY_TRANSACTION_TYPES));
    for (const [type, net] of cases) {
      const tx = buildPortfolioDraftTransaction(
        securityTx({ type, amount: { amount: net, commodity: "EUR" }, fees: "0", taxes: "1.00" }),
        env,
      );
      const taxLeg = { amount: "1.00", commodity: "EUR" };
      if (type === "buy") {
        expect(amountsFor(tx, a.transactionTaxes), type).toEqual([taxLeg]);
        expect(amountsFor(tx, a.taxesWithheld), type).toEqual([]);
        expect(tx.postings.find((p) => p.account === a.transactionTaxes)?.memo).toBe(
          "transaction taxes",
        );
      } else {
        expect(amountsFor(tx, a.taxesWithheld), type).toEqual([taxLeg]);
        expect(amountsFor(tx, a.transactionTaxes), type).toEqual([]);
        expect(tx.postings.find((p) => p.account === a.taxesWithheld)?.memo).toBe(
          "taxes withheld by broker",
        );
      }
      expect(validateBalancedTransaction(tx.postings).balanced, type).toBe(true);
    }
  });
});

describe("buildPortfolioDraftTransaction description", () => {
  it("labels the security by name and ISIN and appends the note", () => {
    expect(buildPortfolioDraftTransaction(securityTx(), env).description).toBe(
      "buy Synthetic World ETF (XS0000000001)",
    );
    expect(
      buildPortfolioDraftTransaction(securityTx({ note: "Sparplan März" }), env).description,
    ).toBe("buy Synthetic World ETF (XS0000000001) — Sparplan März");
    expect(buildPortfolioDraftTransaction(securityTx({ note: "" }), env).description).toBe(
      "buy Synthetic World ETF (XS0000000001)",
    );
  });

  it("falls back through name, ticker, WKN, and ISIN for the label", () => {
    const label = (security: SecurityTransaction["security"]) =>
      buildPortfolioDraftTransaction(securityTx({ security }), env).description;
    expect(label({ isin: undefined, wkn: undefined, ticker: undefined, name: "Only Name" })).toBe(
      "buy Only Name",
    );
    expect(label({ isin: undefined, wkn: "TEST01", ticker: "TST", name: undefined })).toBe(
      "buy TST",
    );
    expect(label({ isin: undefined, wkn: "TEST01", ticker: undefined, name: undefined })).toBe(
      "buy TEST01",
    );
    expect(
      label({ isin: "XS0000000001", wkn: undefined, ticker: undefined, name: undefined }),
    ).toBe("buy XS0000000001");
  });

  it("spells multi-word event types and omits the label for plain cash movements", () => {
    expect(
      buildPortfolioDraftTransaction(
        cashMovement({ type: "transfer_in", amount: { amount: "1.00", commodity: "EUR" } }),
        env,
      ).description,
    ).toBe("transfer in");
    expect(
      buildPortfolioDraftTransaction(
        cashMovement({
          type: "fee",
          amount: { amount: "-1.00", commodity: "EUR" },
          security: SECURITY,
          note: "Depotgebühr",
        }),
        env,
      ).description,
    ).toBe("fee Synthetic World ETF (XS0000000001) — Depotgebühr");
  });
});

describe("buildPortfolioDraftTransaction outbound delivery with charges", () => {
  const a = DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS;

  it("parks the reported value in disposal suspense, books charges, and offsets all in transfer suspense", () => {
    const tx = buildPortfolioDraftTransaction(
      securityTx({
        type: "delivery_outbound",
        amount: { amount: "-500.00", commodity: "EUR" },
        fees: "2.00",
        taxes: "1.00",
        shares: "5",
      }),
      env,
    );
    expect(amountsFor(tx, a.disposalSuspense)).toEqual([{ amount: "-500.00", commodity: "EUR" }]);
    expect(amountsFor(tx, a.tradeCosts)).toEqual([{ amount: "2.00", commodity: "EUR" }]);
    expect(amountsFor(tx, a.taxesWithheld)).toEqual([{ amount: "1.00", commodity: "EUR" }]);
    // Counterpart = -(net + fees + taxes) = -(-500 + 2 + 1) = 497.
    expect(amountsFor(tx, a.transferSuspense)).toEqual([{ amount: "497.00", commodity: "EUR" }]);
    // The position is not credited: without lots the cost basis is unknown.
    expect(amountsFor(tx, a.brokerSecurities)).toEqual([]);
    expect(amountsFor(tx, a.brokerCash)).toEqual([]);
    expect(tx.postings.map((p) => p.memo)).toEqual([
      "5 shares at reported value; cost basis not computed — lot review required",
      "trade fees",
      "taxes withheld by broker",
      "delivery counterpart — review required",
    ]);
    expect(validateBalancedTransaction(tx.postings).balanced).toBe(true);
  });
});

describe("buildPortfolioDraftTransaction direction guard", () => {
  function eventOf(type: PortfolioEvent["type"], amount: string): PortfolioEvent {
    const money = { amount, commodity: "EUR" };
    return (SECURITY_TRANSACTION_TYPES as readonly string[]).includes(type)
      ? securityTx({
          type: type as SecurityTransaction["type"],
          externalId: `evt_${type}`,
          amount: money,
          fees: "0",
          taxes: "0",
        })
      : cashMovement({
          type: type as CashMovement["type"],
          externalId: `evt_${type}`,
          amount: money,
        });
  }

  const allTypes: ReadonlyArray<PortfolioEvent["type"]> = [
    ...SECURITY_TRANSACTION_TYPES,
    ...CASH_MOVEMENT_TYPES,
  ];

  it("rejects a wrong-signed amount and accepts the correct sign for every event type", () => {
    for (const type of allTypes) {
      const outflow = cashDirectionFor(type) === "outflow";
      const correct = outflow ? "-100.00" : "100.00";
      const wrong = outflow ? "100.00" : "-100.00";
      expect(() => buildPortfolioDraftTransaction(eventOf(type, wrong), env), type).toThrow(
        outflow ? /is an outflow/ : /is an inflow/,
      );
      const tx = buildPortfolioDraftTransaction(eventOf(type, correct), env);
      expect(validateBalancedTransaction(tx.postings).balanced, type).toBe(true);
    }
  });

  it("treats a zero amount as direction-neutral for every event type", () => {
    for (const type of allTypes) {
      expect(() => buildPortfolioDraftTransaction(eventOf(type, "0.00"), env), type).not.toThrow();
    }
  });

  it("classifies exactly the cash-leaving types as outflows", () => {
    const outflows = allTypes.filter((type) => cashDirectionFor(type) === "outflow");
    expect(outflows).toEqual([
      "buy",
      "delivery_outbound",
      "security_transfer_outbound",
      "withdrawal",
      "transfer_out",
      "interest_charge",
      "fee",
      "tax",
    ]);
  });
});

describe("buildPortfolioDraftTransaction acquisition cost guard", () => {
  it("rejects a buy whose fees and taxes together exceed the net even when each alone does not", () => {
    expect(() =>
      buildPortfolioDraftTransaction(
        securityTx({ amount: { amount: "-10.00", commodity: "EUR" }, fees: "6.00", taxes: "5.00" }),
        env,
      ),
    ).toThrow(/negative acquisition cost/);
    // Fees and taxes that exactly consume the net leave a zero-cost position leg but are allowed.
    const tx = buildPortfolioDraftTransaction(
      securityTx({ amount: { amount: "-10.00", commodity: "EUR" }, fees: "6.00", taxes: "4.00" }),
      env,
    );
    expect(amountsFor(tx, DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS.brokerSecurities)).toEqual([
      { amount: "0.00", commodity: "EUR" },
    ]);
    expect(validateBalancedTransaction(tx.postings).balanced).toBe(true);
  });
});
