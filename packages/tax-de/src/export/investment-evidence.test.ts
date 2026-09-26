import {
  buildPortfolioDraftTransaction,
  type CashMovement,
  DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS,
  type PortfolioDraftTransaction,
  type PortfolioEvent,
  type SecurityTransaction,
} from "@sona/core";
import { describe, expect, it } from "vitest";
import { PRIVATE_DE_TEMPLATE } from "../templates/private-de.js";
import {
  generateInvestmentEvidenceRows,
  type InvestmentEvidenceInput,
  investmentEvidenceFromDraft,
} from "./investment-evidence.js";
import { generateExportPackage } from "./package.js";
import type { TaxPostingInput } from "./types.js";

function dividend(overrides: Partial<SecurityTransaction> = {}): SecurityTransaction {
  return {
    kind: "security_transaction",
    type: "dividend",
    externalId: "pp_div_0",
    brokerAccountExternalId: "Depot A",
    date: "2026-05-15",
    amount: { amount: "78.70", commodity: "EUR" },
    security: { isin: "US0000000TEST", wkn: undefined, ticker: "SYN", name: "Synthetic Inc" },
    shares: "50",
    gross: { amount: "100.00", commodity: "USD" },
    exchangeRate: "1.08",
    fees: "1.50",
    taxes: "13.89",
    note: undefined,
    raw: {},
    ...overrides,
  };
}

function draftFor(event: SecurityTransaction): PortfolioDraftTransaction {
  let n = 0;
  return buildPortfolioDraftTransaction(event, {
    workspaceId: "ws_1",
    ids: () => `id_${n++}`,
    createdAt: "2026-08-01T00:00:00Z",
  });
}

function file(files: Array<{ path: string; content: string }>, path: string): string | undefined {
  return files.find((f) => f.path === path)?.content;
}

describe("investmentEvidenceFromDraft", () => {
  it("emits one row per capital-income leg, each pointing at a real posting", () => {
    const event = dividend();
    const draft = draftFor(event);
    const rows = investmentEvidenceFromDraft({
      event,
      draft,
      accounts: DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS,
      rawRecordId: "raw_div",
      reviewState: "draft",
    });

    expect(rows.map((r) => r.kind).sort()).toEqual([
      "dividend",
      "investment_fee",
      "withholding_tax",
    ]);
    const postingIds = new Set(draft.postings.map((p) => p.id));
    for (const row of rows) {
      expect(postingIds.has(row.postingId)).toBe(true);
      expect(row.transactionId).toBe(draft.id);
      expect(row.eventExternalId).toBe("pp_div_0");
      expect(row.rawRecordId).toBe("raw_div");
      expect(row.reviewState).toBe("draft");
      expect(row.isin).toBe("US0000000TEST");
      expect(row.grossAmount).toBe("100.00");
      expect(row.grossCurrency).toBe("USD");
    }
    const withholding = rows.find((r) => r.kind === "withholding_tax");
    expect(withholding?.amount).toBe("13.89");
    expect(withholding?.foreignWithholdingSuggested).toBe(true);
    const income = rows.find((r) => r.kind === "dividend");
    expect(income?.amount).toBe("-100.00");
    expect(income?.currency).toBe("USD");
    expect(income?.foreignWithholdingSuggested).toBe(false);
  });

  it("does not suggest foreign withholding for a domestic, same-currency dividend", () => {
    const event = dividend({
      security: { isin: "DE000TEST0001", wkn: undefined, ticker: undefined, name: "Synthetic AG" },
      gross: undefined,
      exchangeRate: undefined,
    });
    const rows = investmentEvidenceFromDraft({
      event,
      draft: draftFor(event),
      accounts: DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS,
      rawRecordId: "raw_x",
      reviewState: "draft",
    });
    expect(rows.find((r) => r.kind === "withholding_tax")?.foreignWithholdingSuggested).toBe(false);
  });

  it("returns no rows for events without capital-income legs", () => {
    const event = dividend({
      type: "buy",
      amount: { amount: "-1000.00", commodity: "EUR" },
      fees: "0",
      taxes: "0",
    });
    const rows = investmentEvidenceFromDraft({
      event,
      draft: draftFor(event),
      accounts: DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS,
      rawRecordId: "raw_buy",
      reviewState: "draft",
    });
    expect(rows).toEqual([]);
  });
});

