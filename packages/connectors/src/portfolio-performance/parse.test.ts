import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv.js";
import {
  PP_HOLDINGS_DE_CSV,
  PP_TRANSACTIONS_DE_CSV,
  PP_TRANSACTIONS_EN_CSV,
  PP_TRANSACTIONS_WITH_ERRORS_CSV,
} from "./fixtures.js";
import { PpRowParseError as PpRowParseErrorFromIndex } from "./index.js";
import {
  normalizeToken,
  PpRowParseError,
  parseLocalizedDate,
  parseLocalizedDecimal,
  parsePortfolioPerformanceCsv,
  parsePortfolioPerformanceHoldingsCsv,
} from "./parse.js";

/** Asserts a fixture element exists (keeps tests free of non-null assertions). */
function req<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("missing fixture element");
  }
  return value;
}

describe("parseCsv", () => {
  it("detects the delimiter, strips a BOM, and honors quoted fields", () => {
    const table = parseCsv('﻿a,b,c\r\n1,"x, y","say ""hi"""\n');
    expect(table.delimiter).toBe(",");
    expect(table.header).toEqual(["a", "b", "c"]);
    expect(table.rows).toEqual([{ line: 2, cells: ["1", "x, y", 'say "hi"'] }]);
  });

  it("prefers semicolons for German exports and keeps line numbers", () => {
    const table = parseCsv("a;b\n\n1;2\n3;4");
    expect(table.delimiter).toBe(";");
    expect(table.rows.map((r) => r.line)).toEqual([3, 4]);
  });

  it("rejects an empty file", () => {
    expect(() => parseCsv("")).toThrow(/no header/);
  });
});

describe("normalizeToken", () => {
  it("folds case, diacritics, and punctuation", () => {
    expect(normalizeToken("Buchungswährung")).toBe("buchungswahrung");
    expect(normalizeToken("Umbuchung (Eingang)")).toBe("umbuchungeingang");
    expect(normalizeToken("Ticker-Symbol")).toBe("tickersymbol");
  });
});

describe("parseLocalizedDecimal", () => {
  it("parses German and English thousands/decimal separators exactly", () => {
    expect(parseLocalizedDecimal("1.005,00", "de")).toBe("1005.00");
    expect(parseLocalizedDecimal("-1.234.567,891", "de")).toBe("-1234567.891");
    expect(parseLocalizedDecimal("1,005.00", "en")).toBe("1005.00");
    expect(parseLocalizedDecimal("−5,00", "de")).toBe("-5.00");
    expect(parseLocalizedDecimal("+5.00", "en")).toBe("5.00");
    expect(parseLocalizedDecimal("  ", "de")).toBeUndefined();
    expect(parseLocalizedDecimal(undefined, "de")).toBeUndefined();
  });

  it("rejects non-numeric input instead of coercing", () => {
    expect(() => parseLocalizedDecimal("abc", "de")).toThrow(/invalid de number/);
    expect(() => parseLocalizedDecimal("1,0,0", "de")).toThrow(/invalid/);
  });
});

describe("parseLocalizedDate", () => {
  it("accepts dotted German, ISO, and slashed English dates", () => {
    expect(parseLocalizedDate("02.03.2026", "de")).toBe("2026-03-02");
    expect(parseLocalizedDate("2026-03-02", "de")).toBe("2026-03-02");
    expect(parseLocalizedDate("3/2/2026", "en")).toBe("2026-03-02");
    expect(parseLocalizedDate("02.03.2026 10:15", "de")).toBe("2026-03-02");
  });

  it("rejects non-calendar and ambiguous dates", () => {
    expect(() => parseLocalizedDate("31.02.2026", "de")).toThrow(/invalid calendar date/);
    expect(() => parseLocalizedDate("3/2/2026", "de")).toThrow(/unrecognized date/);
    expect(() => parseLocalizedDate("yesterday", "en")).toThrow(/unrecognized date/);
  });
});

