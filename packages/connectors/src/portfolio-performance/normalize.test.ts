import { buildPortfolioDraftTransaction, validateBalancedTransaction } from "@sona/core";
import { describe, expect, it } from "vitest";
import { PP_DUPLICATE_ROWS_CSV, PP_HOLDINGS_DE_CSV, PP_TRANSACTIONS_DE_CSV } from "./fixtures.js";
import {
  normalizePortfolioPerformanceHolding,
  normalizePortfolioPerformanceRow,
  normalizePortfolioPerformanceRows,
} from "./normalize.js";
import { parsePortfolioPerformanceCsv, parsePortfolioPerformanceHoldingsCsv } from "./parse.js";
import type { PpParsedRow } from "./types.js";

function req<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("missing fixture element");
  }
  return value;
}

function rowsOf(csv: string): PpParsedRow[] {
  const parsed = parsePortfolioPerformanceCsv(csv);
  expect(parsed.errors).toEqual([]);
  return parsed.rows;
}

describe("normalizePortfolioPerformanceRow", () => {
  const rows = rowsOf(PP_TRANSACTIONS_DE_CSV);

  it("signs amounts by event direction and keeps the security reference", () => {
    const buy = normalizePortfolioPerformanceRow(req(rows[1]), { occurrence: 0 });
    expect(buy.kind).toBe("security_transaction");
    expect(buy.amount).toEqual({ amount: "-1005.00", commodity: "EUR" });
    expect(buy.brokerAccountExternalId).toBe("Depot A");
    if (buy.kind === "security_transaction") {
      expect(buy.security.isin).toBe("XS0000000001");
      expect(buy.shares).toBe("10");
      expect(buy.fees).toBe("5.00");
      expect(buy.gross).toBeUndefined();
    }

    const deposit = normalizePortfolioPerformanceRow(req(rows[0]), { occurrence: 0 });
    expect(deposit.kind).toBe("cash_movement");
    expect(deposit.type).toBe("deposit");
    expect(deposit.amount.amount).toBe("2000.00");
    expect(deposit.brokerAccountExternalId).toBe("Verrechnungskonto");

    const withdrawal = normalizePortfolioPerformanceRow(req(rows[5]), { occurrence: 0 });
    expect(withdrawal.amount.amount).toBe("-300.00");
  });

  it("keeps a foreign-currency gross amount only when the currency differs", () => {
    const dividend = normalizePortfolioPerformanceRow(req(rows[2]), { occurrence: 0 });
    if (dividend.kind !== "security_transaction") {
      throw new Error("expected security transaction");
    }
    expect(dividend.gross).toEqual({ amount: "100.00", commodity: "USD" });
    expect(dividend.exchangeRate).toBe("1.08");
    expect(dividend.taxes).toBe("13.89");

    const sameCurrency = normalizePortfolioPerformanceRow(
      { ...req(rows[2]), grossCurrency: "EUR" },
      { occurrence: 0 },
    );
    if (sameCurrency.kind !== "security_transaction") {
      throw new Error("expected security transaction");
    }
    expect(sameCurrency.gross).toBeUndefined();
  });

  it("derives a stable external id from row content, not position or account", () => {
    const buy = req(rows[1]);
    const a = normalizePortfolioPerformanceRow(buy, { occurrence: 0 });
    const b = normalizePortfolioPerformanceRow(
      { ...buy, line: 99, cashAccount: "Other", securitiesAccount: undefined, columns: {} },
      { occurrence: 0 },
    );
    expect(a.externalId).toBe(b.externalId);
    expect(a.externalId.startsWith("pp_")).toBe(true);

    const changed = normalizePortfolioPerformanceRow(
      { ...buy, value: "1005.01" },
      { occurrence: 0 },
    );
    expect(changed.externalId).not.toBe(a.externalId);
  });

  it("stores the verbatim row and occurrence as the raw payload", () => {
    const fee = normalizePortfolioPerformanceRow(req(rows[3]), { occurrence: 2 });
    expect(fee.raw).toEqual({
      format: "portfolio_performance_csv",
      occurrence: 2,
      columns: req(rows[3]).columns,
    });
  });

  it("falls back to the default broker account when no account column exists", () => {
    const rowsWithoutAccounts = rowsOf(
      "Datum;Typ;Wert;Buchungswährung\n01.01.2026;Einlage;1,00;EUR",
    );
    const event = normalizePortfolioPerformanceRow(req(rowsWithoutAccounts[0]), { occurrence: 0 });
    expect(event.brokerAccountExternalId).toBe("default");
    const named = normalizePortfolioPerformanceRow(req(rowsWithoutAccounts[0]), {
      occurrence: 0,
      defaultAccountExternalId: "Broker X",
    });
    expect(named.brokerAccountExternalId).toBe("Broker X");
  });

  it("produces events that build balanced drafts end to end", () => {
    let n = 0;
    for (const event of normalizePortfolioPerformanceRows(rows)) {
      const tx = buildPortfolioDraftTransaction(event, {
        workspaceId: "ws_1",
        ids: () => `id_${n++}`,
        createdAt: "2026-08-01T00:00:00Z",
      });
      expect(validateBalancedTransaction(tx.postings).balanced).toBe(true);
      expect(tx.reviewState).toBe("draft");
    }
  });
});