function input(overrides: Partial<InvestmentEvidenceInput> = {}): InvestmentEvidenceInput {
  return {
    kind: "withholding_tax",
    date: "2026-05-15",
    description: "dividend Synthetic Inc",
    amount: "13.89",
    currency: "EUR",
    account: DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS.taxesWithheld,
    grossAmount: "100.00",
    grossCurrency: "USD",
    isin: "US0000000TEST",
    securityName: "Synthetic Inc",
    brokerAccountExternalId: "Depot A",
    postingId: "p_tax",
    transactionId: "t_div",
    eventExternalId: "pp_div_0",
    rawRecordId: "raw_div",
    reviewState: "user_reviewed",
    foreignWithholdingSuggested: true,
    ...overrides,
  };
}

describe("generateInvestmentEvidenceRows", () => {
  it("applies the export review gate: drafts are excluded even from a draft export", () => {
    const result = generateInvestmentEvidenceRows(
      [input({ reviewState: "draft", postingId: "p_draft" }), input({ reviewState: "suggested" })],
      PRIVATE_DE_TEMPLATE,
      { mode: "draft" },
    );
    expect(result.rows.map((r) => r.postingId)).toEqual(["p_tax"]);
    expect(result.excluded).toEqual([
      { postingId: "p_draft", reason: expect.stringMatching(/draft/) },
    ]);
  });

  it("requires user review for a final export", () => {
    const result = generateInvestmentEvidenceRows(
      [input({ reviewState: "suggested", postingId: "p_sugg" }), input()],
      PRIVATE_DE_TEMPLATE,
      { mode: "final" },
    );
    expect(result.rows.map((r) => r.postingId)).toEqual(["p_tax"]);
  });

  it("uses suggestion wording and never asserts a legal outcome", () => {
    const { rows } = generateInvestmentEvidenceRows(
      [
        input({ reviewState: "suggested" }),
        input({
          kind: "investment_fee",
          postingId: "p_fee",
          foreignWithholdingSuggested: false,
          reviewState: "suggested",
        }),
      ],
      PRIVATE_DE_TEMPLATE,
      { mode: "draft" },
    );
    expect(rows[0]?.notes).toBe("foreign withholding suggested (heuristic); review required");
    expect(rows[1]?.notes).toBe("configured investment fee account; review required");
    expect(rows.every((r) => r.sectionId === "capital_income")).toBe(true);
    for (const row of rows) {
      expect(row.notes).not.toMatch(/deductible|creditable|guaranteed/i);
    }
  });
});

