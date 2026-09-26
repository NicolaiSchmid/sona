import {
  type Asset,
  type AssetDisposalEvent,
  type AssetImprovementEvent,
  computeDepreciationSchedule,
  type DepreciationScheduleConfig,
  planDepreciationDrafts,
  type RecordedDepreciationEntry,
} from "@sona/core";
import { describe, expect, it } from "vitest";
import { SqliteAssetRepository } from "./assets.js";
import { SqliteEvidenceLinkRepository } from "./evidence-links.js";
import { createTestDatabase, type TestDatabase } from "./test-support.js";

/** Evidence documents the fixtures reference, per workspace (document ids are global). */
const FIXTURE_DOCUMENTS = {
  ws_1: ["doc_contract", "doc_notary", "doc_bath", "doc_sale"],
  ws_2: ["doc_contract_ws2", "doc_notary_ws2"],
} as const;

/** Test database with the fixture documents stored, so evidence ids resolve. */
function setup(): TestDatabase {
  const database = createTestDatabase();
  const insert = database.db.prepare(
    "INSERT INTO documents (id, workspace_id, content_hash, mime_type, original_filename, storage_uri, source_kind, retention_state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const [workspaceId, ids] of Object.entries(FIXTURE_DOCUMENTS)) {
    for (const id of ids) {
      insert.run(
        id,
        workspaceId,
        `hash_${id}`,
        "application/pdf",
        `${id}.pdf`,
        `file://${id}`,
        "upload",
        "active",
        "2026-01-01T00:00:00Z",
      );
    }
  }
  return database;
}

const CREATED_AT = "2026-01-01T00:00:00Z";

