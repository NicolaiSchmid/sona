import { createRequire } from "node:module";
import {
  type CashMovement,
  createRawSourceRecord,
  createValuationSnapshot,
  type PortfolioEvent,
  type RawSourceRecord,
  type SecurityTransaction,
} from "@sona/core";
import { describe, expect, it } from "vitest";
import { CORE_MIGRATIONS } from "../migrations/index.js";
import {
  applyMigrations,
  createSqliteDbClient,
  type DbClient,
  type SqliteDatabase,
} from "../runner.js";
import {
  createWorkspacePortfolioStore,
  type PersistedPortfolioEvent,
  SqlitePortfolioRepository,
} from "./portfolio.js";
import { SqliteRawRecordRepository } from "./raw-records.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

function createTestDatabase(): { db: DbClient; close: () => void } {
  const sqlite = new DatabaseSync(":memory:") as SqliteDatabase;
  sqlite.exec("PRAGMA foreign_keys = ON");
  const db = createSqliteDbClient(sqlite);
  applyMigrations(db, CORE_MIGRATIONS);
  for (const [ws, src] of [
    ["ws_1", "src_1"],
    ["ws_2", "src_2"],
  ] as const) {
    db.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)").run(
      ws,
      ws,
      "2026-01-01T00:00:00Z",
    );
    db.prepare(
      "INSERT INTO sources (id, workspace_id, kind, display_name, status, created_at) VALUES (?, ?, 'portfolio', ?, 'active', ?)",
    ).run(src, ws, src, "2026-01-01T00:00:00Z");
  }
  return { db, close: () => sqlite.close() };
}

function raw(id: string, workspaceId = "ws_1", sourceId = "src_1"): RawSourceRecord {
  return createRawSourceRecord({
    id,
    workspaceId,
    sourceId,
    externalId: id,
    recordType: "portfolio_event",
    payloadJson: { row: id },
    observedAt: "2026-08-01T00:00:00Z",
    createdAt: "2026-08-01T00:00:00Z",
  });
}

const SECURITY = { isin: "XS0000000001", wkn: "TEST01", ticker: "TST", name: "Synthetic ETF" };

function dividend(overrides: Partial<SecurityTransaction> = {}): SecurityTransaction {
  return {
    kind: "security_transaction",
    type: "dividend",
    externalId: "pp_div_0",
    brokerAccountExternalId: "Depot A",
    date: "2026-05-15",
    amount: { amount: "78.70", commodity: "EUR" },
    security: SECURITY,
    shares: "50",
    gross: { amount: "100.00", commodity: "USD" },
    exchangeRate: "1.08",
    fees: "0",
    taxes: "13.89",
    note: "Quartalsdividende",
    raw: { format: "portfolio_performance_csv", occurrence: 0, columns: {} },
    ...overrides,
  };
}

function deposit(overrides: Partial<CashMovement> = {}): CashMovement {
  return {
    kind: "cash_movement",
    type: "deposit",
    externalId: "pp_dep_0",
    brokerAccountExternalId: "Verrechnungskonto",
    date: "2026-03-01",
    amount: { amount: "2000.00", commodity: "EUR" },
    security: undefined,
    note: undefined,
    raw: { format: "portfolio_performance_csv", occurrence: 0, columns: {} },
    ...overrides,
  };
}

function snapshot(overrides: Partial<Parameters<typeof createValuationSnapshot>[0]> = {}) {
  return createValuationSnapshot({
    id: "val_1",
    workspaceId: "ws_1",
    sourceId: "src_1",
    brokerAccountExternalId: "Depot A",
    security: SECURITY,
    asOf: "2026-06-30",
    shares: "10",
    marketValue: { amount: "1105.00", commodity: "EUR" },
    valuationSource: "portfolio_performance",
    rawRecordId: undefined,
    createdAt: "2026-07-01T00:00:00Z",
    ...overrides,
  });
}

/** Strips persistence fields so a stored event can be compared to its input. */
function domainOf(event: PersistedPortfolioEvent): PortfolioEvent {
  const { workspaceId: _w, sourceId: _s, rawRecordId: _r, createdAt: _c, ...rest } = event;
  return rest;
}