describe("generateExportPackage with investment evidence", () => {
  const feePosting: TaxPostingInput = {
    postingId: "p_fee",
    transactionId: "t_div",
    date: "2026-05-15",
    description: "dividend Synthetic Inc",
    amount: "1.50",
    commodity: "EUR",
    account: DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS.fees,
    reviewState: "user_reviewed",
    evidenceDocumentIds: [],
  };
  const taxPosting: TaxPostingInput = {
    ...feePosting,
    postingId: "p_tax",
    amount: "13.89",
    account: DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS.taxesWithheld,
  };

  it("adds investment-evidence.csv only when evidence is supplied", () => {
    const without = generateExportPackage({
      year: 2026,
      postings: [feePosting],
      template: PRIVATE_DE_TEMPLATE,
      mode: "final",
    });
    expect(without.files.map((f) => f.path)).not.toContain("investment-evidence.csv");

    const withEvidence = generateExportPackage({
      year: 2026,
      postings: [feePosting, taxPosting],
      template: PRIVATE_DE_TEMPLATE,
      mode: "final",
      investmentEvidence: [
        input(),
        input({
          kind: "investment_fee",
          postingId: "p_fee",
          amount: "1.50",
          foreignWithholdingSuggested: false,
        }),
        input({ postingId: "p_other_year", date: "2025-12-31" }),
      ],
    });
    const csv = file(withEvidence.files, "investment-evidence.csv") ?? "";
    const lines = csv.split("\n");
    expect(lines[0]).toBe(
      "date,kind,description,amount,currency,account,grossAmount,grossCurrency,isin,securityName,brokerAccountExternalId,section,reviewState,postingId,transactionId,eventExternalId,rawRecordId,foreignWithholdingSuggested,notes",
    );
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(
      "p_tax,t_div,pp_div_0,raw_div,true,foreign withholding suggested (heuristic)",
    );
    expect(lines[2]).toContain("investment_fee");
    expect(csv).not.toContain("p_other_year");

    // The fee posting also appears as a regular capital-income export line.
    const categories = file(withEvidence.files, "tax-categories.csv") ?? "";
    expect(categories).toContain("capital_income");
    expect(categories).toContain("p_fee");

    const summary = file(withEvidence.files, "summary.md") ?? "";
    expect(summary).toContain("## Investment evidence: 2 row(s)");
    expect(summary).toContain("Foreign withholding is suggested for 1 row(s) — review required.");
  });

  it("drops draft evidence from a draft export and lists it nowhere", () => {
    const pkg = generateExportPackage({
      year: 2026,
      postings: [],
      template: PRIVATE_DE_TEMPLATE,
      mode: "draft",
      investmentEvidence: [input({ reviewState: "draft", postingId: "p_draft_only" })],
    });
    const csv = file(pkg.files, "investment-evidence.csv") ?? "";
    expect(csv.split("\n")).toHaveLength(1);
    expect(csv.startsWith("date,kind,description")).toBe(true);
    for (const f of pkg.files) {
      expect(f.content, f.path).not.toContain("p_draft_only");
    }
    expect(file(pkg.files, "summary.md")).toContain("## Investment evidence: 0 row(s)");
    expect(file(pkg.files, "summary.md")).toContain(
      "Foreign withholding is suggested for 0 row(s)",
    );
  });

  it("drops evidence rows whose posting is not an included export line", () => {
    const pkg = generateExportPackage({
      year: 2026,
      postings: [feePosting],
      template: PRIVATE_DE_TEMPLATE,
      mode: "final",
      investmentEvidence: [
        input({ kind: "investment_fee", postingId: "p_fee", foreignWithholdingSuggested: false }),
        // Reviewed, in-year, but its posting was never passed to the package.
        input({ postingId: "p_orphan" }),
      ],
    });
    const csv = file(pkg.files, "investment-evidence.csv") ?? "";
    expect(csv.split("\n")).toHaveLength(2);
    expect(csv).toContain("p_fee");
    expect(csv).not.toContain("p_orphan");
  });

  it("neutralizes spreadsheet formulas in free-text evidence fields", () => {
    const pkg = generateExportPackage({
      year: 2026,
      postings: [taxPosting],
      template: PRIVATE_DE_TEMPLATE,
      mode: "final",
      investmentEvidence: [
        input({
          description: '=HYPERLINK("https://example.test")',
          securityName: "@Synthetic, Inc",
          brokerAccountExternalId: "+Depot A",
          amount: "-13.89",
          eventExternalId: "-pp_div_0",
        }),
      ],
    });
    const row = (file(pkg.files, "investment-evidence.csv") ?? "").split("\n")[1] ?? "";
    expect(row).toContain('\'=HYPERLINK(""https://example.test"")');
    expect(row).toContain('"\'@Synthetic, Inc"');
    expect(row).toContain("'+Depot A");
    expect(row).toContain("'-pp_div_0");
    expect(row).toContain(",-13.89,EUR,");
    expect(row).not.toContain("'-13.89");
  });
});

