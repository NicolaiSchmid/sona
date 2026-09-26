import { createRequire } from "node:module";
import {
  type Asset,
  type AssetDisposalEvent,
  type AssetImprovementEvent,
  computeDepreciationSchedule,
  type DepreciationScheduleConfig,
  planDepreciationDrafts,
} from "@sona/core";
import { describe, expect, it } from "vitest";
import { CORE_MIGRATIONS } from "../migrations/index.js";
import {
  applyMigrations,
  createSqliteDbClient,
  type DbClient,
  type SqliteDatabase,
} from "../runner.js";
import { type RecordedDepreciationEntry, SqliteAssetRepository } from "./assets.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

function createTestDatabase(): { db: DbClient; close: () => void } {
  const sqlite = new DatabaseSync(":memory:") as SqliteDatabase;
  sqlite.exec("PRAGMA foreign_keys = ON");
  const db = createSqliteDbClient(sqlite);
  applyMigrations(db, CORE_MIGRATIONS);
  for (const workspaceId of ["ws_1", "ws_2"]) {
    db.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)").run(
      workspaceId,
      `Workspace ${workspaceId}`,
      "2026-01-01T00:00:00Z",
    );
  }
  return { db, close: () => sqlite.close() };
}

const CREATED_AT = "2026-01-01T00:00:00Z";