describe("SqliteRawRecordRepository.append", () => {
  it("returns the stored record and the existing one on a duplicate payload", async () => {
    const { db, close } = createTestDatabase();
    try {
      const repo = new SqliteRawRecordRepository(db);
      const first = await repo.append(raw("raw_1"));
      const duplicate = await repo.append({ ...raw("raw_1"), id: "raw_dup" });
      expect(first.id).toBe("raw_1");
      expect(duplicate.id).toBe("raw_1");
      expect(await repo.getById("ws_1", "raw_dup")).toBeUndefined();
    } finally {
      close();
    }
  });
});

describe("SqlitePortfolioRepository", () => {
  it("round-trips security transactions and cash movements", async () => {
    const { db, close } = createTestDatabase();
    try {
      const raws = new SqliteRawRecordRepository(db);
      const repo = new SqlitePortfolioRepository(db);
      await raws.append(raw("raw_div"));
      await raws.append(raw("raw_dep"));

      expect(await repo.saveEvent("ws_1", "src_1", dividend(), { rawRecordId: "raw_div" })).toBe(
        "created",
      );
      expect(await repo.saveEvent("ws_1", "src_1", deposit(), { rawRecordId: "raw_dep" })).toBe(
        "created",
      );

      const events = await repo.listEvents("ws_1", "src_1");
      expect(events.map(domainOf)).toEqual([deposit(), dividend()]);
      expect(events.map((e) => e.rawRecordId)).toEqual(["raw_dep", "raw_div"]);
    } finally {
      close();
    }
  });

  it("is idempotent on external id and never overwrites an existing event", async () => {
    const { db, close } = createTestDatabase();
    try {
      const raws = new SqliteRawRecordRepository(db);
      const repo = new SqlitePortfolioRepository(db);
      await raws.append(raw("raw_1"));
      await raws.append(raw("raw_2"));

      await repo.saveEvent("ws_1", "src_1", deposit(), { rawRecordId: "raw_1" });
      // Same identity, different labels/note: a no-op re-import.
      const again = await repo.saveEvent(
        "ws_1",
        "src_1",
        deposit({ brokerAccountExternalId: "Konto (umbenannt)", note: "edited" }),
        { rawRecordId: "raw_2" },
      );
      expect(again).toBe("unchanged");
      // A caller reusing an external id for a different amount is a conflict,
      // never an overwrite.
      const clash = await repo.saveEvent(
        "ws_1",
        "src_1",
        deposit({ amount: { amount: "9999.00", commodity: "EUR" } }),
        { rawRecordId: "raw_2" },
      );
      expect(clash).toBe("conflict");
      const stored = await repo.getEvent("ws_1", "src_1", "pp_dep_0");
      expect(stored?.amount.amount).toBe("2000.00");
      expect(stored?.rawRecordId).toBe("raw_1");
    } finally {
      close();
    }
  });

  it("upserts broker accounts and securities without duplicates", async () => {
    const { db, close } = createTestDatabase();
    try {
      const repo = new SqlitePortfolioRepository(db);
      const account = {
        externalId: "Depot A",
        name: "Depot A",
        kind: "securities",
        currency: "EUR",
      } as const;
      await repo.saveBrokerAccount("ws_1", "src_1", account);
      await repo.saveBrokerAccount("ws_1", "src_1", { ...account, name: "Depot A (renamed)" });
      const accounts = await repo.listBrokerAccounts("ws_1", "src_1");
      expect(accounts.map((a) => a.name)).toEqual(["Depot A (renamed)"]);

      await repo.saveSecurity("ws_1", { ...SECURITY, key: "isin:XS0000000001", ticker: undefined });
      await repo.saveSecurity("ws_1", {
        isin: SECURITY.isin,
        wkn: undefined,
        ticker: "TST",
        name: undefined,
        key: "isin:XS0000000001",
      });
      const securities = await repo.listSecurities("ws_1");
      expect(securities).toHaveLength(1);
      expect(securities[0]).toMatchObject({ isin: "XS0000000001", wkn: "TEST01", ticker: "TST" });
    } finally {
      close();
    }
  });

  it("isolates workspaces: no cross-workspace reads or raw-record links", async () => {
    const { db, close } = createTestDatabase();
    try {
      const raws = new SqliteRawRecordRepository(db);
      const repo = new SqlitePortfolioRepository(db);
      await raws.append(raw("raw_ws1"));
      await raws.append(raw("raw_ws2", "ws_2", "src_2"));
      await repo.saveEvent("ws_1", "src_1", deposit(), { rawRecordId: "raw_ws1" });

      expect(await repo.listEvents("ws_2", "src_2")).toEqual([]);
      expect(await repo.getEvent("ws_2", "src_1", "pp_dep_0")).toBeUndefined();
      await expect(
        repo.saveEvent("ws_2", "src_2", deposit(), { rawRecordId: "raw_ws1" }),
      ).rejects.toThrow(/raw record not found in workspace/);
      await expect(
        repo.saveValuation("ws_2", "src_2", snapshot({ workspaceId: "ws_1" })),
      ).rejects.toThrow(/mismatch/);
      await expect(
        repo.saveValuation("ws_1", "src_1", snapshot({ rawRecordId: "raw_ws2" })),
      ).rejects.toThrow(/raw record not found in workspace/);
    } finally {
      close();
    }
  });

  it("appends valuations once per account/security/date and never updates them", async () => {
    const { db, close } = createTestDatabase();
    try {
      const repo = new SqlitePortfolioRepository(db);
      expect(await repo.saveValuation("ws_1", "src_1", snapshot())).toBe("created");
      expect(await repo.saveValuation("ws_1", "src_1", snapshot({ id: "val_same" }))).toBe(
        "unchanged",
      );
      // A differing snapshot for an occupied point is neither stored nor
      // silently swallowed: the caller learns it conflicts.
      expect(
        await repo.saveValuation(
          "ws_1",
          "src_1",
          snapshot({ id: "val_dup", marketValue: { amount: "1.00", commodity: "EUR" } }),
        ),
      ).toBe("conflict");
      expect(
        await repo.saveValuation("ws_1", "src_1", snapshot({ id: "val_shares", shares: "11" })),
      ).toBe("conflict");
      expect(
        await repo.saveValuation("ws_1", "src_1", snapshot({ id: "val_2", asOf: "2026-07-31" })),
      ).toBe("created");
      expect(
        await repo.saveValuation(
          "ws_1",
          "src_1",
          snapshot({ id: "val_acct", brokerAccountExternalId: undefined, security: undefined }),
        ),
      ).toBe("created");

      const stored = await repo.listValuations("ws_1", "src_1");
      expect(stored.map((v) => [v.id, v.asOf, v.marketValue.amount])).toEqual([
        ["val_acct", "2026-06-30", "1105.00"],
        ["val_1", "2026-06-30", "1105.00"],
        ["val_2", "2026-07-31", "1105.00"],
      ]);
      expect(stored[0]?.brokerAccountExternalId).toBeUndefined();
      expect(stored[0]?.security).toBeUndefined();
      expect(stored[1]?.security).toEqual(SECURITY);
    } finally {
      close();
    }
  });

  it("exposes a workspace-bound store that rejects other sources", async () => {
    const { db, close } = createTestDatabase();
    try {
      const raws = new SqliteRawRecordRepository(db);
      const repo = new SqlitePortfolioRepository(db);
      const store = createWorkspacePortfolioStore(repo, "ws_1", "src_1");
      await raws.append(raw("raw_1"));

      await store.saveBrokerAccount({ externalId: "K", name: "K", kind: "cash", currency: "EUR" });
      await store.saveSecurity({ ...SECURITY, key: "isin:XS0000000001" });
      expect(await store.saveEvent(deposit(), { rawRecordId: "raw_1" })).toBe("created");
      expect(await store.saveValuation(snapshot())).toBe("created");
      await expect(store.saveValuation(snapshot({ id: "v", sourceId: "src_2" }))).rejects.toThrow(
        /source mismatch/,
      );
    } finally {
      close();
    }
  });

  it("scopes events to their source within a workspace", async () => {
    const { db, close } = createTestDatabase();
    try {
      db.prepare(
        "INSERT INTO sources (id, workspace_id, kind, display_name, status, created_at) VALUES ('src_other', 'ws_1', 'portfolio', 'other', 'active', '2026-01-01T00:00:00Z')",
      ).run();
      const raws = new SqliteRawRecordRepository(db);
      const repo = new SqlitePortfolioRepository(db);
      await raws.append(raw("raw_1"));
      await raws.append(raw("raw_other", "ws_1", "src_other"));
      await repo.saveEvent("ws_1", "src_1", deposit(), { rawRecordId: "raw_1" });

      expect(await repo.getEvent("ws_1", "src_other", "pp_dep_0")).toBeUndefined();
      expect(await repo.listEvents("ws_1", "src_other")).toEqual([]);
      // The same external id is a distinct event under another source.
      expect(
        await repo.saveEvent("ws_1", "src_other", deposit(), { rawRecordId: "raw_other" }),
      ).toBe("created");
      expect((await repo.getEvent("ws_1", "src_other", "pp_dep_0"))?.rawRecordId).toBe("raw_other");
      expect(await repo.listEvents("ws_1", "src_1")).toHaveLength(1);
    } finally {
      close();
    }
  });

  it("rejects a valuation whose raw record belongs to another source in the workspace", async () => {
    const { db, close } = createTestDatabase();
    try {
      db.prepare(
        "INSERT INTO sources (id, workspace_id, kind, display_name, status, created_at) VALUES ('src_other', 'ws_1', 'portfolio', 'other', 'active', '2026-01-01T00:00:00Z')",
      ).run();
      const raws = new SqliteRawRecordRepository(db);
      const repo = new SqlitePortfolioRepository(db);
      await raws.append(raw("raw_other", "ws_1", "src_other"));
      await expect(
        repo.saveValuation("ws_1", "src_1", snapshot({ rawRecordId: "raw_other" })),
      ).rejects.toThrow(/belongs to another source/);
      expect(await repo.listValuations("ws_1", "src_1")).toEqual([]);
    } finally {
      close();
    }
  });

  it("lists events ordered by date, then external id", async () => {
    const { db, close } = createTestDatabase();
    try {
      const raws = new SqliteRawRecordRepository(db);
      const repo = new SqlitePortfolioRepository(db);
      const inserts: Array<[string, string]> = [
        ["pp_b", "2026-03-01"],
        ["pp_a", "2026-03-01"],
        ["pp_z", "2026-01-15"],
      ];
      for (const [externalId, date] of inserts) {
        await raws.append(raw(`raw_${externalId}`));
        await repo.saveEvent("ws_1", "src_1", deposit({ externalId, date }), {
          rawRecordId: `raw_${externalId}`,
        });
      }
      const events = await repo.listEvents("ws_1", "src_1");
      expect(events.map((e) => e.externalId)).toEqual(["pp_z", "pp_a", "pp_b"]);
    } finally {
      close();
    }
  });

  it("round-trips a cash movement with a security and a trade without optional fields", async () => {
    const { db, close } = createTestDatabase();
    try {
      const raws = new SqliteRawRecordRepository(db);
      const repo = new SqlitePortfolioRepository(db);
      await raws.append(raw("raw_fee"));
      await raws.append(raw("raw_buy"));
      const fee = deposit({
        type: "fee",
        externalId: "pp_fee_0",
        amount: { amount: "-1.00", commodity: "EUR" },
        security: { isin: undefined, wkn: undefined, ticker: undefined, name: "Synthetic ETF" },
        note: "Depotgebühr",
      });
      const buy = dividend({
        type: "buy",
        externalId: "pp_buy_0",
        amount: { amount: "-1005.00", commodity: "EUR" },
        shares: undefined,
        gross: undefined,
        exchangeRate: undefined,
        fees: "5.00",
        taxes: "0",
        note: undefined,
      });
      await repo.saveEvent("ws_1", "src_1", fee, { rawRecordId: "raw_fee" });
      await repo.saveEvent("ws_1", "src_1", buy, { rawRecordId: "raw_buy" });

      const events = await repo.listEvents("ws_1", "src_1");
      expect(events.map(domainOf)).toEqual([deposit({ ...fee }), buy]);
      const storedFee = events.find((e) => e.externalId === "pp_fee_0");
      expect(storedFee?.security?.name).toBe("Synthetic ETF");
    } finally {
      close();
    }
  });

  it("fills in missing security identifiers on upsert without erasing known ones", async () => {
    const { db, close } = createTestDatabase();
    try {
      const repo = new SqlitePortfolioRepository(db);
      await repo.saveSecurity("ws_1", {
        key: "wkn:TEST01",
        isin: undefined,
        wkn: "TEST01",
        ticker: undefined,
        name: "Synthetic Fund",
      });
      await repo.saveSecurity("ws_1", {
        key: "wkn:TEST01",
        isin: "XS0000000001",
        wkn: "TEST01",
        ticker: undefined,
        name: undefined,
      });
      const [stored] = await repo.listSecurities("ws_1");
      expect(stored).toMatchObject({
        key: "wkn:TEST01",
        isin: "XS0000000001",
        wkn: "TEST01",
        ticker: undefined,
        name: "Synthetic Fund",
      });
      // Securities are per workspace: ws_2 sees nothing.
      expect(await repo.listSecurities("ws_2")).toEqual([]);
    } finally {
      close();
    }
  });

  it("lets two workspaces hold the same security without colliding", async () => {
    const { db, close } = createTestDatabase();
    try {
      const repo = new SqlitePortfolioRepository(db);
      const security = { ...SECURITY, key: "isin:XS0000000001" };
      await repo.saveSecurity("ws_1", security);
      await expect(repo.saveSecurity("ws_2", security)).resolves.toBeUndefined();
      expect((await repo.listSecurities("ws_1")).map((s) => s.key)).toEqual(["isin:XS0000000001"]);
      expect((await repo.listSecurities("ws_2")).map((s) => s.key)).toEqual(["isin:XS0000000001"]);
      const ids = new Set(
        [...(await repo.listSecurities("ws_1")), ...(await repo.listSecurities("ws_2"))].map(
          (s) => s.id,
        ),
      );
      expect(ids.size).toBe(2);
    } finally {
      close();
    }
  });
});

