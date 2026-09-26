import type { PortfolioEvent, RawSourceRecord, ValuationSnapshot } from "@sona/core";
import { describe, expect, it } from "vitest";
import type { SyncEnv } from "../shared.js";
import {
  PP_HOLDINGS_DE_CSV,
  PP_TRANSACTIONS_DE_CSV,
  PP_TRANSACTIONS_EN_CSV,
  PP_TRANSACTIONS_WITH_ERRORS_CSV,
} from "./fixtures.js";
import {
  type PortfolioImportRunStore,
  type PortfolioRawRecordStore,
  type PortfolioStore,
  runPortfolioPerformanceHoldingsImport,
  runPortfolioPerformanceImport,
} from "./import.js";

interface Harness {
  rawStore: PortfolioRawRecordStore;
  portfolioStore: PortfolioStore;
  runStore: PortfolioImportRunStore;
  env: SyncEnv;
  raws: RawSourceRecord[];
  events: Map<string, { event: PortfolioEvent; rawRecordId: string }>;
  valuations: Map<string, ValuationSnapshot>;
  accounts: string[];
  accountKinds: Map<string, string>;
  securities: string[];
  /** Every saveEvent call's link, including calls that resolved to "unchanged". */
  links: Array<{ externalId: string; rawRecordId: string }>;
  runEvents: Array<[string, unknown]>;
  order: string[];
}

interface HarnessOptions {
  /**
   * Simulates a stored event whose gross/FX details differ from the incoming
   * one: `saveEvent` answers "conflict" for matching events, as the SQLite
   * repository does.
   */
  conflictWhen?: (event: PortfolioEvent) => boolean;
}

/** In-memory stores mirroring the SQLite dedup rules. */
function harness(options: HarnessOptions = {}): Harness {
  const raws: RawSourceRecord[] = [];
  const events = new Map<string, { event: PortfolioEvent; rawRecordId: string }>();
  const valuations = new Map<string, ValuationSnapshot>();
  const accounts: string[] = [];
  const accountKinds = new Map<string, string>();
  const securities: string[] = [];
  const links: Array<{ externalId: string; rawRecordId: string }> = [];
  const runEvents: Array<[string, unknown]> = [];
  const order: string[] = [];
  let counter = 0;

  const rawStore: PortfolioRawRecordStore = {
    append: async (record) => {
      const existing = raws.find(
        (r) =>
          r.workspaceId === record.workspaceId &&
          r.sourceId === record.sourceId &&
          r.payloadHash === record.payloadHash,
      );
      if (existing) {
        return existing;
      }
      raws.push(record);
      order.push(`raw:${record.externalId}`);
      return record;
    },
  };
  const portfolioStore: PortfolioStore = {
    saveBrokerAccount: async (account) => {
      accounts.push(account.externalId);
      accountKinds.set(account.externalId, account.kind);
    },
    saveSecurity: async (security) => {
      securities.push(security.key);
    },
    saveEvent: async (event, link) => {
      order.push(`event:${event.externalId}`);
      links.push({ externalId: event.externalId, rawRecordId: link.rawRecordId });
      if (options.conflictWhen?.(event) === true) {
        return "conflict";
      }
      if (events.has(event.externalId)) {
        return "unchanged";
      }
      events.set(event.externalId, { event, rawRecordId: link.rawRecordId });
      return "created";
    },
    saveValuation: async (snapshot) => {
      // Mirrors the SQLite point key (account, security, asOf) and its
      // conflict rule: same point with different values is a conflict.
      const key = [
        snapshot.brokerAccountExternalId ?? "",
        snapshot.security?.isin ?? snapshot.security?.name ?? "",
        snapshot.asOf,
      ].join("|");
      const existing = valuations.get(key);
      if (existing !== undefined) {
        return existing.marketValue.amount === snapshot.marketValue.amount &&
          existing.shares === snapshot.shares
          ? "unchanged"
          : "conflict";
      }
      valuations.set(key, snapshot);
      return "created";
    },
  };
  const runStore: PortfolioImportRunStore = {
    start: async (run) => {
      runEvents.push(["start", run]);
    },
    finish: async (run) => {
      runEvents.push(["finish", run]);
    },
  };
  const env: SyncEnv = {
    ids: () => `id_${counter++}`,
    nowIso: () => "2026-08-01T00:00:00Z",
  };
  return {
    rawStore,
    portfolioStore,
    runStore,
    env,
    raws,
    events,
    valuations,
    accounts,
    accountKinds,
    securities,
    links,
    runEvents,
    order,
  };
}