function property(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "asset_flat",
    workspaceId: "ws_1",
    kind: "real_estate",
    name: "Synthetic flat",
    commodity: "EUR",
    acquiredOn: "2024-07-15",
    components: [
      {
        id: "cmp_building",
        role: "building",
        label: "Building",
        cost: { amount: "300000.00", commodity: "EUR" },
        depreciable: true,
      },
      {
        id: "cmp_land",
        role: "land",
        label: "Land",
        cost: { amount: "100000.00", commodity: "EUR" },
        depreciable: false,
      },
    ],
    acquisitionSideCosts: [
      {
        id: "sc_notary",
        label: "Notary",
        amount: { amount: "24000.00", commodity: "EUR" },
        evidenceDocumentIds: ["doc_notary"],
      },
    ],
    evidenceDocumentIds: ["doc_contract"],
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function config(overrides: Partial<DepreciationScheduleConfig> = {}): DepreciationScheduleConfig {
  return {
    id: "cfg_v1",
    workspaceId: "ws_1",
    assetId: "asset_flat",
    version: 1,
    method: { kind: "linear_percentage", annualRatePercent: "2" },
    proRataTemporis: true,
    expenseAccount: "Expenses:RealEstate:Depreciation:Flat",
    accumulatedDepreciationAccount: "Assets:RealEstate:Flat:AccumulatedDepreciation",
    createdAt: CREATED_AT,
    ...overrides,
  };
}

const improvement: AssetImprovementEvent = {
  kind: "improvement",
  id: "evt_bath",
  workspaceId: "ws_1",
  assetId: "asset_flat",
  componentId: "cmp_building",
  occurredOn: "2026-03-01",
  description: "Bathroom",
  amount: { amount: "50000.00", commodity: "EUR" },
  evidenceDocumentIds: ["doc_bath"],
  createdAt: "2026-03-05T00:00:00Z",
};

const disposal: AssetDisposalEvent = {
  kind: "disposal",
  id: "evt_sale",
  workspaceId: "ws_1",
  assetId: "asset_flat",
  occurredOn: "2030-06-30",
  description: "Sold",
  proceeds: { amount: "500000.00", commodity: "EUR" },
  evidenceDocumentIds: ["doc_sale"],
  createdAt: "2030-07-01T00:00:00Z",
};

describe("SqliteAssetRepository", () => {
  it("round-trips an asset with components, side costs, and evidence", async () => {
    const { db, close } = createTestDatabase();
    try {
      const repo = new SqliteAssetRepository(db);
      await repo.create(property());
      const loaded = await repo.getById("ws_1", "asset_flat");
      expect(loaded).toEqual(property());
      expect(await repo.list("ws_1")).toEqual([property()]);
      await expect(repo.create(property())).rejects.toThrow(/already exists/);
    } finally {
      close();
    }
  });

  it("rejects invalid assets at the write boundary", async () => {
    const { db, close } = createTestDatabase();
    try {
      const repo = new SqliteAssetRepository(db);
      await expect(
        repo.create(
          property({
            components: [
              {
                id: "cmp_usd",
                role: "building",
                label: "Mismatch",
                cost: { amount: "1.00", commodity: "USD" },
                depreciable: true,
              },
            ],
          }),
        ),
      ).rejects.toThrow();
      expect(await repo.list("ws_1")).toEqual([]);
    } finally {
      close();
    }
  });

  it("isolates assets, events, configs, and entries by workspace", async () => {
    const { db, close } = createTestDatabase();
    try {
      const repo = new SqliteAssetRepository(db);
      await repo.create(property());
      await repo.create(
        property({
          id: "asset_other",
          workspaceId: "ws_2",
          name: "Other",
        }),
      );
      await repo.appendEvent(improvement);
      await repo.saveScheduleConfig(config());
      await repo.recordDepreciationEntry(entry(2024));

      expect(await repo.getById("ws_2", "asset_flat")).toBeUndefined();
      expect((await repo.list("ws_2")).map((a) => a.id)).toEqual(["asset_other"]);
      expect(await repo.listEvents("ws_2", "asset_flat")).toEqual([]);
      expect(await repo.getScheduleConfig("ws_2", "cfg_v1")).toBeUndefined();
      expect(await repo.getLatestScheduleConfig("ws_2", "asset_flat")).toBeUndefined();
      expect(await repo.listDepreciationEntries("ws_2", "asset_flat")).toEqual([]);

      // Writes that point at another workspace's asset are refused.
      await expect(
        repo.appendEvent({ ...improvement, id: "evt_x", workspaceId: "ws_2" }),
      ).rejects.toThrow(/not found in workspace/);
      await expect(
        repo.saveScheduleConfig(config({ id: "cfg_x", workspaceId: "ws_2" })),
      ).rejects.toThrow(/not found in workspace/);
    } finally {
      close();
    }
  });

  it("keeps asset history append-only and ordered", async () => {
    const { db, close } = createTestDatabase();
    try {
      const repo = new SqliteAssetRepository(db);
      await repo.create(property());
      await repo.appendEvent(disposal);
      await repo.appendEvent(improvement);
      await expect(repo.appendEvent(improvement)).rejects.toThrow(/append-only/);
      const events = await repo.listEvents("ws_1", "asset_flat");
      expect(events).toEqual([improvement, disposal]);
      // Improvements must reference a component of the same workspace/asset.
      await expect(
        repo.appendEvent({ ...improvement, id: "evt_bad", componentId: "cmp_missing" }),
      ).rejects.toThrow();
    } finally {
      close();
    }
  });

  it("round-trips a retraction and rejects one that points outside the asset", async () => {
    const { db, close } = createTestDatabase();
    try {
      const repo = new SqliteAssetRepository(db);
      await repo.create(property());
      await repo.appendEvent(improvement);
      const retraction = {
        kind: "retraction" as const,
        id: "evt_retract",
        workspaceId: "ws_1",
        assetId: "asset_flat",
        retractsEventId: "evt_bath",
        occurredOn: "2026-04-01",
        description: "Reclassified as maintenance",
        evidenceDocumentIds: [],
        createdAt: "2026-04-01T00:00:00Z",
      };
      await repo.appendEvent(retraction);
      expect(await repo.listEvents("ws_1", "asset_flat")).toEqual([improvement, retraction]);
      // The foreign key refuses a retraction of an event that does not exist in the workspace.
      await expect(
        repo.appendEvent({ ...retraction, id: "evt_dangling", retractsEventId: "evt_missing" }),
      ).rejects.toThrow(/FOREIGN KEY/i);
    } finally {
      close();
    }
  });

  it("refuses a depreciation entry whose config belongs to a different asset", async () => {
    const { db, close } = createTestDatabase();
    try {
      const repo = new SqliteAssetRepository(db);
      await repo.create(property());
      await repo.create(property({ id: "asset_b", name: "B" }));
      await repo.saveScheduleConfig(config());
      await repo.saveScheduleConfig(config({ id: "cfg_b", assetId: "asset_b" }));
      await expect(
        repo.recordDepreciationEntry({ ...entry(2024), configId: "cfg_b" }),
      ).rejects.toThrow(/FOREIGN KEY/i);
      expect(await repo.listDepreciationEntries("ws_1", "asset_flat")).toEqual([]);
    } finally {
      close();
    }
  });

  it("appends schedule config versions and returns the latest", async () => {
    const { db, close } = createTestDatabase();
    try {
      const repo = new SqliteAssetRepository(db);
      await repo.create(property());
      await repo.saveScheduleConfig(config());
      const v2 = config({
        id: "cfg_v2",
        version: 2,
        method: { kind: "linear_percentage", annualRatePercent: "2.5" },
        residualValue: { amount: "1.00", commodity: "EUR" },
        roundingScale: 2,
      });
      await repo.saveScheduleConfig(v2);
      await expect(repo.saveScheduleConfig(config({ id: "cfg_dup" }))).rejects.toThrow(
        /must exceed latest version/,
      );
      expect(await repo.getLatestScheduleConfig("ws_1", "asset_flat")).toEqual(v2);
      expect(await repo.getScheduleConfig("ws_1", "cfg_v1")).toEqual(config());
      expect((await repo.listScheduleConfigs("ws_1", "asset_flat")).map((c) => c.version)).toEqual([
        1, 2,
      ]);
    } finally {
      close();
    }
  });

  it("records depreciation entries insert-only, idempotent by transaction id", async () => {
    const { db, close } = createTestDatabase();
    try {
      const repo = new SqliteAssetRepository(db);
      await repo.create(property());
      await repo.saveScheduleConfig(config());
      const first = await repo.recordDepreciationEntry(entry(2024));
      // Same transaction again: the stored entry wins, nothing is rewritten.
      const again = await repo.recordDepreciationEntry({
        ...entry(2024),
        id: "entry_dup",
        amount: { amount: "999.00", commodity: "EUR" },
      });
      expect(first).toEqual(entry(2024));
      expect(again).toEqual(entry(2024));
      // A replacement transaction for the same year is a new history row.
      await repo.recordDepreciationEntry({
        ...entry(2024),
        id: "entry_2024_r1",
        transactionId: "depr:asset_flat:v1:2024:r1",
        createdAt: "2026-02-01T00:00:00Z",
      });
      await repo.recordDepreciationEntry(entry(2025));
      expect(
        (await repo.listDepreciationEntries("ws_1", "asset_flat")).map((e) => e.transactionId),
      ).toEqual([
        "depr:asset_flat:v1:2024",
        "depr:asset_flat:v1:2024:r1",
        "depr:asset_flat:v1:2025",
      ]);
      expect(
        await repo.getDepreciationEntryByTransaction("ws_1", "depr:asset_flat:v1:2025"),
      ).toEqual(entry(2025));
      expect(
        await repo.getDepreciationEntryByTransaction("ws_2", "depr:asset_flat:v1:2025"),
      ).toBeUndefined();
    } finally {
      close();
    }
  });

  it("feeds persisted state into schedule computation and idempotent planning", async () => {
    const { db, close } = createTestDatabase();
    try {
      const repo = new SqliteAssetRepository(db);
      await repo.create(property());
      await repo.saveScheduleConfig(config());
      await repo.appendEvent(improvement);
      await repo.recordDepreciationEntry(entry(2024));

      const asset = await repo.getById("ws_1", "asset_flat");
      const latest = await repo.getLatestScheduleConfig("ws_1", "asset_flat");
      if (asset === undefined || latest === undefined) {
        throw new Error("expected persisted asset and config");
      }
      const schedule = computeDepreciationSchedule({
        asset,
        config: latest,
        events: await repo.listEvents("ws_1", "asset_flat"),
      });
      const recorded = await repo.listDepreciationEntries("ws_1", "asset_flat");
      const plan = planDepreciationDrafts({
        asset,
        config: latest,
        schedule,
        recorded: recorded.map((e) => ({ ...e, reviewState: "user_reviewed" as const })),
        throughYear: 2026,
        createdAt: CREATED_AT,
      });
      expect(plan.skipped.map((s) => s.year)).toEqual([2024]);
      expect(plan.create.map((d) => d.year)).toEqual([2025, 2026]);
      expect(plan.create.map((d) => d.transaction.postings[0]?.amount.amount)).toEqual([
        "6360.00",
        "7360.00",
      ]);
    } finally {
      close();
    }
  });

  it("rejects an improvement whose component belongs to another workspace at the database", async () => {
    const { db, close } = createTestDatabase();
    try {
      const repo = new SqliteAssetRepository(db);
      await repo.create(property());
      await repo.create(
        property({
          id: "asset_other",
          workspaceId: "ws_2",
        }),
      );
      // ws_1 has a component ws_2's asset does not; the repository check and the
      // composite (workspace_id, asset_id, component_id) foreign key both refuse.
      await repo.create(
        property({
          id: "asset_third",
          components: [
            {
              id: "cmp_only_ws1",
              role: "whole_asset",
              label: "Third",
              cost: { amount: "1000.00", commodity: "EUR" },
              depreciable: true,
            },
          ],
        }),
      );
      await expect(
        repo.appendEvent({
          ...improvement,
          id: "evt_cross",
          workspaceId: "ws_2",
          assetId: "asset_other",
          componentId: "cmp_only_ws1",
        }),
      ).rejects.toThrow(/does not belong to asset/);
      // Same workspace, wrong asset.
      await expect(
        repo.appendEvent({ ...improvement, id: "evt_wrong_asset", componentId: "cmp_only_ws1" }),
      ).rejects.toThrow(/does not belong to asset/);
      expect(await repo.listEvents("ws_2", "asset_other")).toEqual([]);
      expect(await repo.listEvents("ws_1", "asset_flat")).toEqual([]);
    } finally {
      close();
    }
  });

  it("round-trips a disposal without proceeds", async () => {
    const { db, close } = createTestDatabase();
    try {
      const repo = new SqliteAssetRepository(db);
      await repo.create(property());
      const { proceeds: _omitted, ...scrapped } = disposal;
      const withoutProceeds: AssetDisposalEvent = { ...scrapped, id: "evt_scrapped" };
      await repo.appendEvent(withoutProceeds);
      const [loaded] = await repo.listEvents("ws_1", "asset_flat");
      expect(loaded).toEqual(withoutProceeds);
      if (loaded?.kind !== "disposal") {
        throw new Error("expected a disposal");
      }
      expect(loaded.proceeds).toBeUndefined();
    } finally {
      close();
    }
  });

  it("round-trips a rounding scale of zero and a residual value on the config", async () => {
    const { db, close } = createTestDatabase();
    try {
      const repo = new SqliteAssetRepository(db);
      await repo.create(property());
      const wholeUnits = config({
        roundingScale: 0,
        residualValue: { amount: "1000", commodity: "EUR" },
        method: { kind: "linear_useful_life", usefulLifeYears: 10 },
      });
      await repo.saveScheduleConfig(wholeUnits);
      const loaded = await repo.getScheduleConfig("ws_1", "cfg_v1");
      expect(loaded).toEqual(wholeUnits);
      // 0 must survive as 0, not collapse to "unset".
      expect(loaded?.roundingScale).toBe(0);
      expect(loaded?.residualValue).toEqual({ amount: "1000", commodity: "EUR" });
    } finally {
      close();
    }
  });

  it("refuses a depreciation entry pointing at an unknown or foreign schedule config", async () => {
    const { db, close } = createTestDatabase();
    try {
      const repo = new SqliteAssetRepository(db);
      await repo.create(property());
      await repo.create(
        property({
          id: "asset_other",
          workspaceId: "ws_2",
        }),
      );
      await repo.saveScheduleConfig(
        config({ id: "cfg_ws2", workspaceId: "ws_2", assetId: "asset_other" }),
      );

      await expect(
        repo.recordDepreciationEntry({ ...entry(2024), configId: "cfg_missing" }),
      ).rejects.toThrow();
      // Config exists, but in another workspace.
      await expect(
        repo.recordDepreciationEntry({ ...entry(2024), configId: "cfg_ws2" }),
      ).rejects.toThrow();
      expect(await repo.listDepreciationEntries("ws_1", "asset_flat")).toEqual([]);
    } finally {
      close();
    }
  });

  it("lists assets ordered by acquisition date, then id", async () => {
    const { db, close } = createTestDatabase();
    try {
      const repo = new SqliteAssetRepository(db);
      const withComponents = (id: string, acquiredOn: string): Asset =>
        property({
          id,
          acquiredOn,
          components: property().components.map((c) => ({ ...c, id: `${c.id}_${id}` })),
        });
      await repo.create(withComponents("asset_c", "2023-05-01"));
      await repo.create(withComponents("asset_a", "2025-01-01"));
      await repo.create(withComponents("asset_b", "2023-05-01"));
      expect((await repo.list("ws_1")).map((a) => a.id)).toEqual(["asset_b", "asset_c", "asset_a"]);
    } finally {
      close();
    }
  });

  it("scopes component ids to their asset so two assets in one workspace may share them", async () => {
    const { db, close } = createTestDatabase();
    try {
      const repo = new SqliteAssetRepository(db);
      await repo.create(property());
      await repo.create(
        property({
          id: "asset_b",
          name: "B",
          components: property().components.map((c) => ({ ...c, label: `${c.label} B` })),
        }),
      );
      const flat = await repo.getById("ws_1", "asset_flat");
      const b = await repo.getById("ws_1", "asset_b");
      expect(flat?.components.map((c) => [c.id, c.label])).toEqual([
        ["cmp_building", "Building"],
        ["cmp_land", "Land"],
      ]);
      expect(b?.components.map((c) => [c.id, c.label])).toEqual([
        ["cmp_building", "Building B"],
        ["cmp_land", "Land B"],
      ]);
      // An improvement on B's building lands in B's history only.
      await repo.appendEvent({ ...improvement, id: "evt_b", assetId: "asset_b" });
      expect(await repo.listEvents("ws_1", "asset_flat")).toEqual([]);
      expect((await repo.listEvents("ws_1", "asset_b")).map((e) => e.id)).toEqual(["evt_b"]);
    } finally {
      close();
    }
  });

  it("rolls back the asset row when a component insert fails", async () => {
    const { db, close } = createTestDatabase();
    try {
      const repo = new SqliteAssetRepository(db);
      // Plant a component row that will collide on (workspace_id, asset_id, id)
      // once the asset is created; the whole create must roll back.
      db.exec("PRAGMA foreign_keys = OFF");
      db.prepare(
        "INSERT INTO asset_components (id, workspace_id, asset_id, position, role, label, cost, depreciable) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("cmp_building", "ws_2", "asset_colliding", 9, "building", "Orphan", "1.00", 1);
      db.exec("PRAGMA foreign_keys = ON");
      await expect(
        repo.create(property({ id: "asset_colliding", workspaceId: "ws_2" })),
      ).rejects.toThrow(/UNIQUE|PRIMARY KEY/i);
      expect(await repo.getById("ws_2", "asset_colliding")).toBeUndefined();
      expect(await repo.list("ws_2")).toEqual([]);
    } finally {
      close();
    }
  });
});

function entry(year: number): RecordedDepreciationEntry {
  return {
    id: `entry_${year}`,
    workspaceId: "ws_1",
    assetId: "asset_flat",
    configId: "cfg_v1",
    year,
    transactionId: `depr:asset_flat:v1:${year}`,
    amount: { amount: year === 2024 ? "3180.00" : "6360.00", commodity: "EUR" },
    createdAt: CREATED_AT,
  };
}