describe("SqlitePortfolioRepository.saveEvent conflicts", () => {
  it("reports a conflict only when both sides define different gross/FX details", async () => {
    const { db, close } = createTestDatabase();
    try {
      const raws = new SqliteRawRecordRepository(db);
      const repo = new SqlitePortfolioRepository(db);
      await raws.append(raw("raw_1"));
      await raws.append(raw("raw_2"));
      const link = { rawRecordId: "raw_2" };
      expect(await repo.saveEvent("ws_1", "src_1", dividend(), { rawRecordId: "raw_1" })).toBe(
        "created",
      );

      // Equal details: the re-export is the same event.
      expect(await repo.saveEvent("ws_1", "src_1", dividend(), link)).toBe("unchanged");
      // Different defined details on either side: a corrected re-export.
      expect(
        await repo.saveEvent(
          "ws_1",
          "src_1",
          dividend({ gross: { amount: "101.00", commodity: "USD" } }),
          link,
        ),
      ).toBe("conflict");
      expect(
        await repo.saveEvent(
          "ws_1",
          "src_1",
          dividend({ gross: { amount: "100.00", commodity: "CHF" } }),
          link,
        ),
      ).toBe("conflict");
      expect(await repo.saveEvent("ws_1", "src_1", dividend({ exchangeRate: "1.10" }), link)).toBe(
        "conflict",
      );
      // One side undefined: a view that omits the columns is compatible.
      expect(
        await repo.saveEvent(
          "ws_1",
          "src_1",
          dividend({ gross: undefined, exchangeRate: undefined }),
          link,
        ),
      ).toBe("unchanged");

      // The first event stands untouched regardless of the outcome.
      const stored = await repo.getEvent("ws_1", "src_1", "pp_div_0");
      expect(stored === undefined ? undefined : domainOf(stored)).toEqual(dividend());
      expect(stored?.rawRecordId).toBe("raw_1");
      expect(await repo.listEvents("ws_1", "src_1")).toHaveLength(1);
    } finally {
      close();
    }
  });

  it("treats a later export that adds gross details to a bare event as unchanged", async () => {
    const { db, close } = createTestDatabase();
    try {
      const raws = new SqliteRawRecordRepository(db);
      const repo = new SqlitePortfolioRepository(db);
      await raws.append(raw("raw_1"));
      const bare = dividend({ gross: undefined, exchangeRate: undefined });
      expect(await repo.saveEvent("ws_1", "src_1", bare, { rawRecordId: "raw_1" })).toBe("created");
      expect(await repo.saveEvent("ws_1", "src_1", dividend(), { rawRecordId: "raw_1" })).toBe(
        "unchanged",
      );
      // Never updated: the stored event still has no gross details.
      const stored = await repo.getEvent("ws_1", "src_1", "pp_div_0");
      expect(stored === undefined ? undefined : domainOf(stored)).toEqual(bare);
    } finally {
      close();
    }
  });

  it("compares core fields for cash movements too, ignoring labels and notes", async () => {
    const { db, close } = createTestDatabase();
    try {
      const raws = new SqliteRawRecordRepository(db);
      const repo = new SqlitePortfolioRepository(db);
      await raws.append(raw("raw_1"));
      await repo.saveEvent("ws_1", "src_1", deposit(), { rawRecordId: "raw_1" });
      expect(
        await repo.saveEvent(
          "ws_1",
          "src_1",
          deposit({ note: "edited", brokerAccountExternalId: "Other label" }),
          { rawRecordId: "raw_1" },
        ),
      ).toBe("unchanged");
      for (const change of [
        { amount: { amount: "2000.000", commodity: "USD" } },
        { date: "2026-03-02" },
        { type: "withdrawal" as const, amount: { amount: "-2000.00", commodity: "EUR" } },
      ]) {
        expect(
          await repo.saveEvent("ws_1", "src_1", deposit(change), { rawRecordId: "raw_1" }),
          JSON.stringify(change),
        ).toBe("conflict");
      }
    } finally {
      close();
    }
  });

  it("inserts exactly one row for identical repeated saves", async () => {
    const { db, close } = createTestDatabase();
    try {
      const raws = new SqliteRawRecordRepository(db);
      const repo = new SqlitePortfolioRepository(db);
      await raws.append(raw("raw_1"));
      const results = [
        await repo.saveEvent("ws_1", "src_1", dividend(), { rawRecordId: "raw_1" }),
        await repo.saveEvent("ws_1", "src_1", dividend(), { rawRecordId: "raw_1" }),
      ];
      expect(results).toEqual(["created", "unchanged"]);
      const count = db
        .prepare(
          "SELECT COUNT(*) AS n FROM portfolio_events WHERE workspace_id = ? AND source_id = ? AND external_id = ?",
        )
        .get("ws_1", "src_1", "pp_div_0") as { n: number } | undefined;
      expect(count?.n).toBe(1);
      expect(await repo.listEvents("ws_1", "src_1")).toHaveLength(1);
    } finally {
      close();
    }
  });

  it("rejects an event whose raw record belongs to another source in the workspace", async () => {
    const { db, close } = createTestDatabase();
    try {
      db.prepare(
        "INSERT INTO sources (id, workspace_id, kind, display_name, status, created_at) VALUES ('src_other', 'ws_1', 'portfolio', 'other', 'active', '2026-01-01T00:00:00Z')",
      ).run();
      const raws = new SqliteRawRecordRepository(db);
      const repo = new SqlitePortfolioRepository(db);
      await raws.append(raw("raw_other", "ws_1", "src_other"));
      await expect(
        repo.saveEvent("ws_1", "src_1", deposit(), { rawRecordId: "raw_other" }),
      ).rejects.toThrow(/belongs to another source/);
      expect(await repo.listEvents("ws_1", "src_1")).toEqual([]);
      expect(await repo.listEvents("ws_1", "src_other")).toEqual([]);
    } finally {
      close();
    }
  });
});

