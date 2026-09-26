import {
  type Asset,
  type AssetComponent,
  type AssetEvent,
  assetEventSchema,
  assetSchema,
  type DepreciationScheduleConfig,
  depreciationScheduleConfigSchema,
  type MoneyAmount,
  moneyAmountsEqual,
  type RecordedDepreciationEntry,
  recordedDepreciationEntrySchema,
} from "@sona/core";
import type { DbClient } from "../runner.js";
import {
  optionalNumber,
  optionalString,
  parseJson,
  requiredNumber,
  requiredString,
  row,
  rows,
  withTransaction,
} from "./helpers.js";

/**
 * Workspace-scoped persistence for assets, their append-only history,
 * versioned schedule configuration, and generated depreciation entries.
 * Every read and write is keyed by `workspace_id`; the composite foreign keys
 * in `0006_assets.sql` reject cross-workspace references at the database too.
 */
export class SqliteAssetRepository {
  readonly #db: DbClient;

  constructor(db: DbClient) {
    this.#db = db;
  }

  async create(input: Asset): Promise<Asset> {
    const asset = assetSchema.parse(input);
    if ((await this.getById(asset.workspaceId, asset.id)) !== undefined) {
      throw new Error("asset already exists in workspace");
    }
    withTransaction(this.#db, () => {
      this.#db
        .prepare(
          "INSERT INTO assets (id, workspace_id, kind, name, commodity, acquired_on, acquisition_side_costs_json, evidence_document_ids_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          asset.id,
          asset.workspaceId,
          asset.kind,
          asset.name,
          asset.commodity,
          asset.acquiredOn,
          JSON.stringify(asset.acquisitionSideCosts),
          JSON.stringify(asset.evidenceDocumentIds),
          asset.createdAt,
        );
      const insertComponent = this.#db.prepare(
        "INSERT INTO asset_components (id, workspace_id, asset_id, position, role, label, cost, depreciable) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const [position, component] of asset.components.entries()) {
        insertComponent.run(
          component.id,
          asset.workspaceId,
          asset.id,
          position,
          component.role,
          component.label,
          component.cost.amount,
          component.depreciable ? 1 : 0,
        );
      }
    });
    return asset;
  }

  async getById(workspaceId: string, id: string): Promise<Asset | undefined> {
    const result = row(
      this.#db
        .prepare("SELECT * FROM assets WHERE workspace_id = ? AND id = ?")
        .get(workspaceId, id),
    );
    return result === undefined ? undefined : this.#assetFromRow(result);
  }

  async list(workspaceId: string): Promise<Asset[]> {
    return rows(
      this.#db
        .prepare("SELECT * FROM assets WHERE workspace_id = ? ORDER BY acquired_on, id")
        .all(workspaceId),
    ).map((r) => this.#assetFromRow(r));
  }

  /** Appends an improvement, disposal, or retraction. Events are never updated or deleted. */
  async appendEvent(input: AssetEvent): Promise<void> {
    const event = assetEventSchema.parse(input);
    const asset = await this.#requireAsset(event.workspaceId, event.assetId);
    if (
      event.kind === "improvement" &&
      !asset.components.some((component) => component.id === event.componentId)
    ) {
      throw new Error(`component ${event.componentId} does not belong to asset ${asset.id}`);
    }
    if (event.kind === "retraction") {
      // A mis-targeted retraction would make every later schedule computation
      // fail, and history is append-only, so refuse it here as core would.
      const target = row(
        this.#db
          .prepare(
            "SELECT kind FROM asset_events WHERE workspace_id = ? AND asset_id = ? AND id = ?",
          )
          .get(event.workspaceId, event.assetId, event.retractsEventId),
      );
      if (target === undefined) {
        throw new Error(`event ${event.retractsEventId} does not belong to asset ${asset.id}`);
      }
      if (requiredString(target, "kind") === "retraction") {
        throw new Error("a retraction cannot retract another retraction");
      }
    }
    const existing = row(
      this.#db
        .prepare("SELECT id FROM asset_events WHERE workspace_id = ? AND id = ?")
        .get(event.workspaceId, event.id),
    );
    if (existing !== undefined) {
      throw new Error("asset events are append-only");
    }
    const money = eventMoney(event);
    this.#db
      .prepare(
        "INSERT INTO asset_events (id, workspace_id, asset_id, kind, component_id, retracts_event_id, occurred_on, description, amount, commodity, evidence_document_ids_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        event.id,
        event.workspaceId,
        event.assetId,
        event.kind,
        event.kind === "improvement" ? event.componentId : null,
        event.kind === "retraction" ? event.retractsEventId : null,
        event.occurredOn,
        event.description,
        money?.amount ?? null,
        money?.commodity ?? null,
        JSON.stringify(event.evidenceDocumentIds),
        event.createdAt,
      );
  }

  async listEvents(workspaceId: string, assetId: string): Promise<AssetEvent[]> {
    return rows(
      this.#db
        .prepare(
          "SELECT * FROM asset_events WHERE workspace_id = ? AND asset_id = ? ORDER BY occurred_on, created_at, id",
        )
        .all(workspaceId, assetId),
    ).map(eventFromRow);
  }

  /** Appends a new configuration version. Existing versions are immutable. */
  async saveScheduleConfig(input: DepreciationScheduleConfig): Promise<void> {
    const config = depreciationScheduleConfigSchema.parse(input);
    await this.#requireAsset(config.workspaceId, config.assetId);
    const latest = await this.getLatestScheduleConfig(config.workspaceId, config.assetId);
    if (latest !== undefined && config.version <= latest.version) {
      throw new Error(
        `schedule config version ${config.version} must exceed latest version ${latest.version}`,
      );
    }
    this.#db
      .prepare(
        "INSERT INTO asset_depreciation_schedules (id, workspace_id, asset_id, version, method_json, pro_rata_temporis, residual_value, residual_commodity, rounding_scale, expense_account, accumulated_depreciation_account, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        config.id,
        config.workspaceId,
        config.assetId,
        config.version,
        JSON.stringify(config.method),
        config.proRataTemporis ? 1 : 0,
        config.residualValue?.amount ?? null,
        config.residualValue?.commodity ?? null,
        config.roundingScale ?? null,
        config.expenseAccount,
        config.accumulatedDepreciationAccount,
        config.createdAt,
      );
  }

  async getScheduleConfig(
    workspaceId: string,
    id: string,
  ): Promise<DepreciationScheduleConfig | undefined> {
    const result = row(
      this.#db
        .prepare("SELECT * FROM asset_depreciation_schedules WHERE workspace_id = ? AND id = ?")
        .get(workspaceId, id),
    );
    return result === undefined ? undefined : configFromRow(result);
  }

  async getLatestScheduleConfig(
    workspaceId: string,
    assetId: string,
  ): Promise<DepreciationScheduleConfig | undefined> {
    const result = row(
      this.#db
        .prepare(
          "SELECT * FROM asset_depreciation_schedules WHERE workspace_id = ? AND asset_id = ? ORDER BY version DESC LIMIT 1",
        )
        .get(workspaceId, assetId),
    );
    return result === undefined ? undefined : configFromRow(result);
  }

  async listScheduleConfigs(
    workspaceId: string,
    assetId: string,
  ): Promise<DepreciationScheduleConfig[]> {
    return rows(
      this.#db
        .prepare(
          "SELECT * FROM asset_depreciation_schedules WHERE workspace_id = ? AND asset_id = ? ORDER BY version",
        )
        .all(workspaceId, assetId),
    ).map(configFromRow);
  }

  /**
   * Records the transaction generated for an asset-year. Insert-only and
   * idempotent by transaction id: recording the same transaction again
   * returns the stored entry unchanged; nothing is ever updated. Several
   * entries may exist for one year over time (superseded draft + replacement);
   * the ledger's review state says which is live.
   */
  async recordDepreciationEntry(
    input: RecordedDepreciationEntry,
  ): Promise<RecordedDepreciationEntry> {
    const entry = recordedDepreciationEntrySchema.parse(input);
    // ON CONFLICT keeps concurrent retries atomic: whoever loses the race
    // reads back the winner's row instead of failing on the unique index.
    this.#db
      .prepare(
        "INSERT INTO asset_depreciation_entries (id, workspace_id, asset_id, config_id, year, transaction_id, amount, commodity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id, transaction_id) DO NOTHING",
      )
      .run(
        entry.id,
        entry.workspaceId,
        entry.assetId,
        entry.configId,
        entry.year,
        entry.transactionId,
        entry.amount.amount,
        entry.amount.commodity,
        entry.createdAt,
      );
    const stored = await this.getDepreciationEntryByTransaction(
      entry.workspaceId,
      entry.transactionId,
    );
    if (stored === undefined) {
      throw new Error("depreciation entry was not persisted");
    }
    // A retry of the same transaction must describe the same asset-year; a
    // different payload under a known transaction id is a caller bug, not a retry.
    if (
      stored.assetId !== entry.assetId ||
      stored.configId !== entry.configId ||
      stored.year !== entry.year ||
      !moneyAmountsEqual(stored.amount, entry.amount)
    ) {
      throw new Error(
        `transaction ${entry.transactionId} is already recorded with a different asset-year or amount`,
      );
    }
    return stored;
  }

  async getDepreciationEntryByTransaction(
    workspaceId: string,
    transactionId: string,
  ): Promise<RecordedDepreciationEntry | undefined> {
    const result = row(
      this.#db
        .prepare(
          "SELECT * FROM asset_depreciation_entries WHERE workspace_id = ? AND transaction_id = ?",
        )
        .get(workspaceId, transactionId),
    );
    return result === undefined ? undefined : entryFromRow(result);
  }

  async listDepreciationEntries(
    workspaceId: string,
    assetId: string,
  ): Promise<RecordedDepreciationEntry[]> {
    return rows(
      this.#db
        .prepare(
          "SELECT * FROM asset_depreciation_entries WHERE workspace_id = ? AND asset_id = ? ORDER BY year, created_at, id",
        )
        .all(workspaceId, assetId),
    ).map(entryFromRow);
  }

  async #requireAsset(workspaceId: string, assetId: string): Promise<Asset> {
    const asset = await this.getById(workspaceId, assetId);
    if (asset === undefined) {
      throw new Error("asset not found in workspace");
    }
    return asset;
  }

  #assetFromRow(source: Record<string, unknown>): Asset {
    const workspaceId = requiredString(source, "workspace_id");
    const id = requiredString(source, "id");
    const commodity = requiredString(source, "commodity");
    const components = rows(
      this.#db
        .prepare(
          "SELECT * FROM asset_components WHERE workspace_id = ? AND asset_id = ? ORDER BY position",
        )
        .all(workspaceId, id),
    ).map((r) => componentFromRow(r, commodity));
    // assetSchema validates the stored JSON (side costs, evidence ids) and
    // re-checks commodity consistency on the way out.
    return assetSchema.parse({
      id,
      workspaceId,
      kind: requiredString(source, "kind"),
      name: requiredString(source, "name"),
      commodity,
      acquiredOn: requiredString(source, "acquired_on"),
      components,
      acquisitionSideCosts: parseJson(requiredString(source, "acquisition_side_costs_json")),
      evidenceDocumentIds: parseJson(requiredString(source, "evidence_document_ids_json")),
      createdAt: requiredString(source, "created_at"),
    });
  }
}