describe("parsePortfolioPerformanceCsv", () => {
  it("parses a German export into typed rows", () => {
    const result = parsePortfolioPerformanceCsv(PP_TRANSACTIONS_DE_CSV);
    expect(result.numberFormat).toBe("de");
    expect(result.errors).toEqual([]);
    expect(result.rows.map((r) => r.type)).toEqual([
      "deposit",
      "buy",
      "dividend",
      "fee",
      "sell",
      "withdrawal",
    ]);

    const buy = req(result.rows[1]);
    expect(buy).toMatchObject({
      line: 3,
      date: "2026-03-02",
      value: "1005.00",
      currency: "EUR",
      fees: "5.00",
      taxes: "0",
      shares: "10",
      isin: "XS0000000001",
      wkn: "TEST01",
      ticker: "TST",
      securityName: "Synthetic World ETF",
      cashAccount: "Verrechnungskonto",
      securitiesAccount: "Depot A",
    });
    expect(buy.columns["Wert"]).toBe("-1.005,00");

    const dividend = req(result.rows[2]);
    expect(dividend.grossAmount).toBe("100.00");
    expect(dividend.grossCurrency).toBe("USD");
    expect(dividend.exchangeRate).toBe("1.08");
    expect(dividend.taxes).toBe("13.89");
  });

  it("parses an English export with comma delimiter and CRLF", () => {
    const result = parsePortfolioPerformanceCsv(PP_TRANSACTIONS_EN_CSV);
    expect(result.numberFormat).toBe("en");
    expect(result.errors).toEqual([]);
    expect(result.rows.map((r) => [r.type, r.value])).toEqual([
      ["deposit", "2000.00"],
      ["buy", "1005.00"],
      ["dividend", "78.70"],
    ]);
  });

  it("reports malformed rows with line numbers and keeps the valid ones", () => {
    const result = parsePortfolioPerformanceCsv(PP_TRANSACTIONS_WITH_ERRORS_CSV);
    expect(result.rows.map((r) => r.type)).toEqual(["deposit", "interest"]);
    expect(result.errors).toEqual([
      { line: 3, message: expect.stringMatching(/unknown transaction type "Sparplan"/) },
      { line: 4, message: expect.stringMatching(/invalid de number "abc"/) },
      { line: 5, message: expect.stringMatching(/no security identifier/) },
      { line: 6, message: expect.stringMatching(/invalid calendar date/) },
    ]);
  });

  it("throws when required columns are missing", () => {
    expect(() => parsePortfolioPerformanceCsv("Datum;Notiz\n01.01.2026;x")).toThrow(
      /missing required column/,
    );
  });

  it("requires a currency unless a default is configured", () => {
    const csv = "Datum;Typ;Wert\n01.01.2026;Einlage;10,00";
    expect(req(parsePortfolioPerformanceCsv(csv).errors[0]).message).toMatch(/missing currency/);
    const withDefault = parsePortfolioPerformanceCsv(csv, { defaultCurrency: "eur" });
    expect(req(withDefault.rows[0]).currency).toBe("EUR");
  });

  it("lets the caller override the inferred number format", () => {
    const csv = "Datum;Typ;Wert;Buchungswährung\n2026-01-01;Einlage;1,000.50;EUR";
    const result = parsePortfolioPerformanceCsv(csv, { numberFormat: "en" });
    expect(req(result.rows[0]).value).toBe("1000.50");
  });
});

describe("parsePortfolioPerformanceHoldingsCsv", () => {
  it("parses positions and reports the malformed row", () => {
    const result = parsePortfolioPerformanceHoldingsCsv(PP_HOLDINGS_DE_CSV);
    expect(result.rows).toHaveLength(2);
    expect(req(result.rows[0])).toMatchObject({
      isin: "XS0000000001",
      shares: "10",
      marketValue: "1105.00",
      currency: "EUR",
      securitiesAccount: "Depot A",
    });
    expect(result.errors).toEqual([
      { line: 4, message: expect.stringMatching(/invalid de number/) },
    ]);
  });

  it("leaves the securities account undefined when the column is absent", () => {
    const result = parsePortfolioPerformanceHoldingsCsv("Name;Marktwert;Währung\nFund;1,00;eur");
    expect(req(result.rows[0]).securitiesAccount).toBeUndefined();
    expect(req(result.rows[0]).currency).toBe("EUR");
    expect(() => parsePortfolioPerformanceHoldingsCsv("Name;Stück\nFund;1")).toThrow(
      /missing required column\(s\): marketValue/,
    );
  });
});