function cashMovement(overrides: Partial<CashMovement> = {}): CashMovement {
  return {
    kind: "cash_movement",
    type: "interest",
    externalId: "pp_int_0",
    brokerAccountExternalId: "Verrechnungskonto",
    date: "2026-06-30",
    amount: { amount: "1.23", commodity: "EUR" },
    security: undefined,
    note: undefined,
    raw: {},
    ...overrides,
  };
}

function draftForEvent(event: PortfolioEvent): PortfolioDraftTransaction {
  let n = 0;
  return buildPortfolioDraftTransaction(event, {
    workspaceId: "ws_1",
    ids: () => `id_${n++}`,
    createdAt: "2026-08-01T00:00:00Z",
  });
}

describe("investmentEvidenceFromDraft for cash movements", () => {
  it("emits an interest row from the income leg with no security or gross fields", () => {
    const event = cashMovement();
    const draft = draftForEvent(event);
    const rows = investmentEvidenceFromDraft({
      event,
      draft,
      accounts: DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS,
      rawRecordId: "raw_int",
      reviewState: "draft",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "interest",
      amount: "-1.23",
      currency: "EUR",
      grossAmount: undefined,
      grossCurrency: undefined,
      isin: undefined,
      securityName: undefined,
      brokerAccountExternalId: "Verrechnungskonto",
      description: "interest",
      date: "2026-06-30",
      reviewState: "draft",
      foreignWithholdingSuggested: false,
      rawRecordId: "raw_int",
    });
    expect(rows[0]?.postingId).toBe(
      draft.postings.find((p) => p.account === DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS.interest)?.id,
    );
  });

  it("emits a standalone fee as investment_fee and keeps a per-position security", () => {
    const plain = cashMovement({
      type: "fee",
      externalId: "pp_fee_0",
      amount: { amount: "-4.90", commodity: "EUR" },
    });
    const plainRows = investmentEvidenceFromDraft({
      event: plain,
      draft: draftForEvent(plain),
      accounts: DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS,
      rawRecordId: "raw_fee",
      reviewState: "draft",
    });
    expect(plainRows.map((r) => [r.kind, r.amount, r.isin])).toEqual([
      ["investment_fee", "4.90", undefined],
    ]);

    const perPosition = cashMovement({
      type: "fee",
      externalId: "pp_fee_1",
      amount: { amount: "-1.00", commodity: "EUR" },
      security: { isin: "XS0000000001", wkn: undefined, ticker: undefined, name: "Synthetic ETF" },
    });
    const rows = investmentEvidenceFromDraft({
      event: perPosition,
      draft: draftForEvent(perPosition),
      accounts: DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS,
      rawRecordId: "raw_fee_1",
      reviewState: "draft",
    });
    expect(rows[0]).toMatchObject({
      kind: "investment_fee",
      isin: "XS0000000001",
      securityName: "Synthetic ETF",
      grossAmount: undefined,
    });
  });

  it("emits broker tax and tax refund legs as withholding_tax without a foreign suggestion", () => {
    const tax = cashMovement({
      type: "tax",
      externalId: "pp_tax_0",
      amount: { amount: "-20.00", commodity: "EUR" },
    });
    const refund = cashMovement({
      type: "tax_refund",
      externalId: "pp_taxr_0",
      amount: { amount: "20.00", commodity: "EUR" },
    });
    const rowsFor = (event: CashMovement) =>
      investmentEvidenceFromDraft({
        event,
        draft: draftForEvent(event),
        accounts: DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS,
        rawRecordId: "raw_t",
        reviewState: "draft",
      });
    expect(rowsFor(tax).map((r) => [r.kind, r.amount, r.foreignWithholdingSuggested])).toEqual([
      ["withholding_tax", "20.00", false],
    ]);
    expect(rowsFor(refund).map((r) => [r.kind, r.amount])).toEqual([["withholding_tax", "-20.00"]]);
  });

  it("returns nothing for deposits, interest charges, and transfers", () => {
    for (const type of ["deposit", "interest_charge", "transfer_in"] as const) {
      // Interest charges are outflows; the builder rejects a contradicting sign.
      const amount = type === "interest_charge" ? "-1.23" : "1.23";
      const event = cashMovement({
        type,
        externalId: `pp_${type}`,
        amount: { amount, commodity: "EUR" },
      });
      expect(
        investmentEvidenceFromDraft({
          event,
          draft: draftForEvent(event),
          accounts: DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS,
          rawRecordId: "raw",
          reviewState: "draft",
        }),
        type,
      ).toEqual([]);
    }
  });

  it("resolves evidence kinds against the configured account paths", () => {
    const accounts = { ...DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS, fees: "Expenses:Depot:Gebuehren" };
    const event = cashMovement({
      type: "fee",
      externalId: "pp_fee_cfg",
      amount: { amount: "-4.90", commodity: "EUR" },
    });
    const draft = buildPortfolioDraftTransaction(event, {
      workspaceId: "ws_1",
      ids: () => "id",
      createdAt: "2026-08-01T00:00:00Z",
      accounts,
    });
    expect(
      investmentEvidenceFromDraft({
        event,
        draft,
        accounts,
        rawRecordId: "raw",
        reviewState: "draft",
      }).map((r) => r.kind),
    ).toEqual(["investment_fee"]);
    // The same draft read with the default account map finds no fee leg.
    expect(
      investmentEvidenceFromDraft({
        event,
        draft,
        accounts: DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS,
        rawRecordId: "raw",
        reviewState: "draft",
      }),
    ).toEqual([]);
  });
});

