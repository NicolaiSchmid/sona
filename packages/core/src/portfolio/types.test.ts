import { describe, expect, it } from "vitest";
import {
  BROKER_ACCOUNT_KINDS,
  type BrokerAccountKind,
  CASH_MOVEMENT_TYPES,
  cashDirectionFor,
  createValuationSnapshot,
  isBrokerAccountKind,
  isCashMovementType,
  isSecurityTransactionType,
  isTransferLeg,
  isValuationSource,
  type PortfolioEvent,
  SECURITY_TRANSACTION_TYPES,
  type SecurityTransaction,
  securityKey,
  suggestsForeignWithholding,
  TRANSFER_LEG_TYPES,
  VALUATION_SOURCES,
  type ValuationSource,
} from "./types";

function dividend(overrides: Partial<SecurityTransaction> = {}): SecurityTransaction {
  return {
    kind: "security_transaction",
    type: "dividend",
    externalId: "evt_div",
    brokerAccountExternalId: "depot",
    date: "2026-05-15",
    amount: { amount: "78.70", commodity: "EUR" },
    security: { isin: "DE000TEST0001", wkn: undefined, ticker: undefined, name: "Synthetic AG" },
    shares: "50",
    gross: undefined,
    exchangeRate: undefined,
    fees: "0",
    taxes: "13.89",
    note: undefined,
    raw: {},
    ...overrides,
  };
}

describe("securityKey", () => {
  it("prefers ISIN, then WKN, ticker, and name", () => {
    expect(securityKey({ isin: "xs0000000001", wkn: "W", ticker: "T", name: "N" })).toBe(
      "isin:XS0000000001",
    );
    expect(securityKey({ isin: undefined, wkn: "test01", ticker: "T", name: "N" })).toBe(
      "wkn:TEST01",
    );
    expect(securityKey({ isin: undefined, wkn: undefined, ticker: "tst", name: "N" })).toBe(
      "ticker:TST",
    );
    expect(
      securityKey({ isin: undefined, wkn: undefined, ticker: undefined, name: " Fund " }),
    ).toBe("name:fund");
    expect(
      securityKey({ isin: undefined, wkn: undefined, ticker: undefined, name: undefined }),
    ).toBeUndefined();
  });
});

describe("event type helpers", () => {
  it("classifies literal unions and directions", () => {
    expect(isSecurityTransactionType("buy")).toBe(true);
    expect(isSecurityTransactionType("deposit")).toBe(false);
    expect(isCashMovementType("deposit")).toBe(true);
    expect(isCashMovementType("dividend")).toBe(false);
    expect(cashDirectionFor("buy")).toBe("outflow");
    expect(cashDirectionFor("sell")).toBe("inflow");
    expect(cashDirectionFor("withdrawal")).toBe("outflow");
    expect(cashDirectionFor("fee_refund")).toBe("inflow");
  });

  it("treats only external deposits/withdrawals as transfer legs", () => {
    const base = {
      kind: "cash_movement" as const,
      externalId: "e",
      brokerAccountExternalId: "k",
      date: "2026-01-01",
      amount: { amount: "1", commodity: "EUR" },
      security: undefined,
      note: undefined,
      raw: {},
    };
    expect(isTransferLeg({ ...base, type: "deposit" })).toBe(true);
    expect(isTransferLeg({ ...base, type: "withdrawal" })).toBe(true);
    expect(isTransferLeg({ ...base, type: "fee" })).toBe(false);
    expect(isTransferLeg(dividend())).toBe(false);
  });
});

describe("suggestsForeignWithholding", () => {
  it("is false for a domestic dividend in the booking currency", () => {
    expect(suggestsForeignWithholding(dividend())).toBe(false);
  });

  it("is false when no tax was deducted", () => {
    expect(
      suggestsForeignWithholding(
        dividend({
          taxes: "0",
          security: { isin: "US0000000001", wkn: undefined, ticker: undefined, name: "X" },
        }),
      ),
    ).toBe(false);
  });

  it("suggests foreign withholding for a non-home ISIN or a foreign gross currency", () => {
    expect(
      suggestsForeignWithholding(
        dividend({
          security: { isin: "US0000000001", wkn: undefined, ticker: undefined, name: "X" },
        }),
      ),
    ).toBe(true);
    expect(
      suggestsForeignWithholding(dividend({ gross: { amount: "100.00", commodity: "USD" } })),
    ).toBe(true);
    expect(
      suggestsForeignWithholding(
        dividend({
          security: { isin: "AT0000000001", wkn: undefined, ticker: undefined, name: "X" },
        }),
        "AT",
      ),
    ).toBe(false);
  });

  it("never flags non-dividend events", () => {
    expect(suggestsForeignWithholding(dividend({ type: "sell" }))).toBe(false);
  });
});