describe("parseCsv edge cases", () => {
  it("pads short rows and keeps a trailing delimiter as an empty cell", () => {
    const table = parseCsv("a;b;c\n1;2\n3;4;5;\n");
    expect(table.rows).toEqual([
      { line: 2, cells: ["1", "2"] },
      { line: 3, cells: ["3", "4", "5", ""] },
    ]);
  });

  it("keeps newlines inside quoted fields and reports the record's first line", () => {
    const table = parseCsv('a;b\n1;"multi\nline"\n2;x');
    expect(table.rows).toEqual([
      { line: 2, cells: ["1", "multi\nline"] },
      { line: 4, cells: ["2", "x"] },
    ]);
  });

  it("handles a file without a trailing newline and CR-only line endings", () => {
    expect(parseCsv("a;b\r1;2\r3;4").rows.map((r) => r.cells)).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(parseCsv("a;b\n1;2").rows).toHaveLength(1);
  });
});

const DE_HEADER = "Datum;Typ;Wert;Buchungswährung;Gebühren;Steuern;Stück;ISIN;Wertpapiername;Notiz";

function deRow(type: string, value: string, security = false): string {
  const isin = security ? "XS0000000001" : "";
  const name = security ? "Synthetic World ETF" : "";
  return `01.02.2026;${type};${value};EUR;;;;${isin};${name};`;
}

describe("parsePortfolioPerformanceCsv type mapping", () => {
  it("maps every German transaction type alias", () => {
    const csv = [
      DE_HEADER,
      deRow("Kauf", "-10,00", true),
      deRow("Verkauf", "10,00", true),
      deRow("Einlieferung", "10,00", true),
      deRow("Auslieferung", "-10,00", true),
      deRow("Dividende", "1,00", true),
      deRow("Zinsen", "1,00"),
      deRow("Zinsbelastung", "-1,00"),
      deRow("Gebühren", "-1,00"),
      deRow("Gebührenerstattung", "1,00"),
      deRow("Steuern", "-1,00"),
      deRow("Steuerrückerstattung", "1,00"),
      deRow("Einlage", "1,00"),
      deRow("Entnahme", "-1,00"),
      deRow("Umbuchung (Eingang)", "1,00"),
      deRow("Umbuchung (Ausgang)", "-1,00"),
    ].join("\n");
    const result = parsePortfolioPerformanceCsv(csv);
    expect(result.errors).toEqual([]);
    expect(result.rows.map((r) => r.type)).toEqual([
      "buy",
      "sell",
      "delivery_inbound",
      "delivery_outbound",
      "dividend",
      "interest",
      "interest_charge",
      "fee",
      "fee_refund",
      "tax",
      "tax_refund",
      "deposit",
      "withdrawal",
      "transfer_in",
      "transfer_out",
    ]);
  });

  it("maps every English transaction type alias", () => {
    const header = "Date,Type,Value,Transaction Currency,ISIN,Security Name";
    const row = (type: string, security = false) =>
      `2026-02-01,${type},1.00,EUR,${security ? "XS0000000001" : ""},${security ? "ETF" : ""}`;
    const csv = [
      header,
      row("Buy", true),
      row("Sell", true),
      row("Delivery (Inbound)", true),
      row("Delivery (Outbound)", true),
      row("Dividend", true),
      row("Interest"),
      row("Interest Charge"),
      row("Fees"),
      row("Fee"),
      row("Fees Refund"),
      row("Fee Refund"),
      row("Taxes"),
      row("Tax"),
      row("Tax Refund"),
      row("Deposit"),
      row("Removal"),
      row("Withdrawal"),
      row("Transfer (Inbound)"),
      row("Transfer (Outbound)"),
    ].join("\n");
    const result = parsePortfolioPerformanceCsv(csv);
    expect(result.numberFormat).toBe("en");
    expect(result.errors).toEqual([]);
    expect(result.rows.map((r) => r.type)).toEqual([
      "buy",
      "sell",
      "delivery_inbound",
      "delivery_outbound",
      "dividend",
      "interest",
      "interest_charge",
      "fee",
      "fee",
      "fee_refund",
      "fee_refund",
      "tax",
      "tax",
      "tax_refund",
      "deposit",
      "withdrawal",
      "withdrawal",
      "transfer_in",
      "transfer_out",
    ]);
  });

  it("requires a security identifier for deliveries, not only buys and sells", () => {
    const result = parsePortfolioPerformanceCsv(
      [DE_HEADER, deRow("Einlieferung", "10,00"), deRow("Auslieferung", "-10,00")].join("\n"),
    );
    expect(result.rows).toEqual([]);
    expect(result.errors.map((e) => e.message)).toEqual([
      expect.stringMatching(/delivery_inbound row has no security identifier/),
      expect.stringMatching(/delivery_outbound row has no security identifier/),
    ]);
  });
});

