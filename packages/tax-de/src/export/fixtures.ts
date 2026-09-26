/**
 * Synthetic ledger postings and depreciation schedules for tax export tests.
 * No real financial data.
 */
import {
  type Asset,
  computeDepreciationSchedule,
  type DepreciationScheduleConfig,
} from "@sona/core";
import type { DepreciationScheduleExportInput } from "./depreciation.js";
import type { TaxPostingInput } from "./types.js";

/** Rental flat acquired 2024-07; 2 % linear on a 318 000 building basis → 6 360 per full year. */
export const SAMPLE_ASSET: Asset = {
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
      label: "Notary and transfer tax",
      amount: { amount: "24000.00", commodity: "EUR" },
      evidenceDocumentIds: ["doc_notary"],
    },
  ],
  evidenceDocumentIds: ["doc_2"],
  createdAt: "2026-01-01T00:00:00Z",
};

export const SAMPLE_SCHEDULE_CONFIG: DepreciationScheduleConfig = {
  id: "cfg_flat_v1",
  workspaceId: "ws_1",
  assetId: "asset_flat",
  version: 1,
  method: { kind: "linear_percentage", annualRatePercent: "2" },
  proRataTemporis: true,
  expenseAccount: "Expenses:RealEstate:Depreciation:Flat",
  accumulatedDepreciationAccount: "Assets:RealEstate:Flat:AccumulatedDepreciation",
  createdAt: "2026-01-01T00:00:00Z",
};

/** The 2026 depreciation posting (`p_depr`) is generated and user-reviewed; 2025 is a draft. */
export const SAMPLE_DEPRECIATION: DepreciationScheduleExportInput = {
  assetId: SAMPLE_ASSET.id,
  assetName: SAMPLE_ASSET.name,
  assetKind: SAMPLE_ASSET.kind,
  schedule: computeDepreciationSchedule({ asset: SAMPLE_ASSET, config: SAMPLE_SCHEDULE_CONFIG }),
  transactions: [
    {
      year: 2025,
      transactionId: "depr:asset_flat:v1:2025",
      postingIds: ["depr:asset_flat:v1:2025:expense", "depr:asset_flat:v1:2025:accumulated"],
      reviewState: "draft",
    },
    {
      year: 2026,
      transactionId: "t_depr",
      postingIds: ["p_depr", "p_depr_accumulated"],
      reviewState: "user_reviewed",
    },
  ],
};

/** Single-component equipment acquired 2025-10; 12 000 over a configured 3-year life. */
export const SAMPLE_EQUIPMENT_ASSET: Asset = {
  id: "asset_workstation",
  workspaceId: "ws_1",
  kind: "equipment",
  name: "Synthetic workstation",
  commodity: "EUR",
  acquiredOn: "2025-10-10",
  components: [
    {
      id: "cmp_workstation",
      role: "whole_asset",
      label: "Workstation",
      cost: { amount: "12000.00", commodity: "EUR" },
      depreciable: true,
    },
  ],
  acquisitionSideCosts: [],
  evidenceDocumentIds: ["doc_workstation_invoice"],
  createdAt: "2026-01-01T00:00:00Z",
};

export const SAMPLE_EQUIPMENT_SCHEDULE_CONFIG: DepreciationScheduleConfig = {
  id: "cfg_workstation_v1",
  workspaceId: "ws_1",
  assetId: "asset_workstation",
  version: 1,
  method: { kind: "linear_useful_life", usefulLifeYears: 3 },
  proRataTemporis: true,
  expenseAccount: "Expenses:Depreciation:Workstation",
  accumulatedDepreciationAccount: "Assets:Equipment:Workstation:AccumulatedDepreciation",
  createdAt: "2026-01-01T00:00:00Z",
};

/** Second asset for multi-asset exports; its 2026 transaction is user-reviewed. */
export const SAMPLE_EQUIPMENT_DEPRECIATION: DepreciationScheduleExportInput = {
  assetId: SAMPLE_EQUIPMENT_ASSET.id,
  assetName: SAMPLE_EQUIPMENT_ASSET.name,
  assetKind: SAMPLE_EQUIPMENT_ASSET.kind,
  schedule: computeDepreciationSchedule({
    asset: SAMPLE_EQUIPMENT_ASSET,
    config: SAMPLE_EQUIPMENT_SCHEDULE_CONFIG,
  }),
  transactions: [
    {
      year: 2026,
      transactionId: "t_depr_workstation",
      postingIds: ["p_depr_workstation", "p_depr_workstation_accumulated"],
      reviewState: "user_reviewed",
    },
  ],
};

export const SAMPLE_POSTINGS: TaxPostingInput[] = [
  {
    postingId: "p_maint",
    transactionId: "t_maint",
    date: "2026-03-10",
    description: "Roof repair rental unit",
    amount: "-500.00",
    commodity: "EUR",
    account: "Expenses:RealEstate:Maintenance",
    reviewState: "user_reviewed",
    evidenceDocumentIds: [],
  },
  {
    postingId: "p_taxadvice",
    transactionId: "t_taxadvice",
    date: "2026-04-01",
    description: "Steuerberater fee",
    amount: "-200.00",
    commodity: "EUR",
    account: "Expenses:TaxAdvice",
    reviewState: "user_reviewed",
    evidenceDocumentIds: ["doc_1"],
  },
  {
    postingId: "p_depr",
    transactionId: "t_depr",
    date: "2026-12-31",
    description: "Annual building depreciation",
    amount: "-1000.00",
    commodity: "EUR",
    account: "Expenses:RealEstate:Depreciation",
    reviewState: "user_reviewed",
    evidenceDocumentIds: ["doc_2"],
  },
  {
    postingId: "p_groceries",
    transactionId: "t_groceries",
    date: "2026-05-05",
    description: "Supermarket",
    amount: "-42.00",
    commodity: "EUR",
    account: "Expenses:Groceries",
    reviewState: "suggested",
    evidenceDocumentIds: [],
  },
  {
    postingId: "p_donation",
    transactionId: "t_donation",
    date: "2026-06-15",
    description: "Charity donation",
    amount: "-100.00",
    commodity: "EUR",
    account: "Expenses:Donations",
    reviewState: "suggested",
    evidenceDocumentIds: [],
  },
  {
    postingId: "p_draft",
    transactionId: "t_draft",
    date: "2026-07-20",
    description: "Unreviewed work expense",
    amount: "-80.00",
    commodity: "EUR",
    account: "Expenses:WorkRelated",
    reviewState: "draft",
    evidenceDocumentIds: [],
  },
];
