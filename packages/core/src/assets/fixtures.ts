/**
 * Synthetic assets for tests. No real property, prices, or documents.
 */
import type {
  Asset,
  AssetDisposalEvent,
  AssetImprovementEvent,
  DepreciationScheduleConfig,
} from "./types";

const CREATED_AT = "2026-01-01T00:00:00Z";

/**
 * Rental flat bought mid-2024. Purchase price 400 000 split 75 % building /
 * 25 % land, plus 24 000 side costs (transfer tax + notary) → building basis
 * 318 000 after proportional allocation.
 */
export const SAMPLE_PROPERTY: Asset = {
  id: "asset_flat",
  workspaceId: "ws_1",
  kind: "real_estate",
  name: "Musterstrasse 1, Whg 3",
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
      label: "Land share",
      cost: { amount: "100000.00", commodity: "EUR" },
      depreciable: false,
    },
  ],
  acquisitionSideCosts: [
    {
      id: "sc_transfer_tax",
      label: "Real estate transfer tax",
      amount: { amount: "20000.00", commodity: "EUR" },
      evidenceDocumentIds: ["doc_transfer_tax"],
    },
    {
      id: "sc_notary",
      label: "Notary",
      amount: { amount: "4000.00", commodity: "EUR" },
      evidenceDocumentIds: ["doc_notary"],
    },
  ],
  evidenceDocumentIds: ["doc_purchase_contract"],
  createdAt: CREATED_AT,
};

/** Linear 2 % of the building basis, pro rata in the acquisition year. */
export const SAMPLE_PROPERTY_CONFIG: DepreciationScheduleConfig = {
  id: "cfg_flat_v1",
  workspaceId: "ws_1",
  assetId: "asset_flat",
  version: 1,
  method: { kind: "linear_percentage", annualRatePercent: "2" },
  proRataTemporis: true,
  expenseAccount: "Expenses:RealEstate:Depreciation:Musterstrasse 1",
  accumulatedDepreciationAccount: "Assets:RealEstate:Musterstrasse 1:AccumulatedDepreciation",
  createdAt: CREATED_AT,
};

/** Capitalized bathroom renovation in 2026 raising the building basis by 50 000. */
export const SAMPLE_IMPROVEMENT: AssetImprovementEvent = {
  kind: "improvement",
  id: "evt_bath_2026",
  workspaceId: "ws_1",
  assetId: "asset_flat",
  componentId: "cmp_building",
  occurredOn: "2026-03-01",
  description: "Bathroom renovation (capitalized)",
  amount: { amount: "50000.00", commodity: "EUR" },
  evidenceDocumentIds: ["doc_bath_invoice"],
  createdAt: "2026-03-05T00:00:00Z",
};

export const SAMPLE_DISPOSAL: AssetDisposalEvent = {
  kind: "disposal",
  id: "evt_sale_2027",
  workspaceId: "ws_1",
  assetId: "asset_flat",
  occurredOn: "2027-04-20",
  description: "Sold",
  proceeds: { amount: "450000.00", commodity: "EUR" },
  evidenceDocumentIds: ["doc_sale_contract"],
  createdAt: "2027-04-25T00:00:00Z",
};

/** Single-component equipment, 12 000 over a configured 3-year useful life. */
export const SAMPLE_EQUIPMENT: Asset = {
  id: "asset_laptop",
  workspaceId: "ws_1",
  kind: "equipment",
  name: "Workstation",
  commodity: "EUR",
  acquiredOn: "2025-10-10",
  components: [
    {
      id: "cmp_laptop",
      role: "whole_asset",
      label: "Workstation",
      cost: { amount: "12000.00", commodity: "EUR" },
      depreciable: true,
    },
  ],
  acquisitionSideCosts: [],
  evidenceDocumentIds: ["doc_laptop_invoice"],
  createdAt: CREATED_AT,
};

export const SAMPLE_EQUIPMENT_CONFIG: DepreciationScheduleConfig = {
  id: "cfg_laptop_v1",
  workspaceId: "ws_1",
  assetId: "asset_laptop",
  version: 1,
  method: { kind: "linear_useful_life", usefulLifeYears: 3 },
  proRataTemporis: true,
  expenseAccount: "Expenses:Depreciation:Workstation",
  accumulatedDepreciationAccount: "Assets:Equipment:Workstation:AccumulatedDepreciation",
  createdAt: CREATED_AT,
};