function property(overrides: Partial<Asset> = {}): Asset {
  const suffix = overrides.workspaceId === "ws_2" ? "_ws2" : "";
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
        evidenceDocumentIds: [`doc_notary${suffix}`],
      },
    ],
    evidenceDocumentIds: [`doc_contract${suffix}`],
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
    const { db, close } = setup();
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
    const { db, close } = setup();
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
    const { db, close } = setup();
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
    const { db, close } = setup();
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
    const { db, close } = setup();
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
      ).rejects.toThrow(/does not belong to asset/);
      // Same workspace, but the target event belongs to another asset.
      await repo.create(property({ id: "asset_b", name: "B" }));
      await repo.appendEvent({ ...improvement, id: "evt_b", assetId: "asset_b" });
      await expect(
        repo.appendEvent({ ...retraction, id: "evt_cross_asset", retractsEventId: "evt_b" }),
      ).rejects.toThrow(/does not belong to asset/);
      // Retractions cannot be retracted.
      await expect(
        repo.appendEvent({ ...retraction, id: "evt_nested", retractsEventId: "evt_retract" }),
      ).rejects.toThrow(/cannot retract another retraction/);
      expect((await repo.listEvents("ws_1", "asset_flat")).map((e) => e.id)).toEqual([
        "evt_bath",
        "evt_retract",
      ]);
    } finally {
      close();
    }
  });

  it("refuses a depreciation entry whose config belongs to a different asset", async () => {
    const { db, close } = setup();
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

  it("lets depreciation draft evidence links pass the evidence endpoint check", async () => {
    const { db, close } = setup();
    try {
      const repo = new SqliteAssetRepository(db);
      const links = new SqliteEvidenceLinkRepository(db);
      await repo.create(property());
      await repo.saveScheduleConfig(config());
      const schedule = computeDepreciationSchedule({ asset: property(), config: config() });
      const [draft] = planDepreciationDrafts({
        asset: property(),
        config: config(),
        schedule,
        recorded: [],
        throughYear: 2024,
        createdAt: CREATED_AT,
      }).create;
      const scheduleLink = draft?.evidenceLinks.find((l) => l.kind === "generated_from");
      if (scheduleLink === undefined) {
        throw new Error("expected a generated_from link");
      }
      // The ledger transaction endpoint is verified too, so create it first.
      db.prepare(
        "INSERT INTO ledger_transactions (id, workspace_id, booked_on, description, review_state, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(scheduleLink.fromId, "ws_1", "2024-12-31", "draft", "draft", CREATED_AT);
      expect((await links.link(scheduleLink)).created).toBe(true);
      // A link to a schedule config that does not exist in the workspace is refused.
      await expect(
        links.link({ ...scheduleLink, id: "link_bad", toId: "cfg_missing" }),
      ).rejects.toThrow(/asset_depreciation_schedule:cfg_missing not found/);
    } finally {
      close();
    }
  });

  it("refuses evidence document ids that are not stored in the workspace", async () => {
    const { db, close } = setup();
    try {
      const repo = new SqliteAssetRepository(db);
      await expect(
        repo.create(property({ evidenceDocumentIds: ["doc_dangling"] })),
      ).rejects.toThrow(/evidence document\(s\) not found in workspace: doc_dangling/);
      // Another workspace's document does not count as evidence here.
      await expect(
        repo.create(property({ evidenceDocumentIds: ["doc_contract_ws2"] })),
      ).rejects.toThrow(/not found in workspace/);
      expect(await repo.list("ws_1")).toEqual([]);
      await repo.create(property());
      await expect(
        repo.appendEvent({ ...improvement, evidenceDocumentIds: ["doc_bath", "doc_nope"] }),
      ).rejects.toThrow(/doc_nope/);
      expect(await repo.listEvents("ws_1", "asset_flat")).toEqual([]);
    } finally {
      close();
    }
  });

  it("refuses improvements and residual values in a different commodity than the asset", async () => {
    const { db, close } = setup();
    try {
      const repo = new SqliteAssetRepository(db);
      await repo.create(property());
      await expect(
        repo.appendEvent({ ...improvement, amount: { amount: "1.00", commodity: "USD" } }),
      ).rejects.toThrow(/denominated in USD, expected EUR/);
      await expect(
        repo.saveScheduleConfig(config({ residualValue: { amount: "1.00", commodity: "USD" } })),
      ).rejects.toThrow(/denominated in USD, expected EUR/);
      expect(await repo.listEvents("ws_1", "asset_flat")).toEqual([]);
      expect(await repo.listScheduleConfigs("ws_1", "asset_flat")).toEqual([]);
    } finally {
      close();
    }
  });

  it("appends schedule config versions and returns the latest", async () => {
    const { db, close } = setup();
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
    const { db, close } = setup();
    try {
      const repo = new SqliteAssetRepository(db);
      await repo.create(property());
      await repo.saveScheduleConfig(config());
      const first = await repo.recordDepreciationEntry(entry(2024));
      // Same transaction again (a retry): the stored entry wins, nothing is rewritten.
      const again = await repo.recordDepreciationEntry({
        ...entry(2024),
        id: "entry_dup",
        createdAt: "2026-01-02T00:00:00Z",
      });
      expect(first).toEqual(entry(2024));
      expect(again).toEqual(entry(2024));
      // A different asset-year or amount under a known transaction id is a caller bug.
      await expect(
        repo.recordDepreciationEntry({
          ...entry(2024),
          id: "entry_wrong",
          amount: { amount: "999.00", commodity: "EUR" },
        }),
      ).rejects.toThrow(/already recorded with a different/);
      await expect(
        repo.recordDepreciationEntry({ ...entry(2024), id: "entry_wrong_year", year: 2031 }),
      ).rejects.toThrow(/already recorded with a different/);
      // Invalid input is rejected at the write boundary before touching the database.
      await expect(
        repo.recordDepreciationEntry({
          ...entry(2030),
          amount: { amount: "not-a-decimal", commodity: "EUR" },
        }),
      ).rejects.toThrow();
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
    const { db, close } = setup();
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
    const { db, close } = setup();
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
    const { db, close } = setup();
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
    const { db, close } = setup();
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
    const { db, close } = setup();
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
    const { db, close } = setup();
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
    const { db, close } = setup();
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
    const { db, close } = setup();
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

  it("refuses a retry that re-describes a known transaction under a different config", async () => {
    const { db, close } = setup();
    try {
      const repo = new SqliteAssetRepository(db);
      await repo.create(property());
      await repo.saveScheduleConfig(config());
      await repo.saveScheduleConfig(config({ id: "cfg_v2", version: 2 }));
      await repo.recordDepreciationEntry(entry(2024));
      // cfg_v2 exists for the same asset, so only the payload comparison can refuse this.
      await expect(
        repo.recordDepreciationEntry({ ...entry(2024), id: "entry_wrong_cfg", configId: "cfg_v2" }),
      ).rejects.toThrow(/already recorded with a different/);
      expect(await repo.listDepreciationEntries("ws_1", "asset_flat")).toEqual([entry(2024)]);
    } finally {
      close();
    }
  });

  it("rejects a retraction whose target was recorded in another workspace", async () => {
    const { db, close } = setup();
    try {
      const repo = new SqliteAssetRepository(db);
      await repo.create(property());
      await repo.create(property({ id: "asset_other", workspaceId: "ws_2" }));
      const foreign: AssetImprovementEvent = {
        ...improvement,
        id: "evt_ws2",
        workspaceId: "ws_2",
        assetId: "asset_other",
        evidenceDocumentIds: ["doc_contract_ws2"],
      };
      await repo.appendEvent(foreign);
      // The target lookup is workspace-scoped: ws_1 cannot see, let alone retract, ws_2's event.
      await expect(
        repo.appendEvent({
          kind: "retraction",
          id: "evt_cross_ws",
          workspaceId: "ws_1",
          assetId: "asset_flat",
          retractsEventId: "evt_ws2",
          occurredOn: "2026-04-01",
          description: "Cross-workspace retraction",
          evidenceDocumentIds: [],
          createdAt: "2026-04-01T00:00:00Z",
        }),
      ).rejects.toThrow(/does not belong to asset asset_flat/);
      expect(await repo.listEvents("ws_1", "asset_flat")).toEqual([]);
      expect(await repo.listEvents("ws_2", "asset_other")).toEqual([foreign]);
    } finally {
      close();
    }
  });

  it("verifies the document endpoint of a draft's substantiating links in the workspace", async () => {
    const { db, close } = setup();
    try {
      const repo = new SqliteAssetRepository(db);
      const links = new SqliteEvidenceLinkRepository(db);
      await repo.create(property());
      await repo.saveScheduleConfig(config());
      const schedule = computeDepreciationSchedule({ asset: property(), config: config() });
      const [draft] = planDepreciationDrafts({
        asset: property(),
        config: config(),
        schedule,
        recorded: [],
        throughYear: 2024,
        createdAt: CREATED_AT,
      }).create;
      if (draft === undefined) {
        throw new Error("expected a draft for 2024");
      }
      const substantiating = draft.evidenceLinks.filter((l) => l.kind === "substantiates");
      expect(substantiating.map((l) => l.fromId).sort()).toEqual(["doc_contract", "doc_notary"]);
      db.prepare(
        "INSERT INTO ledger_transactions (id, workspace_id, booked_on, description, review_state, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(draft.transaction.id, "ws_1", draft.transaction.bookedOn, "draft", "draft", CREATED_AT);
      const contractLink = substantiating.find((l) => l.fromId === "doc_contract");
      if (contractLink === undefined) {
        throw new Error("expected a link from doc_contract");
      }

      // A document that does not exist, or exists only in another workspace, is refused.
      await expect(
        links.link({ ...contractLink, id: "link_missing", fromId: "doc_missing" }),
      ).rejects.toThrow(/document:doc_missing not found in workspace/);
      await expect(
        links.link({ ...contractLink, id: "link_cross_ws", fromId: "doc_contract_ws2" }),
      ).rejects.toThrow(/document:doc_contract_ws2 not found in workspace/);
      expect(await links.listForTransaction("ws_1", draft.transaction.id)).toEqual([]);

      // The asset's own documents exist in ws_1, so every link is created exactly once.
      for (const link of substantiating) {
        expect((await links.link(link)).created).toBe(true);
        expect((await links.link(link)).created).toBe(false);
      }
      expect(
        (await links.listForTransaction("ws_1", draft.transaction.id)).map((l) => l.fromId).sort(),
      ).toEqual(["doc_contract", "doc_notary"]);
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