/** The persisted-posting view of a draft, as the export would receive it after review. */
function postingsOf(
  draft: PortfolioDraftTransaction,
  reviewState: TaxPostingInput["reviewState"],
): TaxPostingInput[] {
  return draft.postings.map((p) => ({
    postingId: p.id,
    transactionId: p.transactionId,
    date: draft.bookedOn,
    description: draft.description,
    amount: p.amount.amount,
    commodity: p.amount.commodity,
    account: p.account,
    reviewState,
    evidenceDocumentIds: [],
  }));
}

describe("investmentEvidenceFromDraft through the final package gate", () => {
  it("exports user-reviewed rows from a draft once their postings are reviewed too", () => {
    const event = dividend();
    const draft = draftFor(event);
    const evidence = investmentEvidenceFromDraft({
      event,
      draft,
      accounts: DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS,
      rawRecordId: "raw_div",
      reviewState: "user_reviewed",
    });
    expect(evidence).toHaveLength(3);

    const pkg = generateExportPackage({
      year: 2026,
      postings: postingsOf(draft, "user_reviewed"),
      template: PRIVATE_DE_TEMPLATE,
      mode: "final",
      investmentEvidence: evidence,
    });
    const lines = (file(pkg.files, "investment-evidence.csv") ?? "").split("\n");
    expect(lines).toHaveLength(4);
    const kinds = lines.slice(1).map((l) => l.split(",")[1]);
    expect(kinds.sort()).toEqual(["dividend", "investment_fee", "withholding_tax"]);
    // Every row points at a posting that is itself an export line.
    const categories = file(pkg.files, "tax-categories.csv") ?? "";
    for (const row of evidence) {
      expect(categories).toContain(row.postingId);
    }
    // Reviewed rows carry no "review required" note; the heuristic flag stays.
    const withholding = lines.find((l) => l.includes(",withholding_tax,")) ?? "";
    expect(withholding).toContain(",user_reviewed,");
    expect(withholding).toContain(",true,foreign withholding suggested (heuristic)");
    expect(withholding).not.toContain("review required");
    expect(withholding).toContain("raw_div");
    expect(withholding).toContain(",100.00,USD,US0000000TEST,Synthetic Inc,Depot A,");
    expect(file(pkg.files, "summary.md")).toContain("## Investment evidence: 3 row(s)");
  });

  it("drops rows whose postings the final review gate excludes", () => {
    const event = dividend();
    const draft = draftFor(event);
    const evidence = investmentEvidenceFromDraft({
      event,
      draft,
      accounts: DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS,
      rawRecordId: "raw_div",
      reviewState: "user_reviewed",
    });

    // The ledger transaction is only `suggested`: none of its postings pass a
    // final export, so the evidence rows have nothing to annotate.
    const pkg = generateExportPackage({
      year: 2026,
      postings: postingsOf(draft, "suggested"),
      template: PRIVATE_DE_TEMPLATE,
      mode: "final",
      investmentEvidence: evidence,
    });
    const csv = file(pkg.files, "investment-evidence.csv") ?? "";
    expect(csv.split("\n")).toHaveLength(1);
    for (const f of pkg.files) {
      expect(f.content, f.path).not.toContain("raw_div");
    }
    expect(file(pkg.files, "summary.md")).toContain("## Investment evidence: 0 row(s)");

    // A draft export lets the same suggested postings through, and the rows follow.
    const draftPkg = generateExportPackage({
      year: 2026,
      postings: postingsOf(draft, "suggested"),
      template: PRIVATE_DE_TEMPLATE,
      mode: "draft",
      investmentEvidence: evidence,
    });
    expect((file(draftPkg.files, "investment-evidence.csv") ?? "").split("\n")).toHaveLength(4);
  });

  it("keeps only the rows whose own posting is reviewed when a transaction is partly reviewed", () => {
    const event = dividend();
    const draft = draftFor(event);
    const evidence = investmentEvidenceFromDraft({
      event,
      draft,
      accounts: DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS,
      rawRecordId: "raw_div",
      reviewState: "user_reviewed",
    });
    const taxRow = evidence.find((r) => r.kind === "withholding_tax");
    const postings = postingsOf(draft, "user_reviewed").map((p) =>
      p.postingId === taxRow?.postingId ? { ...p, reviewState: "suggested" as const } : p,
    );
    const pkg = generateExportPackage({
      year: 2026,
      postings,
      template: PRIVATE_DE_TEMPLATE,
      mode: "final",
      investmentEvidence: evidence,
    });
    const csv = file(pkg.files, "investment-evidence.csv") ?? "";
    const kinds = csv
      .split("\n")
      .slice(1)
      .map((l) => l.split(",")[1]);
    expect(kinds.sort()).toEqual(["dividend", "investment_fee"]);
    expect(csv).not.toContain(taxRow?.postingId ?? "never");
  });
});

