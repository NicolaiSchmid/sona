/**
 * Asset registry and configurable depreciation schedules.
 *
 * An asset is a user-registered, depreciable (or partly depreciable) thing:
 * a rental property with a land/building split, a vehicle, equipment. Sona
 * computes schedules from what the user configured — rate, useful life,
 * pro-rata behaviour — and labels every output as a configured rule. It never
 * decides which rate is legally applicable.
 *
 * Every amount is a core {@link MoneyAmount} decimal string. Asset history
 * (improvements, disposal, retractions) is append-only; schedule configuration
 * is versioned so each generated row can name the exact configuration that
 * produced it.
 */
import { z } from "zod";
import { isZeroDecimal } from "../money/decimal";
import { decimalStringSchema, type MoneyAmount, moneyAmountSchema } from "../money/types";

/** Thrown when asset configuration or history cannot produce a valid schedule or posting. */
export class DepreciationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DepreciationError";
  }
}

/** ISO calendar date, YYYY-MM-DD. */
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/** ISO timestamp with offset, as written to `createdAt` columns. */
const isoTimestampSchema = z.string().datetime({ offset: true });

const nonNegativeDecimalSchema = decimalStringSchema.refine((v) => !v.startsWith("-"), {
  message: "expected a non-negative decimal string",
});

const nonNegativeMoneySchema = moneyAmountSchema.extend({
  amount: nonNegativeDecimalSchema,
}) satisfies z.ZodType<MoneyAmount>;

export const ASSET_KINDS = [
  "real_estate",
  "vehicle",
  "equipment",
  "furniture",
  "intangible",
  "other",
] as const;

export type AssetKind = (typeof ASSET_KINDS)[number];

/** What a cost component represents. `land` is the canonical non-depreciable part. */
export const ASSET_COMPONENT_ROLES = [
  "land",
  "building",
  "outdoor_facilities",
  "fixtures",
  "whole_asset",
  "other",
] as const;

export type AssetComponentRole = (typeof ASSET_COMPONENT_ROLES)[number];

export const assetComponentSchema = z.object({
  id: z.string().min(1),
  role: z.enum(ASSET_COMPONENT_ROLES),
  label: z.string().min(1),
  /** Share of the purchase price attributed to this component, before side costs. */
  cost: nonNegativeMoneySchema,
  /**
   * Whether the configured schedule depreciates this component. Land is
   * typically configured as non-depreciable; the user decides.
   */
  depreciable: z.boolean(),
});

export type AssetComponent = z.infer<typeof assetComponentSchema>;

/**
 * Acquisition side cost (Anschaffungsnebenkosten) such as notary, land
 * registry, transfer tax, or broker fees. Allocated to components proportional
 * to their cost split.
 */
export const acquisitionSideCostSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  amount: nonNegativeMoneySchema,
  evidenceDocumentIds: z.array(z.string().min(1)),
});

export type AcquisitionSideCost = z.infer<typeof acquisitionSideCostSchema>;

export const assetSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    kind: z.enum(ASSET_KINDS),
    name: z.string().min(1),
    /** Commodity every amount on this asset is denominated in, e.g. "EUR". */
    commodity: z.string().min(1),
    /** ISO date the asset entered service as configured by the user. */
    acquiredOn: isoDateSchema,
    components: z.array(assetComponentSchema).min(1),
    acquisitionSideCosts: z.array(acquisitionSideCostSchema),
    /** Documents substantiating the acquisition (purchase contract, invoices). */
    evidenceDocumentIds: z.array(z.string().min(1)),
    createdAt: isoTimestampSchema,
  })
  .superRefine((asset, ctx) => {
    const ids = new Set<string>();
    for (const [index, component] of asset.components.entries()) {
      if (ids.has(component.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["components", index, "id"],
          message: `duplicate component id ${JSON.stringify(component.id)}`,
        });
      }
      ids.add(component.id);
      if (component.cost.commodity !== asset.commodity) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["components", index, "cost", "commodity"],
          message: `component commodity must match asset commodity ${asset.commodity}`,
        });
      }
    }
    for (const [index, sideCost] of asset.acquisitionSideCosts.entries()) {
      if (sideCost.amount.commodity !== asset.commodity) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["acquisitionSideCosts", index, "amount", "commodity"],
          message: `side cost commodity must match asset commodity ${asset.commodity}`,
        });
      }
    }
  });

export type Asset = z.infer<typeof assetSchema>;

/** Fields every append-only asset history event carries. */
const assetEventBaseShape = {
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  assetId: z.string().min(1),
  occurredOn: isoDateSchema,
  description: z.string().min(1),
  evidenceDocumentIds: z.array(z.string().min(1)),
  createdAt: isoTimestampSchema,
} as const;

/**
 * Post-acquisition capitalized improvement (nachträgliche Herstellungskosten).
 * Raises the depreciable basis of the named component from its year onward.
 * Whether a cost is an improvement or maintenance is the user's classification.
 */