/** The one money column an event kind carries: improvement cost or disposal proceeds. */
function eventMoney(event: AssetEvent): MoneyAmount | undefined {
  switch (event.kind) {
    case "improvement":
      return event.amount;
    case "disposal":
      return event.proceeds;
    case "retraction":
      return undefined;
  }
}

/** Components store only the amount; the commodity is asset-level. */
function componentFromRow(source: Record<string, unknown>, commodity: string): AssetComponent {
  return {
    id: requiredString(source, "id"),
    role: requiredString(source, "role") as AssetComponent["role"],
    label: requiredString(source, "label"),
    cost: { amount: requiredString(source, "cost"), commodity },
    depreciable: requiredNumber(source, "depreciable") === 1,
  };
}

function eventFromRow(source: Record<string, unknown>): AssetEvent {
  const base = {
    id: requiredString(source, "id"),
    workspaceId: requiredString(source, "workspace_id"),
    assetId: requiredString(source, "asset_id"),
    occurredOn: requiredString(source, "occurred_on"),
    description: requiredString(source, "description"),
    evidenceDocumentIds: parseJson(requiredString(source, "evidence_document_ids_json")),
    createdAt: requiredString(source, "created_at"),
  };
  const amount = optionalString(source, "amount");
  const commodity = optionalString(source, "commodity");
  const money = amount === undefined || commodity === undefined ? undefined : { amount, commodity };
  const kind = requiredString(source, "kind");
  switch (kind) {
    case "improvement":
      return assetEventSchema.parse({
        ...base,
        kind,
        componentId: requiredString(source, "component_id"),
        amount: money,
      });
    case "retraction":
      return assetEventSchema.parse({
        ...base,
        kind,
        retractsEventId: requiredString(source, "retracts_event_id"),
      });
    case "disposal":
      return assetEventSchema.parse({ ...base, kind, proceeds: money });
    default:
      throw new Error(`database column kind had unexpected value ${JSON.stringify(kind)}`);
  }
}