describe("investmentEvidenceFromDraft trade fees", () => {
  function feeRows(event: SecurityTransaction, reviewState: "draft" | "user_reviewed") {
    return generateInvestmentEvidenceRows(
      investmentEvidenceFromDraft({
        event,
        draft: draftFor(event),
        accounts: DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS,
        rawRecordId: "raw_trade",
        reviewState,
      }),
      PRIVATE_DE_TEMPLATE,
      { mode: "draft" },
    ).rows;
  }

  const buy = dividend({
    type: "buy",
    externalId: "pp_buy_0",
    amount: { amount: "-1001.50", commodity: "EUR" },
    gross: undefined,
    exchangeRate: undefined,
    fees: "1.50",
    taxes: "0",
  });
  const sell = dividend({
    type: "sell",
    externalId: "pp_sell_0",
    amount: { amount: "998.50", commodity: "EUR" },
    gross: undefined,
    exchangeRate: undefined,
    fees: "1.50",
    taxes: "0",
  });

  it("classifies buy and sell fee legs as transaction_cost with a review-required note while unreviewed", () => {
    for (const event of [buy, sell]) {
      const rows = investmentEvidenceFromDraft({
        event,
        draft: draftFor(event),
        accounts: DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS,
        rawRecordId: "raw_trade",
        reviewState: "suggested",
      });
      expect(
        rows.map((r) => r.kind),
        event.type,
      ).toEqual(["transaction_cost"]);
      expect(rows[0]?.account).toBe(DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS.tradeCosts);
      expect(rows[0]?.amount).toBe("1.50");
      const { rows: exported } = generateInvestmentEvidenceRows(rows, PRIVATE_DE_TEMPLATE, {
        mode: "draft",
      });
      expect(exported[0]?.notes).toBe("trade fee (acquisition/disposal cost); review required");
      expect(exported[0]?.sectionId).toBe("capital_income");
    }
  });

  it("drops the review-required note once the leg is user reviewed", () => {
    const [row] = feeRows(sell, "user_reviewed");
    expect(row?.kind).toBe("transaction_cost");
    expect(row?.notes).toBe("trade fee (acquisition/disposal cost)");
    expect(row?.notes).not.toMatch(/review required/);
  });

  it("keeps a dividend fee leg as investment_fee, not transaction_cost", () => {
    const rows = feeRows(dividend(), "user_reviewed");
    const fee = rows.find((r) => r.account === DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS.fees);
    expect(fee?.kind).toBe("investment_fee");
    expect(fee?.notes).toBe("configured investment fee account");
    expect(rows.some((r) => r.kind === "transaction_cost")).toBe(false);
  });
});