describe("parsePortfolioPerformanceCsv value normalization", () => {
  it("stores absolute values for outflow types whether or not the export signs them", () => {
    const result = parsePortfolioPerformanceCsv(
      [
        DE_HEADER,
        deRow("Kauf", "1.005,00", true),
        deRow("Kauf", "-1.005,00", true),
        deRow("Einlage", "500,00"),
      ].join("\n"),
    );
    expect(result.errors).toEqual([]);
    expect(result.rows.map((r) => r.value)).toEqual(["1005.00", "1005.00", "500.00"]);
  });

  it("reports a negative value on an inflow type as a row error", () => {
    const result = parsePortfolioPerformanceCsv(
      [DE_HEADER, deRow("Einlage", "-500,00"), deRow("Dividende", "-1,00", true)].join("\n"),
    );
    expect(result.rows).toEqual([]);
    expect(result.errors.map((e) => e.message)).toEqual([
      expect.stringMatching(/negative value "-500,00" on inflow type deposit/),
      expect.stringMatching(/negative value "-1,00" on inflow type dividend/),
    ]);
  });

  it("takes absolute fees and taxes and keeps fractional shares exact", () => {
    const csv = [
      DE_HEADER,
      "01.02.2026;Kauf;-100,00;EUR;-1,50;-0,25;10,5;XS0000000001;Synthetic World ETF;",
    ].join("\n");
    const row = req(parsePortfolioPerformanceCsv(csv).rows[0]);
    expect(row.fees).toBe("1.50");
    expect(row.taxes).toBe("0.25");
    expect(row.shares).toBe("10.5");
  });

  it("upper-cases booking and gross currencies", () => {
    const csv = [
      "Datum;Typ;Wert;Buchungswährung;Bruttobetrag;Währung Bruttobetrag;ISIN",
      "01.02.2026;Dividende;1,00;eur;-1,20;usd;XS0000000001",
    ].join("\n");
    const row = req(parsePortfolioPerformanceCsv(csv).rows[0]);
    expect(row.currency).toBe("EUR");
    expect(row.grossCurrency).toBe("USD");
    expect(row.grossAmount).toBe("1.20");
  });

  it("rejects slashed month/day dates as a row error in a German export", () => {
    const result = parsePortfolioPerformanceCsv(
      [DE_HEADER, "03/02/2026;Einlage;1,00;EUR;;;;;;", deRow("Einlage", "1,00")].join("\n"),
    );
    expect(result.rows).toHaveLength(1);
    expect(result.errors).toEqual([
      { line: 2, message: expect.stringMatching(/unrecognized date "03\/02\/2026"/) },
    ]);
  });

  it("reports a missing date or value as a row error", () => {
    const result = parsePortfolioPerformanceCsv(
      [DE_HEADER, ";Einlage;1,00;EUR;;;;;;", "01.02.2026;Einlage;;EUR;;;;;;"].join("\n"),
    );
    expect(result.rows).toEqual([]);
    expect(result.errors.map((e) => e.message)).toEqual(["missing date", "missing value"]);
  });

  it("lets the first of two equally named columns win and trims header cells", () => {
    const csv = [" Datum ;Typ;Wert;Wert;Buchungswährung", "01.02.2026;Einlage;1,00;9,99;EUR"].join(
      "\n",
    );
    const result = parsePortfolioPerformanceCsv(csv);
    const row = req(result.rows[0]);
    expect(row.value).toBe("1.00");
    expect(row.date).toBe("2026-02-01");
    expect(row.columns["Datum"]).toBe("01.02.2026");
  });

  it("preserves the verbatim cells, including untyped columns, on the row", () => {
    const csv = [
      "Datum;Typ;Wert;Buchungswährung;Fremdspalte",
      "01.02.2026;Einlage;1,00;EUR;xyz",
    ].join("\n");
    const row = req(parsePortfolioPerformanceCsv(csv).rows[0]);
    expect(row.columns).toEqual({
      Datum: "01.02.2026",
      Typ: "Einlage",
      Wert: "1,00",
      Buchungswährung: "EUR",
      Fremdspalte: "xyz",
    });
  });

  it("suffixes repeated header names positionally so no cell is lost", () => {
    const csv = [
      "Datum;Typ;Wert;Buchungswährung;Notiz;Notiz;Notiz",
      "01.02.2026;Einlage;1,00;EUR;erste;zweite;dritte",
    ].join("\n");
    const row = req(parsePortfolioPerformanceCsv(csv).rows[0]);
    expect(row.columns).toEqual({
      Datum: "01.02.2026",
      Typ: "Einlage",
      Wert: "1,00",
      Buchungswährung: "EUR",
      Notiz: "erste",
      "Notiz (6)": "zweite",
      "Notiz (7)": "dritte",
    });
    // The typed field still reads the first matching column.
    expect(row.note).toBe("erste");
  });
});