function configFromRow(source: Record<string, unknown>): DepreciationScheduleConfig {
  const residualValue = optionalString(source, "residual_value");
  const residualCommodity = optionalString(source, "residual_commodity");
  return depreciationScheduleConfigSchema.parse({
    id: requiredString(source, "id"),
    workspaceId: requiredString(source, "workspace_id"),
    assetId: requiredString(source, "asset_id"),
    version: requiredNumber(source, "version"),
    method: parseJson(requiredString(source, "method_json")),
    proRataTemporis: requiredNumber(source, "pro_rata_temporis") === 1,
    residualValue:
      residualValue === undefined || residualCommodity === undefined
        ? undefined
        : { amount: residualValue, commodity: residualCommodity },
    roundingScale: optionalNumber(source, "rounding_scale"),
    expenseAccount: requiredString(source, "expense_account"),
    accumulatedDepreciationAccount: requiredString(source, "accumulated_depreciation_account"),
    createdAt: requiredString(source, "created_at"),
  });
}

function entryFromRow(source: Record<string, unknown>): RecordedDepreciationEntry {
  return {
    id: requiredString(source, "id"),
    workspaceId: requiredString(source, "workspace_id"),
    assetId: requiredString(source, "asset_id"),
    configId: requiredString(source, "config_id"),
    year: requiredNumber(source, "year"),
    transactionId: requiredString(source, "transaction_id"),
    amount: {
      amount: requiredString(source, "amount"),
      commodity: requiredString(source, "commodity"),
    },
    createdAt: requiredString(source, "created_at"),
  };
}