describe("investmentEvidenceFromDraft section mapping", () => {
  it("follows the template: a fee account outside the capital-income patterns maps to uncategorized", () => {
    const accounts = { ...DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS, fees: "Expenses:Depot:Gebuehren" };
    const event = cashMovement({
      type: "fee",
      externalId: "pp_fee_sec",
      amount: { amount: "-4.90", commodity: "EUR" },
    });
    const draft = buildPortfolioDraftTransaction(event, {
      workspaceId: "ws_1",
      ids: () => "id",
      createdAt: "2026-08-01T00:00:00Z",
      accounts,
    });
    const inputs = investmentEvidenceFromDraft({
      event,
      draft,
      accounts,
      rawRecordId: "raw",
      reviewState: "user_reviewed",
    });
    const { rows } = generateInvestmentEvidenceRows(inputs, PRIVATE_DE_TEMPLATE, {
      mode: "final",
    });
    expect(rows.map((r) => [r.kind, r.account, r.sectionId])).toEqual([
      ["investment_fee", "Expenses:Depot:Gebuehren", PRIVATE_DE_TEMPLATE.uncategorizedSectionId],
    ]);
    expect(PRIVATE_DE_TEMPLATE.uncategorizedSectionId).toBe("uncategorized");
  });

  it("writes the ledger account into every investment-evidence.csv row", () => {
    const pkg = generateExportPackage({
      year: 2026,
      postings: [
        {
          postingId: "p_fee_cfg",
          transactionId: "t_fee",
          date: "2026-06-30",
          description: "fee",
          amount: "4.90",
          commodity: "EUR",
          account: "Expenses:Depot:Gebuehren",
          reviewState: "user_reviewed",
          evidenceDocumentIds: [],
        },
      ],
      template: PRIVATE_DE_TEMPLATE,
      mode: "final",
      investmentEvidence: [
        input({
          kind: "investment_fee",
          postingId: "p_fee_cfg",
          transactionId: "t_fee",
          date: "2026-06-30",
          description: "fee",
          amount: "4.90",
          account: "Expenses:Depot:Gebuehren",
          grossAmount: undefined,
          grossCurrency: undefined,
          isin: undefined,
          securityName: undefined,
          foreignWithholdingSuggested: false,
        }),
      ],
    });
    const csv = file(pkg.files, "investment-evidence.csv") ?? "";
    const [header, row] = csv.split("\n");
    const columns = (header ?? "").split(",");
    const accountIndex = columns.indexOf("account");
    expect(accountIndex).toBeGreaterThanOrEqual(0);
    const cells = (row ?? "").split(",");
    expect(cells[accountIndex]).toBe("Expenses:Depot:Gebuehren");
    expect(cells[columns.indexOf("section")]).toBe("uncategorized");
    expect(cells[columns.indexOf("kind")]).toBe("investment_fee");
  });
});