describe("parseLocalizedDecimal grouping", () => {
  it("accepts grouping separators only between exact groups of three digits", () => {
    expect(parseLocalizedDecimal("1.234", "de")).toBe("1234");
    expect(parseLocalizedDecimal("1.234.567,89", "de")).toBe("1234567.89");
    expect(parseLocalizedDecimal("1,234,567.89", "en")).toBe("1234567.89");
    expect(parseLocalizedDecimal("1,5", "de")).toBe("1.5");
    expect(parseLocalizedDecimal("-0,00", "de")).toBe("-0.00");
    expect(parseLocalizedDecimal("0,5", "de")).toBe("0.5");
    expect(parseLocalizedDecimal("0.5", "en")).toBe("0.5");
  });

  it("rejects a value written in the other locale instead of changing its magnitude", () => {
    expect(() => parseLocalizedDecimal("0.5", "de")).toThrow(/invalid de number "0.5"/);
    expect(() => parseLocalizedDecimal("12.34", "de")).toThrow(/invalid de number/);
    expect(() => parseLocalizedDecimal("1,5", "en")).toThrow(/invalid en number "1,5"/);
    expect(() => parseLocalizedDecimal("1,23,456", "en")).toThrow(/invalid en number/);
    expect(() => parseLocalizedDecimal("1.23.456", "de")).toThrow(/invalid de number/);
    expect(() => parseLocalizedDecimal("1.2345", "de")).toThrow(/invalid de number/);
  });

  it("requires digits on both sides of the decimal mark", () => {
    // "5." and ".5" are not canonical decimals; they are rejected rather than
    // read as "5" / "0.5".
    expect(() => parseLocalizedDecimal("5.", "en")).toThrow(/invalid en number "5\."/);
    expect(() => parseLocalizedDecimal(".5", "en")).toThrow(/invalid en number "\.5"/);
    expect(() => parseLocalizedDecimal("5,", "de")).toThrow(/invalid de number/);
    expect(() => parseLocalizedDecimal(",5", "de")).toThrow(/invalid de number/);
    expect(() => parseLocalizedDecimal("-", "de")).toThrow(/invalid de number/);
    expect(() => parseLocalizedDecimal("1,5,0", "en")).toThrow(/invalid en number/);
  });
});