describe("normalizePortfolioPerformanceRows", () => {
  it("keeps identical rows apart with an occurrence suffix", () => {
    const events = normalizePortfolioPerformanceRows(rowsOf(PP_DUPLICATE_ROWS_CSV));
    expect(events).toHaveLength(2);
    const [a, b] = events;
    expect(req(a).externalId).not.toBe(req(b).externalId);
    expect(req(a).externalId.replace(/_\d+$/, "")).toBe(req(b).externalId.replace(/_\d+$/, ""));
    expect(req(a).externalId.endsWith("_0")).toBe(true);
    expect(req(b).externalId.endsWith("_1")).toBe(true);
  });
});

describe("normalizePortfolioPerformanceHolding", () => {
  it("creates a frozen informational snapshot linked to its raw record", () => {
    const parsed = parsePortfolioPerformanceHoldingsCsv(PP_HOLDINGS_DE_CSV);
    const snapshot = normalizePortfolioPerformanceHolding(req(parsed.rows[0]), {
      id: "val_1",
      workspaceId: "ws_1",
      sourceId: "src_1",
      asOf: "2026-06-30",
      rawRecordId: "raw_1",
      createdAt: "2026-07-01T00:00:00Z",
    });
    expect(snapshot).toMatchObject({
      brokerAccountExternalId: "Depot A",
      asOf: "2026-06-30",
      shares: "10",
      marketValue: { amount: "1105.00", commodity: "EUR" },
      valuationSource: "portfolio_performance",
      rawRecordId: "raw_1",
    });
    expect(snapshot.security?.isin).toBe("XS0000000001");
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("falls back to the configured default account, else leaves the account undefined", () => {
    const parsed = parsePortfolioPerformanceHoldingsCsv("Name;Marktwert;Währung\nFund;1,00;EUR");
    const base = {
      id: "val_x",
      workspaceId: "ws_1",
      sourceId: "src_1",
      asOf: "2026-06-30",
      rawRecordId: undefined,
      createdAt: "2026-07-01T00:00:00Z",
    };
    const holding = req(parsed.rows[0]);
    expect(normalizePortfolioPerformanceHolding(holding, base).brokerAccountExternalId).toBe(
      undefined,
    );
    expect(
      normalizePortfolioPerformanceHolding(holding, { ...base, defaultAccountExternalId: "Depot" })
        .brokerAccountExternalId,
    ).toBe("Depot");
  });
});

describe("normalizePortfolioPerformanceRow cash movements", () => {
  const header = "Datum;Typ;Wert;Buchungswährung;ISIN;Wertpapiername;Notiz;Konto;Depot";

  it("keeps a security reference on transfer and fee rows that name one", () => {
    const rows = rowsOf(
      [
        header,
        "01.02.2026;Umbuchung (Eingang);10,00;EUR;XS0000000001;Synthetic World ETF;;Konto A;Depot A",
        "01.02.2026;Umbuchung (Ausgang);-10,00;EUR;;Synthetic World ETF;;Konto A;",
        "01.02.2026;Gebühren;-1,00;EUR;XS0000000001;;Depotgebühr;;Depot A",
      ].join("\n"),
    );
    const [transferIn, transferOut, fee] = normalizePortfolioPerformanceRows(rows);
    // An "Umbuchung" that names a security moves a position, not cash, so it
    // becomes a security transfer on the securities account.
    expect(req(transferIn)).toMatchObject({
      kind: "security_transaction",
      type: "security_transfer_inbound",
      amount: { amount: "10.00", commodity: "EUR" },
      brokerAccountExternalId: "Depot A",
      security: { isin: "XS0000000001", name: "Synthetic World ETF" },
    });
    expect(req(transferOut)).toMatchObject({
      kind: "security_transaction",
      type: "security_transfer_outbound",
      amount: { amount: "-10.00", commodity: "EUR" },
      security: { isin: undefined, name: "Synthetic World ETF" },
    });
    expect(req(fee)).toMatchObject({
      type: "fee",
      amount: { amount: "-1.00", commodity: "EUR" },
      brokerAccountExternalId: "Depot A",
      note: "Depotgebühr",
      security: { isin: "XS0000000001" },
    });
  });

  it("leaves security undefined when a cash row carries no identifier", () => {
    const rows = rowsOf([header, "01.02.2026;Zinsen;1,23;EUR;;;;Konto A;"].join("\n"));
    const interest = normalizePortfolioPerformanceRow(req(rows[0]), { occurrence: 0 });
    expect(interest.kind).toBe("cash_movement");
    expect(interest.security).toBeUndefined();
    expect(interest.amount.amount).toBe("1.23");
  });

  it("signs every cash movement type by its direction", () => {
    const csv = [
      header,
      "01.02.2026;Einlage;1,00;EUR;;;;;",
      "01.02.2026;Entnahme;1,00;EUR;;;;;",
      "01.02.2026;Zinsen;1,00;EUR;;;;;",
      "01.02.2026;Zinsbelastung;1,00;EUR;;;;;",
      "01.02.2026;Gebühren;1,00;EUR;;;;;",
      "01.02.2026;Gebührenerstattung;1,00;EUR;;;;;",
      "01.02.2026;Steuern;1,00;EUR;;;;;",
      "01.02.2026;Steuerrückerstattung;1,00;EUR;;;;;",
    ].join("\n");
    const amounts = normalizePortfolioPerformanceRows(rowsOf(csv)).map((e) => [
      e.type,
      e.amount.amount,
    ]);
    expect(amounts).toEqual([
      ["deposit", "1.00"],
      ["withdrawal", "-1.00"],
      ["interest", "1.00"],
      ["interest_charge", "-1.00"],
      ["fee", "-1.00"],
      ["fee_refund", "1.00"],
      ["tax", "-1.00"],
      ["tax_refund", "1.00"],
    ]);
  });

  it("signs an unsigned outflow value by type", () => {
    const csv = [
      header,
      "01.02.2026;Kauf;1.005,00;EUR;XS0000000001;Synthetic World ETF;;;Depot A",
      "01.02.2026;Kauf;-1.005,00;EUR;XS0000000001;Synthetic World ETF;;;Depot A",
    ].join("\n");
    const [unsigned, signed] = normalizePortfolioPerformanceRows(rowsOf(csv));
    expect(req(unsigned).amount.amount).toBe("-1005.00");
    expect(req(signed).amount.amount).toBe("-1005.00");
  });

  it("rejects a negative value on an inflow type instead of flipping it", () => {
    const csv = [header, "01.02.2026;Einlage;-500,00;EUR;;;;Konto A;"].join("\n");
    const parsed = parsePortfolioPerformanceCsv(csv);
    expect(parsed.rows).toEqual([]);
    expect(parsed.errors).toEqual([
      {
        line: 2,
        message: expect.stringMatching(/negative value "-500,00" on inflow type deposit/),
      },
    ]);
  });

  it("derives different external ids for rows that differ only by type", () => {
    const csv = [
      header,
      "01.02.2026;Einlage;500,00;EUR;;;;Konto A;",
      "01.02.2026;Entnahme;500,00;EUR;;;;Konto A;",
    ].join("\n");
    const [deposit, withdrawal] = normalizePortfolioPerformanceRows(rowsOf(csv));
    expect(req(deposit).externalId).not.toBe(req(withdrawal).externalId);
    expect(req(deposit).externalId.endsWith("_0")).toBe(true);
    expect(req(withdrawal).externalId.endsWith("_0")).toBe(true);
  });

  it("prefers the cash account for cash rows and the securities account for trades", () => {
    const csv = [
      header,
      "01.02.2026;Einlage;1,00;EUR;;;;Konto A;Depot A",
      "01.02.2026;Einlage;2,00;EUR;;;;;Depot A",
      "01.02.2026;Kauf;-1,00;EUR;XS0000000001;;;Konto A;",
    ].join("\n");
    const [both, depotOnly, buyCashOnly] = normalizePortfolioPerformanceRows(rowsOf(csv));
    expect(req(both).brokerAccountExternalId).toBe("Konto A");
    expect(req(depotOnly).brokerAccountExternalId).toBe("Depot A");
    expect(req(buyCashOnly).brokerAccountExternalId).toBe("Konto A");
  });

  it("refuses to normalize a security row that lost its identifier", () => {
    const rows = rowsOf(
      [header, "01.02.2026;Kauf;-1,00;EUR;XS0000000001;;;Konto A;Depot A"].join("\n"),
    );
    const stripped: PpParsedRow = {
      ...req(rows[0]),
      isin: undefined,
      wkn: undefined,
      ticker: undefined,
      securityName: undefined,
    };
    expect(() => normalizePortfolioPerformanceRow(stripped, { occurrence: 0 })).toThrow(
      /buy row on line 2 has no security identifier/,
    );
  });
});