describe("SqlitePortfolioRepository.saveValuation conflicts", () => {
  it("reports a conflict for a differing currency or missing shares at an occupied point", async () => {
    const { db, close } = createTestDatabase();
    try {
      const repo = new SqlitePortfolioRepository(db);
      expect(await repo.saveValuation("ws_1", "src_1", snapshot())).toBe("created");
      expect(
        await repo.saveValuation(
          "ws_1",
          "src_1",
          snapshot({ id: "val_usd", marketValue: { amount: "1105.00", commodity: "USD" } }),
        ),
      ).toBe("conflict");
      expect(
        await repo.saveValuation(
          "ws_1",
          "src_1",
          snapshot({ id: "val_noshares", shares: undefined }),
        ),
      ).toBe("conflict");
      const stored = await repo.listValuations("ws_1", "src_1");
      expect(stored.map((v) => [v.id, v.marketValue.commodity, v.shares])).toEqual([
        ["val_1", "EUR", "10"],
      ]);
    } finally {
      close();
    }
  });
});

describe("SqlitePortfolioRepository.saveBrokerAccount upsert", () => {
  it("keeps the first kind and a set currency; only a missing currency is filled later", async () => {
    const { db, close } = createTestDatabase();
    try {
      const repo = new SqlitePortfolioRepository(db);
      await repo.saveBrokerAccount("ws_1", "src_1", {
        externalId: "Konto",
        name: "Konto",
        kind: "cash",
        currency: "EUR",
      });
      // A later export view that treats the same account as a USD securities
      // account must not flip what the user already has on record.
      await repo.saveBrokerAccount("ws_1", "src_1", {
        externalId: "Konto",
        name: "Konto (renamed)",
        kind: "securities",
        currency: "USD",
      });
      expect(
        (await repo.listBrokerAccounts("ws_1", "src_1")).map((a) => [a.name, a.kind, a.currency]),
      ).toEqual([["Konto (renamed)", "cash", "EUR"]]);

      await repo.saveBrokerAccount("ws_1", "src_1", {
        externalId: "Depot",
        name: "Depot",
        kind: "securities",
        currency: undefined,
      });
      await repo.saveBrokerAccount("ws_1", "src_1", {
        externalId: "Depot",
        name: "Depot",
        kind: "securities",
        currency: "CHF",
      });
      const depot = (await repo.listBrokerAccounts("ws_1", "src_1")).find(
        (a) => a.externalId === "Depot",
      );
      expect(depot?.currency).toBe("CHF");
      expect(depot?.kind).toBe("securities");
    } finally {
      close();
    }
  });
});