describe("parsePortfolioPerformanceCsv outflow signs and type cells", () => {
  it("accepts a signed value on outflow types and keeps the absolute value", () => {
    const result = parsePortfolioPerformanceCsv(
      [
        DE_HEADER,
        deRow("Entnahme", "-300,00"),
        deRow("Umbuchung (Ausgang)", "-10,00"),
        deRow("Umbuchung (Ausgang)", "-10,00", true),
        deRow("Auslieferung", "-10,00", true),
      ].join("\n"),
    );
    expect(result.errors).toEqual([]);
    expect(result.rows.map((r) => [r.type, r.value])).toEqual([
      ["withdrawal", "300.00"],
      ["transfer_out", "10.00"],
      ["security_transfer_outbound", "10.00"],
      ["delivery_outbound", "10.00"],
    ]);
  });

  it("resolves an inbound Umbuchung to a position transfer only when a security is named", () => {
    const result = parsePortfolioPerformanceCsv(
      [
        DE_HEADER,
        deRow("Umbuchung (Eingang)", "10,00"),
        deRow("Umbuchung (Eingang)", "10,00", true),
      ].join("\n"),
    );
    expect(result.errors).toEqual([]);
    expect(result.rows.map((r) => r.type)).toEqual(["transfer_in", "security_transfer_inbound"]);
  });

  it("treats prototype property names in the type cell as unknown types", () => {
    const result = parsePortfolioPerformanceCsv(
      [
        DE_HEADER,
        deRow("constructor", "1,00"),
        deRow("__proto__", "1,00"),
        deRow("toString", "1,00"),
        deRow("hasOwnProperty", "1,00"),
      ].join("\n"),
    );
    expect(result.rows).toEqual([]);
    expect(result.errors.map((e) => e.message)).toEqual([
      'unknown transaction type "constructor"',
      'unknown transaction type "__proto__"',
      'unknown transaction type "toString"',
      'unknown transaction type "hasOwnProperty"',
    ]);
  });

  it("ignores prototype property names in the header instead of mapping them", () => {
    const csv = [
      "Datum;Typ;Wert;Buchungswährung;constructor",
      "01.02.2026;Einlage;1,00;EUR;x",
    ].join("\n");
    const row = req(parsePortfolioPerformanceCsv(csv).rows[0]);
    expect(row.columns.constructor).toBe("x");
    expect(row.note).toBeUndefined();
    expect(row.cashAccount).toBeUndefined();
  });
});

describe("PpRowParseError", () => {
  it("is exported from the connector index and thrown by the localized parsers", () => {
    expect(PpRowParseErrorFromIndex).toBe(PpRowParseError);
    const thrown: unknown[] = [];
    for (const parse of [
      () => parseLocalizedDecimal("abc", "de"),
      () => parseLocalizedDecimal("1,0,0", "en"),
      () => parseLocalizedDate("31.02.2026", "de"),
      () => parseLocalizedDate("not a date", "en"),
    ]) {
      try {
        parse();
      } catch (error) {
        thrown.push(error);
      }
    }
    expect(thrown).toHaveLength(4);
    for (const error of thrown) {
      expect(error).toBeInstanceOf(PpRowParseError);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe("PpRowParseError");
    }
  });

  it("is not thrown for blank input, which simply yields undefined", () => {
    expect(parseLocalizedDecimal("", "de")).toBeUndefined();
    expect(parseLocalizedDecimal(undefined, "en")).toBeUndefined();
  });
});

describe("parsePortfolioPerformanceCsv untyped account columns", () => {
  it("keeps a duplicated Gegenkonto header in the raw columns only, without touching the typed accounts", () => {
    const csv = [
      "Datum;Typ;Wert;Buchungswährung;Konto;Gegenkonto;Gegenkonto",
      "01.03.2026;Einlage;500,00;EUR;Verrechnungskonto;Girokonto;Tagesgeld",
    ].join("\n");
    const result = parsePortfolioPerformanceCsv(csv);
    expect(result.errors).toEqual([]);
    const row = req(result.rows[0]);
    expect(row.cashAccount).toBe("Verrechnungskonto");
    expect(row.securitiesAccount).toBeUndefined();
    expect(row.columns).toEqual({
      Datum: "01.03.2026",
      Typ: "Einlage",
      Wert: "500,00",
      Buchungswährung: "EUR",
      Konto: "Verrechnungskonto",
      Gegenkonto: "Girokonto",
      "Gegenkonto (7)": "Tagesgeld",
    });
  });
});