describe("createValuationSnapshot", () => {
  it("returns a frozen informational record", () => {
    const snapshot = createValuationSnapshot({
      id: "val_1",
      workspaceId: "ws_1",
      sourceId: "src_1",
      brokerAccountExternalId: "depot",
      security: { isin: "XS0000000001", wkn: undefined, ticker: undefined, name: "ETF" },
      asOf: "2026-06-30",
      shares: "10",
      marketValue: { amount: "1100.00", commodity: "EUR" },
      valuationSource: "portfolio_performance",
      rawRecordId: "raw_1",
      createdAt: "2026-07-01T00:00:00Z",
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.marketValue)).toBe(true);
    expect(Object.isFrozen(snapshot.security)).toBe(true);
    expect(snapshot.marketValue.amount).toBe("1100.00");
  });
});

describe("suggestsForeignWithholding zero taxes", () => {
  it("is false for a foreign dividend whose deducted tax is a zero with decimals", () => {
    const foreign = dividend({
      taxes: "0.00",
      gross: { amount: "100.00", commodity: "USD" },
      security: { isin: "US0000000001", wkn: undefined, ticker: undefined, name: "X" },
    });
    expect(suggestsForeignWithholding(foreign)).toBe(false);
    // The same event with any deducted tax is flagged.
    expect(suggestsForeignWithholding({ ...foreign, taxes: "0.01" })).toBe(true);
  });
});

describe("literal union guards", () => {
  it("narrows broker account kinds to the declared union", () => {
    expect(BROKER_ACCOUNT_KINDS).toEqual(["securities", "cash"]);
    for (const kind of BROKER_ACCOUNT_KINDS) {
      expect(isBrokerAccountKind(kind)).toBe(true);
    }
    expect(isBrokerAccountKind("depot")).toBe(false);
    expect(isBrokerAccountKind("Securities")).toBe(false);
    expect(isBrokerAccountKind("")).toBe(false);
    const value: string = "cash";
    if (isBrokerAccountKind(value)) {
      const narrowed: BrokerAccountKind = value;
      expect(narrowed).toBe("cash");
    } else {
      throw new Error("expected a broker account kind");
    }
  });

  it("narrows valuation sources to the declared union", () => {
    expect(VALUATION_SOURCES).toEqual(["portfolio_performance", "manual"]);
    for (const source of VALUATION_SOURCES) {
      expect(isValuationSource(source)).toBe(true);
    }
    expect(isValuationSource("csv")).toBe(false);
    expect(isValuationSource("Manual")).toBe(false);
    const value: string = "manual";
    if (isValuationSource(value)) {
      const narrowed: ValuationSource = value;
      expect(narrowed).toBe("manual");
    } else {
      throw new Error("expected a valuation source");
    }
  });

  it("classifies position transfers as security transactions with the expected direction", () => {
    expect(isSecurityTransactionType("security_transfer_inbound")).toBe(true);
    expect(isSecurityTransactionType("security_transfer_outbound")).toBe(true);
    expect(isCashMovementType("security_transfer_inbound")).toBe(false);
    expect(isCashMovementType("security_transfer_outbound")).toBe(false);
    expect(cashDirectionFor("security_transfer_inbound")).toBe("inflow");
    expect(cashDirectionFor("security_transfer_outbound")).toBe("outflow");
    // The two unions are disjoint and every member is recognized by exactly one guard.
    for (const type of SECURITY_TRANSACTION_TYPES) {
      expect(isCashMovementType(type), type).toBe(false);
    }
    for (const type of CASH_MOVEMENT_TYPES) {
      expect(isSecurityTransactionType(type), type).toBe(false);
    }
  });

  it("treats only deposits and withdrawals as transfer legs across every event type", () => {
    expect(TRANSFER_LEG_TYPES).toEqual(["deposit", "withdrawal"]);
    const base = {
      externalId: "e",
      brokerAccountExternalId: "k",
      date: "2026-01-01",
      amount: { amount: "1", commodity: "EUR" },
      note: undefined,
      raw: {},
    };
    for (const type of CASH_MOVEMENT_TYPES) {
      const event: PortfolioEvent = { ...base, kind: "cash_movement", type, security: undefined };
      const expected = type === "deposit" || type === "withdrawal";
      expect(isTransferLeg(event), type).toBe(expected);
      if (isTransferLeg(event)) {
        // Narrowing keeps the type literal usable without a cast.
        expect(TRANSFER_LEG_TYPES).toContain(event.type);
      }
    }
    for (const type of SECURITY_TRANSACTION_TYPES) {
      expect(isTransferLeg(dividend({ type })), type).toBe(false);
    }
  });
});