export const assetImprovementEventSchema = z.object({
  kind: z.literal("improvement"),
  ...assetEventBaseShape,
  componentId: z.string().min(1),
  amount: nonNegativeMoneySchema,
});

/** Disposal (sale, scrapping, withdrawal). Ends the schedule in the disposal year. */
export const assetDisposalEventSchema = z.object({
  kind: z.literal("disposal"),
  ...assetEventBaseShape,
  proceeds: nonNegativeMoneySchema.optional(),
});

/**
 * Correction path for the append-only history: retracts an earlier
 * improvement or disposal so schedules ignore it. A corrected event is then
 * appended as a new improvement/disposal. Retractions cannot be retracted.
 */
export const assetRetractionEventSchema = z.object({
  kind: z.literal("retraction"),
  ...assetEventBaseShape,
  /** Id of the improvement or disposal event being retracted. */
  retractsEventId: z.string().min(1),
});

export const assetEventSchema = z.discriminatedUnion("kind", [
  assetImprovementEventSchema,
  assetDisposalEventSchema,
  assetRetractionEventSchema,
]);

export type AssetImprovementEvent = z.infer<typeof assetImprovementEventSchema>;
export type AssetDisposalEvent = z.infer<typeof assetDisposalEventSchema>;
export type AssetRetractionEvent = z.infer<typeof assetRetractionEventSchema>;
export type AssetEvent = z.infer<typeof assetEventSchema>;
export type AssetEventKind = AssetEvent["kind"];

/** Maximum fractional digits of a configured percentage rate (e.g. "2.5", "3.3333"). */
export const DEPRECIATION_RATE_SCALE = 4;

/**
 * How the annual amount is derived. Both are user-configured data: Sona does
 * not pick a rate or useful life on the user's behalf.
 */
export const depreciationMethodSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("linear_percentage"),
    /** Annual rate in percent of the depreciable basis, e.g. "2", "2.5", "3". */
    annualRatePercent: nonNegativeDecimalSchema
      .refine((v) => !isZeroDecimal(v), { message: "annual rate must be greater than zero" })
      .refine((v) => (v.split(".")[1]?.length ?? 0) <= DEPRECIATION_RATE_SCALE, {
        message: `annual rate supports at most ${DEPRECIATION_RATE_SCALE} fractional digits`,
      }),
  }),
  z.object({
    kind: z.literal("linear_useful_life"),
    usefulLifeYears: z.number().int().positive(),
  }),
]);

export type DepreciationMethod = z.infer<typeof depreciationMethodSchema>;

/**
 * Versioned schedule configuration for one asset. A new version is appended
 * whenever the user changes the configuration; already-generated rows keep
 * pointing at the version that produced them.
 */
export const depreciationScheduleConfigSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    assetId: z.string().min(1),
    version: z.number().int().positive(),
    method: depreciationMethodSchema,
    /**
     * Pro rata temporis: the acquisition year (and a disposal year) is
     * depreciated by months in service, counting the acquisition and disposal
     * months as full months. When false, every year takes the full annual amount.
     */
    proRataTemporis: z.boolean(),
    /** Book value the schedule never depreciates below. Defaults to zero. */
    residualValue: nonNegativeMoneySchema.optional(),
    /** Fractional digits amounts are rounded to. Defaults to 2. */
    roundingScale: z.number().int().min(0).max(6).optional(),
    /** Ledger account debited each year, e.g. "Expenses:RealEstate:Depreciation:Musterstr 1". */
    expenseAccount: z.string().min(1),
    /** Contra-asset account credited each year, e.g. "Assets:RealEstate:Musterstr 1:AccumulatedDepreciation". */
    accumulatedDepreciationAccount: z.string().min(1),
    createdAt: isoTimestampSchema,
  })
  .refine((config) => config.expenseAccount !== config.accumulatedDepreciationAccount, {
    message: "expense and accumulated depreciation accounts must differ",
    path: ["accumulatedDepreciationAccount"],
  });

export type DepreciationScheduleConfig = z.infer<typeof depreciationScheduleConfigSchema>;

/** Default fractional digits for schedule amounts (currency minor units). */
export const DEFAULT_DEPRECIATION_ROUNDING_SCALE = 2;

/**
 * A generated depreciation transaction recorded for one asset-year, as the
 * persistence layer stores it (no review state — that lives on the ledger
 * transaction). Insert-only; one row per transaction.
 */
export const recordedDepreciationEntrySchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  assetId: z.string().min(1),
  /** Schedule configuration the transaction was generated from. */
  configId: z.string().min(1),
  year: z.number().int(),
  transactionId: z.string().min(1),
  /** Debit amount booked on the expense posting. */
  amount: nonNegativeMoneySchema,
  createdAt: isoTimestampSchema,
});

export type RecordedDepreciationEntry = z.infer<typeof recordedDepreciationEntrySchema>;