const base = { workspaceId: "ws_1", sourceId: "src_pp", fileName: "export.csv" };

/** Status of the most recent run's finish event. */
function finishStatus(h: Harness): string {
  const finish = h.runEvents.filter(([kind]) => kind === "finish").at(-1);
  return (finish?.[1] as { status: string }).status;
}

/** Per-row raw records, i.e. everything except the verbatim file record(s). */
function rowRaws(h: Harness): RawSourceRecord[] {
  return h.raws.filter((r) => r.recordType !== "source_file");
}

describe("runPortfolioPerformanceImport", () => {
  it("writes each raw row before its event and links them", async () => {
    const h = harness();
    const summary = await runPortfolioPerformanceImport({
      ...base,
      ...h,
      csv: PP_TRANSACTIONS_DE_CSV,
    });

    expect(summary.rowsParsed).toBe(6);
    expect(summary.eventsCreated).toBe(6);
    expect(summary.eventsUnchanged).toBe(0);
    expect(summary.rowErrors).toEqual([]);
    expect(summary.fileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(summary.fileName).toBe("export.csv");
    expect(finishStatus(h)).toBe("succeeded");

    expect(rowRaws(h)).toHaveLength(6);
    expect(rowRaws(h).every((r) => r.recordType === "portfolio_event")).toBe(true);
    expect(Object.isFrozen(rowRaws(h)[0])).toBe(true);

    // The whole export is preserved verbatim, before any row, under its hash.
    const fileRaw = h.raws.find((r) => r.recordType === "source_file");
    expect(fileRaw?.id).toBe(summary.fileRawRecordId);
    expect(fileRaw?.externalId).toBe(`pp_file_${summary.fileHash}`);
    expect(fileRaw?.payloadJson).toEqual({
      format: "portfolio_performance_csv_file",
      text: PP_TRANSACTIONS_DE_CSV,
    });
    expect(h.raws.indexOf(fileRaw as RawSourceRecord)).toBe(0);

    for (const { event, rawRecordId } of h.events.values()) {
      const raw = h.raws.find((r) => r.id === rawRecordId);
      expect(raw?.externalId).toBe(event.externalId);
      expect(raw?.payloadJson).toEqual(event.raw);
      expect(h.order.indexOf(`raw:${event.externalId}`)).toBeLessThan(
        h.order.indexOf(`event:${event.externalId}`),
      );
    }

    expect(new Set(h.accounts)).toEqual(new Set(["Verrechnungskonto", "Depot A"]));
    expect(new Set(h.securities)).toEqual(new Set(["isin:XS0000000001", "isin:US0000000TEST"]));
  });

  it("creates zero new records when the same export is imported again", async () => {
    const h = harness();
    await runPortfolioPerformanceImport({ ...base, ...h, csv: PP_TRANSACTIONS_DE_CSV });
    const again = await runPortfolioPerformanceImport({
      ...base,
      ...h,
      csv: PP_TRANSACTIONS_DE_CSV,
    });

    expect(again.eventsCreated).toBe(0);
    expect(again.eventsUnchanged).toBe(6);
    expect(rowRaws(h)).toHaveLength(6);
    expect(h.events.size).toBe(6);
  });

  it("dedups an overlapping export in another locale to the same events", async () => {
    const h = harness();
    await runPortfolioPerformanceImport({ ...base, ...h, csv: PP_TRANSACTIONS_DE_CSV });
    const overlap = await runPortfolioPerformanceImport({
      ...base,
      ...h,
      csv: PP_TRANSACTIONS_EN_CSV,
    });

    // The English export re-states the same deposit, buy, and dividend with
    // different account labels, locale, and note wording; none of those are
    // part of the economic identity, so every row dedups.
    expect(overlap.eventsUnchanged).toBe(3);
    expect(overlap.eventsCreated).toBe(0);
    expect(h.events.size).toBe(6);
  });

  it("imports valid rows and reports malformed ones as row errors", async () => {
    const h = harness();
    const summary = await runPortfolioPerformanceImport({
      ...base,
      ...h,
      csv: PP_TRANSACTIONS_WITH_ERRORS_CSV,
    });

    expect(summary.eventsCreated).toBe(2);
    expect(summary.rowErrors.map((e) => e.line)).toEqual([3, 4, 5, 6]);
    expect(finishStatus(h)).toBe("completed_with_errors");
  });

  it("closes the run as failed when the file is unusable", async () => {
    const h = harness();
    await expect(runPortfolioPerformanceImport({ ...base, ...h, csv: "Notiz\nx" })).rejects.toThrow(
      /missing required column/,
    );
    expect(finishStatus(h)).toBe("failed");
    // Even an unusable file is preserved verbatim; no row records exist.
    expect(rowRaws(h)).toHaveLength(0);
    expect(h.raws.map((r) => r.recordType)).toEqual(["source_file"]);
  });

  it("works without a run store", async () => {
    const h = harness();
    const summary = await runPortfolioPerformanceImport({
      ...base,
      rawStore: h.rawStore,
      portfolioStore: h.portfolioStore,
      env: h.env,
      fileName: undefined,
      csv: PP_TRANSACTIONS_EN_CSV,
    });
    expect(summary.eventsCreated).toBe(3);
  });
});

describe("runPortfolioPerformanceHoldingsImport", () => {
  it("stores valuation snapshots as informational records linked to raw rows", async () => {
    const h = harness();
    const summary = await runPortfolioPerformanceHoldingsImport({
      ...base,
      ...h,
      csv: PP_HOLDINGS_DE_CSV,
      asOf: "2026-06-30",
    });

    expect(summary.valuationsCreated).toBe(2);
    expect(summary.rowErrors).toHaveLength(1);
    expect(rowRaws(h).every((r) => r.recordType === "portfolio_valuation")).toBe(true);
    for (const snapshot of h.valuations.values()) {
      expect(snapshot.asOf).toBe("2026-06-30");
      expect(rowRaws(h).some((r) => r.id === snapshot.rawRecordId)).toBe(true);
    }
  });

  it("is idempotent for the same holdings and date", async () => {
    const h = harness();
    const input = { ...base, ...h, csv: PP_HOLDINGS_DE_CSV, asOf: "2026-06-30" };
    await runPortfolioPerformanceHoldingsImport(input);
    const again = await runPortfolioPerformanceHoldingsImport(input);
    expect(again.valuationsCreated).toBe(0);
    expect(again.valuationsUnchanged).toBe(2);
    expect(rowRaws(h)).toHaveLength(2);

    // A later date is a new append-only snapshot, not an update.
    const later = await runPortfolioPerformanceHoldingsImport({ ...input, asOf: "2026-07-31" });
    expect(later.valuationsCreated).toBe(2);
    expect(h.valuations.size).toBe(4);
  });

  it("uses the configured default account for holdings without a securities account", async () => {
    const h = harness();
    const csv = "Name;ISIN;Marktwert;Währung\nSynthetic World ETF;XS0000000001;1.105,00;EUR";
    await runPortfolioPerformanceHoldingsImport({
      ...base,
      ...h,
      csv,
      asOf: "2026-06-30",
      defaultAccountExternalId: "Depot X",
    });
    const [snapshot] = [...h.valuations.values()];
    expect(snapshot?.brokerAccountExternalId).toBe("Depot X");
    expect(snapshot?.security?.isin).toBe("XS0000000001");
    expect(snapshot?.sourceId).toBe("src_pp");
    expect(snapshot?.workspaceId).toBe("ws_1");
  });

  it("does not write a raw record for a malformed holdings row", async () => {
    const h = harness();
    await runPortfolioPerformanceHoldingsImport({
      ...base,
      ...h,
      csv: PP_HOLDINGS_DE_CSV,
      asOf: "2026-06-30",
    });
    expect(rowRaws(h)).toHaveLength(2);
    expect(finishStatus(h)).toBe("completed_with_errors");
  });
});

describe("runPortfolioPerformanceImport provenance", () => {
  it("re-links re-imported events to the raw record stored on first import", async () => {
    const h = harness();
    await runPortfolioPerformanceImport({ ...base, ...h, csv: PP_TRANSACTIONS_DE_CSV });
    const firstLinks = new Map(h.links.map((l) => [l.externalId, l.rawRecordId]));
    const firstHashes = rowRaws(h)
      .map((r) => r.payloadHash)
      .sort();

    h.links.length = 0;
    await runPortfolioPerformanceImport({
      ...base,
      ...h,
      csv: PP_TRANSACTIONS_DE_CSV,
      fileName: "export-again.csv",
    });

    expect(h.links).toHaveLength(6);
    for (const link of h.links) {
      expect(link.rawRecordId).toBe(firstLinks.get(link.externalId));
    }
    expect(
      rowRaws(h)
        .map((r) => r.payloadHash)
        .sort(),
    ).toEqual(firstHashes);
    expect(new Set(firstHashes).size).toBe(6);
  });

  it("writes no raw record for rows that failed to parse", async () => {
    const h = harness();
    await runPortfolioPerformanceImport({
      ...base,
      ...h,
      csv: PP_TRANSACTIONS_WITH_ERRORS_CSV,
    });
    expect(rowRaws(h)).toHaveLength(2);
    expect(
      rowRaws(h)
        .map((r) => r.externalId)
        .sort(),
    ).toEqual([...h.events.keys()].sort());
    for (const raw of rowRaws(h)) {
      expect(raw.payloadJson).toMatchObject({ format: "portfolio_performance_csv" });
    }
  });

  it("derives the broker account kind from the supplying column", async () => {
    const h = harness();
    await runPortfolioPerformanceImport({ ...base, ...h, csv: PP_TRANSACTIONS_DE_CSV });
    expect(h.accountKinds.get("Depot A")).toBe("securities");
    expect(h.accountKinds.get("Verrechnungskonto")).toBe("cash");
    // Each account is registered once per run, not once per event.
    expect(h.accounts).toHaveLength(2);
  });

  it("registers no securities when the export only contains cash movements", async () => {
    const h = harness();
    const csv = [
      "Datum;Typ;Wert;Buchungswährung;Konto",
      "01.03.2026;Einlage;500,00;EUR;Konto A",
      "02.03.2026;Zinsen;1,23;EUR;Konto A",
    ].join("\n");
    const summary = await runPortfolioPerformanceImport({ ...base, ...h, csv });
    expect(summary.eventsCreated).toBe(2);
    expect(h.securities).toEqual([]);
    expect(h.accountKinds.get("Konto A")).toBe("cash");
  });

  it("registers a security once even when several rows reference it", async () => {
    const h = harness();
    await runPortfolioPerformanceImport({ ...base, ...h, csv: PP_TRANSACTIONS_DE_CSV });
    // The buy and the sell both reference XS0000000001.
    expect(h.securities.filter((k) => k === "isin:XS0000000001")).toHaveLength(1);
  });

  it("records the file hash on the run start and in the summary", async () => {
    const h = harness();
    const summary = await runPortfolioPerformanceImport({
      ...base,
      ...h,
      csv: PP_TRANSACTIONS_EN_CSV,
    });
    const start = h.runEvents.find(([kind]) => kind === "start")?.[1] as {
      runId: string;
      fileHash: string;
      workspaceId: string;
      sourceId: string;
    };
    expect(start.fileHash).toBe(summary.fileHash);
    expect(start.runId).toBe(summary.runId);
    expect(start.workspaceId).toBe("ws_1");
    expect(start.sourceId).toBe("src_pp");
    const other = await runPortfolioPerformanceImport({
      ...base,
      ...harness(),
      csv: PP_TRANSACTIONS_DE_CSV,
    });
    expect(other.fileHash).not.toBe(summary.fileHash);
  });

  it("applies the default account from parse options to account-less rows", async () => {
    const h = harness();
    const csv = "Datum;Typ;Wert;Buchungswährung\n01.03.2026;Einlage;500,00;EUR";
    await runPortfolioPerformanceImport({
      ...base,
      ...h,
      csv,
      defaultAccountExternalId: "Broker Y",
    });
    expect(h.accounts).toEqual(["Broker Y"]);
    const [stored] = [...h.events.values()];
    expect(stored?.event.brokerAccountExternalId).toBe("Broker Y");
  });
});

describe("re-export semantics", () => {
  it("treats a re-export with an edited note as the same event", async () => {
    const h = harness();
    const header = "Datum;Typ;Wert;Buchungswährung;Notiz";
    await runPortfolioPerformanceImport({
      ...base,
      ...h,
      csv: [header, "01.03.2026;Einlage;500,00;EUR;Überweisung"].join("\n"),
    });
    const edited = await runPortfolioPerformanceImport({
      ...base,
      ...h,
      csv: [header, "01.03.2026;Einlage;500,00;EUR;Überweisung Girokonto (korrigiert)"].join("\n"),
    });
    expect(edited.eventsCreated).toBe(0);
    expect(edited.eventsUnchanged).toBe(1);
    // The edited row is still preserved verbatim in the raw vault.
    expect(rowRaws(h)).toHaveLength(2);
    expect(h.events.size).toBe(1);
  });

  it("imports a securities Umbuchung as a position transfer, not a cash movement", async () => {
    const h = harness();
    const csv = [
      "Datum;Typ;Wert;Buchungswährung;Stück;ISIN;Wertpapiername;Depot",
      "01.03.2026;Umbuchung (Eingang);500,00;EUR;5;XS0000000001;Synthetic World ETF;Depot B",
    ].join("\n");
    await runPortfolioPerformanceImport({ ...base, ...h, csv });
    const [stored] = [...h.events.values()];
    expect(stored?.event.kind).toBe("security_transaction");
    expect(stored?.event.type).toBe("security_transfer_inbound");
    expect(h.accounts).toEqual(["Depot B"]);
  });

  it("surfaces a conflicting holdings snapshot instead of dropping it", async () => {
    const h = harness();
    const header = "Name;ISIN;Stück;Marktwert;Währung;Depot";
    const first = { ...base, ...h, asOf: "2026-06-30" };
    await runPortfolioPerformanceHoldingsImport({
      ...first,
      csv: [header, "Synthetic World ETF;XS0000000001;10;1.105,00;EUR;Depot A"].join("\n"),
    });
    const conflicting = await runPortfolioPerformanceHoldingsImport({
      ...first,
      csv: [header, "Synthetic World ETF;XS0000000001;10;1.200,00;EUR;Depot A"].join("\n"),
    });
    expect(conflicting.valuationsCreated).toBe(0);
    expect(conflicting.valuationsUnchanged).toBe(0);
    expect(conflicting.valuationsConflicting).toBe(1);
    expect(conflicting.rowErrors).toEqual([
      { line: 2, message: expect.stringMatching(/conflicts with an already stored snapshot/) },
    ]);
    expect(finishStatus(h)).toBe("completed_with_errors");
    // The first snapshot stands; both raw rows are in the vault.
    expect([...h.valuations.values()].map((v) => v.marketValue.amount)).toEqual(["1105.00"]);
    expect(rowRaws(h)).toHaveLength(2);
  });

  it("surfaces a conflicting stored event as a row error instead of dropping it", async () => {
    // The dividend on line 4 already exists with other gross/FX details.
    const h = harness({ conflictWhen: (event) => event.type === "dividend" });
    const summary = await runPortfolioPerformanceImport({
      ...base,
      ...h,
      csv: PP_TRANSACTIONS_DE_CSV,
    });
    expect(summary.rowsParsed).toBe(6);
    expect(summary.eventsCreated).toBe(5);
    expect(summary.eventsUnchanged).toBe(0);
    expect(summary.eventsConflicting).toBe(1);
    expect(summary.rowErrors).toEqual([
      {
        line: 4,
        message: expect.stringMatching(
          /^event pp_[0-9a-f]+_0 conflicts with the stored event's gross\/FX details; review required$/,
        ),
      },
    ]);
    expect(finishStatus(h)).toBe("completed_with_errors");
    // The conflicting row is still preserved verbatim in the raw vault.
    expect(rowRaws(h)).toHaveLength(6);
    expect(h.events.size).toBe(5);
    expect([...h.events.values()].some((e) => e.event.type === "dividend")).toBe(false);
  });
});

describe("source file provenance", () => {
  const fileRaws = (h: Harness) => h.raws.filter((r) => r.recordType === "source_file");

  it("stores the verbatim file once across re-imports of the same export", async () => {
    const h = harness();
    const first = await runPortfolioPerformanceImport({
      ...base,
      ...h,
      csv: PP_TRANSACTIONS_DE_CSV,
    });
    const second = await runPortfolioPerformanceImport({
      ...base,
      ...h,
      csv: PP_TRANSACTIONS_DE_CSV,
      fileName: "renamed-copy.csv",
    });
    expect(first.fileRawRecordId).toBeDefined();
    expect(second.fileRawRecordId).toBe(first.fileRawRecordId);
    expect(second.fileHash).toBe(first.fileHash);
    expect(fileRaws(h)).toHaveLength(1);
    expect(fileRaws(h)[0]?.externalId).toBe(`pp_file_${first.fileHash}`);
  });

  it("stores a second file record for a different export", async () => {
    const h = harness();
    const de = await runPortfolioPerformanceImport({ ...base, ...h, csv: PP_TRANSACTIONS_DE_CSV });
    const en = await runPortfolioPerformanceImport({ ...base, ...h, csv: PP_TRANSACTIONS_EN_CSV });
    expect(en.fileRawRecordId).not.toBe(de.fileRawRecordId);
    expect(en.fileHash).not.toBe(de.fileHash);
    expect(
      fileRaws(h)
        .map((r) => r.externalId)
        .sort(),
    ).toEqual([`pp_file_${de.fileHash}`, `pp_file_${en.fileHash}`].sort());
    expect(fileRaws(h).map((r) => r.payloadJson)).toEqual(
      expect.arrayContaining([
        { format: "portfolio_performance_csv_file", text: PP_TRANSACTIONS_DE_CSV },
        { format: "portfolio_performance_csv_file", text: PP_TRANSACTIONS_EN_CSV },
      ]),
    );
  });

  it("records the holdings file verbatim as well, once per distinct export", async () => {
    const h = harness();
    const input = { ...base, ...h, csv: PP_HOLDINGS_DE_CSV, asOf: "2026-06-30" };
    const first = await runPortfolioPerformanceHoldingsImport(input);
    const again = await runPortfolioPerformanceHoldingsImport({ ...input, asOf: "2026-07-31" });
    expect(first.fileRawRecordId).toBeDefined();
    // Same bytes, different asOf: the file record is shared, the rows are not.
    expect(again.fileRawRecordId).toBe(first.fileRawRecordId);
    expect(fileRaws(h)).toHaveLength(1);
    expect(rowRaws(h)).toHaveLength(4);
  });
});

describe("runPortfolioPerformanceHoldingsImport asOf validation", () => {
  it.each([
    "2026-02-31",
    "31.12.2026",
    "2026-1-5",
    "2026-06-30T00:00:00Z",
    "",
  ])("rejects asOf %j before touching any store", async (asOf) => {
    const h = harness();
    await expect(
      runPortfolioPerformanceHoldingsImport({ ...base, ...h, csv: PP_HOLDINGS_DE_CSV, asOf }),
    ).rejects.toThrow(/asOf must be an ISO calendar date \(YYYY-MM-DD\)/);
    expect(h.raws).toEqual([]);
    expect(h.valuations.size).toBe(0);
    expect(h.accounts).toEqual([]);
    // Validation happens before the run is opened, so no run is recorded.
    expect(h.runEvents).toEqual([]);
  });

  it("accepts a leap day", async () => {
    const h = harness();
    const summary = await runPortfolioPerformanceHoldingsImport({
      ...base,
      ...h,
      csv: PP_HOLDINGS_DE_CSV,
      asOf: "2028-02-29",
    });
    expect(summary.valuationsCreated).toBe(2);
  });
});

describe("runPortfolioPerformanceHoldingsImport registration", () => {
  it("registers each securities account and security once per file", async () => {
    const h = harness();
    await runPortfolioPerformanceHoldingsImport({
      ...base,
      ...h,
      csv: PP_HOLDINGS_DE_CSV,
      asOf: "2026-06-30",
    });
    // Both positions sit in "Depot A"; it is registered once, as a securities account.
    expect(h.accounts).toEqual(["Depot A"]);
    expect(h.accountKinds.get("Depot A")).toBe("securities");
    expect(h.securities.sort()).toEqual(["isin:US0000000TEST", "isin:XS0000000001"]);
  });

  it("registers the default account for holdings without an account column", async () => {
    const h = harness();
    const csv = [
      "Name;ISIN;Marktwert;Währung",
      "Synthetic World ETF;XS0000000001;1.105,00;EUR",
      "Synthetic Inc;US0000000TEST;2.100,00;EUR",
    ].join("\n");
    await runPortfolioPerformanceHoldingsImport({
      ...base,
      ...h,
      csv,
      asOf: "2026-06-30",
      defaultAccountExternalId: "Depot X",
    });
    expect(h.accounts).toEqual(["Depot X"]);
    expect(h.accountKinds.get("Depot X")).toBe("securities");
    expect([...h.valuations.values()].map((v) => v.brokerAccountExternalId)).toEqual([
      "Depot X",
      "Depot X",
    ]);
  });

  it("registers no account when neither a column nor a default names one", async () => {
    const h = harness();
    const csv = "Name;ISIN;Marktwert;Währung\nSynthetic World ETF;XS0000000001;1.105,00;EUR";
    const summary = await runPortfolioPerformanceHoldingsImport({
      ...base,
      ...h,
      csv,
      asOf: "2026-06-30",
    });
    expect(summary.valuationsCreated).toBe(1);
    expect(h.accounts).toEqual([]);
    expect([...h.valuations.values()][0]?.brokerAccountExternalId).toBeUndefined();
    expect(h.securities).toEqual(["isin:XS0000000001"]);
  });
});