describe("SqlitePortfolioRepository numeric conflict comparison", () => {
  it("compares event gross/FX details numerically, not as strings", async () => {
    const { db, close } = createTestDatabase();
    try {
      const raws = new SqliteRawRecordRepository(db);
      const repo = new SqlitePortfolioRepository(db);
      await raws.append(raw("raw_1"));
      const link = { rawRecordId: "raw_1" };
      expect(await repo.saveEvent("ws_1", "src_1", dividend(), link)).toBe("created");
      // Same rate at a different scale: an export in another number format.
      expect(await repo.saveEvent("ws_1", "src_1", dividend({ exchangeRate: "1.080" }), link)).toBe(
        "unchanged",
      );
      expect(
        await repo.saveEvent(
          "ws_1",
          "src_1",
          dividend({ gross: { amount: "100.000", commodity: "USD" } }),
          link,
        ),
      ).toBe("unchanged");
      // A genuinely different value is still a conflict.
      expect(await repo.saveEvent("ws_1", "src_1", dividend({ exchangeRate: "1.09" }), link)).toBe(
        "conflict",
      );
      expect(await repo.listEvents("ws_1", "src_1")).toHaveLength(1);
    } finally {
      close();
    }
  });

  it("compares valuation shares and market value numerically and treats shares presence as identity", async () => {
    const { db, close } = createTestDatabase();
    try {
      const repo = new SqlitePortfolioRepository(db);
      expect(await repo.saveValuation("ws_1", "src_1", snapshot())).toBe("created");
      expect(
        await repo.saveValuation("ws_1", "src_1", snapshot({ id: "v_scale", shares: "10.0" })),
      ).toBe("unchanged");
      expect(
        await repo.saveValuation(
          "ws_1",
          "src_1",
          snapshot({ id: "v_mv", marketValue: { amount: "1105.000", commodity: "EUR" } }),
        ),
      ).toBe("unchanged");
      expect(
        await repo.saveValuation("ws_1", "src_1", snapshot({ id: "v_diff", shares: "10.5" })),
      ).toBe("conflict");
      expect(
        await repo.saveValuation(
          "ws_1",
          "src_1",
          snapshot({ id: "v_mv_diff", marketValue: { amount: "1105.01", commodity: "EUR" } }),
        ),
      ).toBe("conflict");

      // Stored without shares, re-exported with shares: a different snapshot.
      const bare = snapshot({
        id: "v_bare",
        brokerAccountExternalId: "Depot B",
        shares: undefined,
      });
      expect(await repo.saveValuation("ws_1", "src_1", bare)).toBe("created");
      expect(
        await repo.saveValuation(
          "ws_1",
          "src_1",
          snapshot({ id: "v_bare_shares", brokerAccountExternalId: "Depot B", shares: "10" }),
        ),
      ).toBe("conflict");

      expect((await repo.listValuations("ws_1", "src_1")).map((v) => v.id)).toEqual([
        "val_1",
        "v_bare",
      ]);
    } finally {
      close();
    }
  });
});
