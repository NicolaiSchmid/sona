/**
 * Depreciation schedule computation.
 *
 * Pure functions of asset configuration + append-only asset history. All
 * arithmetic is exact `BigInt` at the configured rounding scale; the last year
 * absorbs any rounding remainder so the schedule total equals the depreciable
 * basis (less residual value) exactly.
 *
 * Nothing here decides which rate or useful life applies — the schedule just
 * applies whatever the user configured and reports it as such.
 */
import { divideRoundHalfAwayFromZero, fromScaledBigInt, toScaledBigInt } from "../money/decimal";
import type { MoneyAmount } from "../money/types";
import {
  type Asset,
  type AssetComponentRole,
  type AssetDisposalEvent,
  type AssetEvent,
  type AssetImprovementEvent,
  DEFAULT_DEPRECIATION_ROUNDING_SCALE,
  DEPRECIATION_RATE_SCALE,
  DepreciationError,
  type DepreciationMethod,
  type DepreciationScheduleConfig,
} from "./types";

/** Hard stop so a mis-configured schedule cannot loop indefinitely. */
const MAX_SCHEDULE_YEARS = 200;

/** Parses `value` at `scale`, reporting precision/format problems as domain errors. */
function scaled(value: string, scale: number, label: string): bigint {
  try {
    return toScaledBigInt(value, scale);
  } catch (error) {
    // Both InvalidDecimalError and the precision error are plain Errors.
    if (error instanceof Error) {
      throw new DepreciationError(`${label}: ${error.message}`);
    }
    throw error;
  }
}

// --- Acquisition cost allocation --------------------------------------------

export interface ComponentCostAllocation {
  componentId: string;
  role: AssetComponentRole;
  label: string;
  depreciable: boolean;
  /** Purchase price share configured for this component. */
  cost: string;
  /** Side costs allocated proportionally to `cost`. */
  allocatedSideCosts: string;
  /** `cost + allocatedSideCosts`. */
  total: string;
}

export interface AcquisitionCostAllocation {
  commodity: string;
  scale: number;
  purchasePrice: string;
  sideCosts: string;
  totalAcquisitionCost: string;
  /** Sum of `total` over depreciable components. */
  depreciableBasis: string;
  components: ComponentCostAllocation[];
}

/**
 * Splits `total` across `weights` proportionally using the largest-remainder
 * method: every share is floored at unit precision and the leftover units go
 * to the largest fractional remainders (ties by position). Shares are never
 * negative and always sum to `total` exactly.
 */
function allocateProportionally(total: bigint, weights: readonly bigint[]): bigint[] {
  const weightSum = weights.reduce((sum, w) => sum + w, 0n);
  const products = weights.map((w) => total * w);
  const shares = products.map((p) => p / weightSum);
  // Fewer leftover units than weights, so Number() is exact.
  const leftover = Number(total - shares.reduce((sum, s) => sum + s, 0n));
  const byRemainder = products
    .map((p, i) => ({ i, r: p % weightSum }))
    .sort((a, b) => (a.r > b.r ? -1 : a.r < b.r ? 1 : 0)); // stable: ties keep position order
  for (const { i } of byRemainder.slice(0, leftover)) {
    shares[i] = (shares[i] ?? 0n) + 1n;
  }
  return shares;
}

/**
 * Splits acquisition side costs across components proportional to their cost
 * share (largest-remainder rounding at `scale`), so the allocated total equals
 * the side costs exactly and no component receives a negative share.
 */
export function allocateAcquisitionCosts(
  asset: Asset,
  scale: number = DEFAULT_DEPRECIATION_ROUNDING_SCALE,
): AcquisitionCostAllocation {
  const costs = asset.components.map((c) => scaled(c.cost.amount, scale, `Component ${c.id}`));
  const purchasePrice = costs.reduce((sum, c) => sum + c, 0n);
  if (purchasePrice <= 0n) {
    throw new DepreciationError(`Asset ${asset.id} has no positive component cost`);
  }
  const sideCosts = asset.acquisitionSideCosts
    .map((s) => scaled(s.amount.amount, scale, `Side cost ${s.id}`))
    .reduce((sum, s) => sum + s, 0n);
  const shares = allocateProportionally(sideCosts, costs);

  let depreciableBasis = 0n;
  const components: ComponentCostAllocation[] = asset.components.map((component, index) => {
    const cost = costs[index] ?? 0n;
    const share = shares[index] ?? 0n;
    const total = cost + share;
    if (component.depreciable) {
      depreciableBasis += total;
    }
    return {
      componentId: component.id,
      role: component.role,
      label: component.label,
      depreciable: component.depreciable,
      cost: fromScaledBigInt(cost, scale),
      allocatedSideCosts: fromScaledBigInt(share, scale),
      total: fromScaledBigInt(total, scale),
    };
  });

  return {
    commodity: asset.commodity,
    scale,
    purchasePrice: fromScaledBigInt(purchasePrice, scale),
    sideCosts: fromScaledBigInt(sideCosts, scale),
    totalAcquisitionCost: fromScaledBigInt(purchasePrice + sideCosts, scale),
    depreciableBasis: fromScaledBigInt(depreciableBasis, scale),
    components,
  };
}

// --- Schedule ----------------------------------------------------------------

/** Why a row's amount deviates from a plain full-year amount. */
export const DEPRECIATION_ROW_NOTES = [
  /** Fewer than 12 months counted (acquisition or disposal year). */
  "pro_rata",
  /** Amount capped at the remaining depreciable book value. */
  "final_remainder",
  /** The asset was disposed of in this year. */
  "disposal_year",
  /** An improvement re-opened a schedule that was already fully depreciated. */
  "post_completion_improvement",
] as const;

export type DepreciationRowNote = (typeof DEPRECIATION_ROW_NOTES)[number];

export interface DepreciationScheduleRow {
  year: number;
  /** Months counted for this year (12 unless pro rata applies). */
  monthsInService: number;
  /** Depreciable basis in effect this year: acquisition basis plus improvements applied so far. */
  depreciableBasis: string;
  /** Depreciable book value (basis less accumulated depreciation) at the start of the year. */
  openingBookValue: string;
  amount: string;
  closingBookValue: string;
  accumulatedDepreciation: string;
  notes: DepreciationRowNote[];
  /**
   * Events applied so far (improvements, and the disposal in the disposal
   * year). Their evidence carries onto the row; only improvements to
   * depreciable components raise the basis.
   */
  appliedEventIds: string[];
  /** Acquisition, side-cost, and applied-event documents substantiating this row. */
  evidenceDocumentIds: string[];
  /**
   * Contributors to this row that have no evidence document at all, as
   * `asset:<id>`, `side_cost:<id>`, or `event:<id>`. Empty when every cost
   * feeding the row is substantiated.
   */
  missingEvidenceFor: string[];
}

export interface DepreciationSchedule {
  assetId: string;
  configId: string;
  configVersion: number;
  method: DepreciationMethod;
  proRataTemporis: boolean;
  commodity: string;
  scale: number;
  /** Depreciable basis at acquisition (components + allocated side costs). */
  acquisitionBasis: string;
  residualValue: string;
  /** Sum of all row amounts. */
  totalDepreciation: string;
  /** True once the basis (less residual) is fully depreciated or the asset was disposed. */
  complete: boolean;
  disposedOn: string | undefined;
  rows: DepreciationScheduleRow[];
}

export interface ComputeDepreciationScheduleInput {
  asset: Asset;
  config: DepreciationScheduleConfig;
  /** Append-only asset history. Only events for `asset.id` are accepted. */
  events?: readonly AssetEvent[];
}

interface YearMonth {
  year: number;
  month: number;
}

function parseYearMonth(date: string, label: string): YearMonth {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(date);
  if (match === null) {
    throw new DepreciationError(`${label} must be an ISO date (YYYY-MM-DD): ${date}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw new DepreciationError(`${label} has an invalid month: ${date}`);
  }
  return { year, month };
}

function isBefore(a: YearMonth, b: YearMonth): boolean {
  return a.year < b.year || (a.year === b.year && a.month < b.month);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function requireMoneyInCommodity(
  money: MoneyAmount,
  commodity: string,
  scale: number,
  label: string,
): bigint {
  if (money.commodity !== commodity) {
    throw new DepreciationError(
      `${label} is denominated in ${money.commodity}, expected ${commodity}`,
    );
  }
  return scaled(money.amount, scale, label);
}

interface ValidatedDisposal {
  event: AssetDisposalEvent;
  /** Parsed `event.occurredOn`. */
  on: YearMonth;
}

interface ValidatedEvents {
  improvementsByYear: Map<number, AssetImprovementEvent[]>;
  disposal: ValidatedDisposal | undefined;
}

/**
 * Resolves retractions: returns the ids of events a retraction points at,
 * validating that each target is in `events` (already checked to belong to
 * the asset) and is not itself a retraction.
 */
function retractedEventIds(events: readonly AssetEvent[]): Set<string> {
  const byId = new Map(events.map((e) => [e.id, e] as const));
  const retracted = new Set<string>();
  for (const event of events) {
    if (event.kind !== "retraction") {
      continue;
    }
    const target = byId.get(event.retractsEventId);
    if (target === undefined) {
      throw new DepreciationError(
        `Retraction ${event.id} references unknown event ${event.retractsEventId}`,
      );
    }
    if (target.kind === "retraction") {
      throw new DepreciationError(`Retraction ${event.id} cannot retract another retraction`);
    }
    retracted.add(target.id);
  }
  return retracted;
}

function validateEvents(
  asset: Asset,
  events: readonly AssetEvent[],
  acquired: YearMonth,
): ValidatedEvents {
  const componentIds = new Set(asset.components.map((c) => c.id));
  const improvements: Array<{ event: AssetImprovementEvent; on: YearMonth }> = [];
  let disposal: ValidatedDisposal | undefined;

  for (const event of events) {
    if (event.assetId !== asset.id || event.workspaceId !== asset.workspaceId) {
      throw new DepreciationError(`Event ${event.id} does not belong to asset ${asset.id}`);
    }
  }
  const retracted = retractedEventIds(events);

  for (const event of events) {
    if (event.kind === "retraction" || retracted.has(event.id)) {
      continue;
    }
    const on = parseYearMonth(event.occurredOn, `Event ${event.id} occurredOn`);
    if (isBefore(on, acquired)) {
      throw new DepreciationError(
        `Event ${event.id} occurred before the asset was acquired (${asset.acquiredOn})`,
      );
    }
    if (event.kind === "improvement") {
      if (!componentIds.has(event.componentId)) {
        throw new DepreciationError(
          `Improvement ${event.id} references unknown component ${event.componentId}`,
        );
      }
      improvements.push({ event, on });
    } else {
      if (disposal !== undefined) {
        throw new DepreciationError(`Asset ${asset.id} has more than one disposal event`);
      }
      disposal = { event, on };
    }
  }

  const improvementsByYear = new Map<number, AssetImprovementEvent[]>();
  for (const { event, on } of improvements) {
    if (disposal !== undefined && isBefore(disposal.on, on)) {
      throw new DepreciationError(
        `Improvement ${event.id} occurred after disposal on ${disposal.event.occurredOn}`,
      );
    }
    const bucket = improvementsByYear.get(on.year) ?? [];
    bucket.push(event);
    improvementsByYear.set(on.year, bucket);
  }

  return { improvementsByYear, disposal };
}

/**
 * Computes the full depreciation schedule for an asset under one configuration
 * version, from the acquisition year until the basis is exhausted or the asset
 * is disposed.
 *
 * Method semantics (configured behaviour, not legal claims):
 *
 * - `linear_percentage`: each year takes `basis × rate` (pro rata by months in
 *   the acquisition/disposal year); the final year takes whatever remains so
 *   the schedule total equals the basis exactly.
 * - `linear_useful_life`: each year spreads the remaining depreciable book
 *   value evenly over the remaining months of the configured useful life. This
 *   is self-correcting for rounding and naturally re-spreads an improvement
 *   over the remaining life.
 *
 * Improvements raise the basis of their component from their year onward as
 * a full-year amount; earlier rows are unaffected. An improvement after the
 * asset is fully depreciated re-opens the schedule and is flagged.
 */
export function computeDepreciationSchedule(
  input: ComputeDepreciationScheduleInput,
): DepreciationSchedule {
  const { asset, config } = input;
  if (config.assetId !== asset.id || config.workspaceId !== asset.workspaceId) {
    throw new DepreciationError(`Config ${config.id} does not belong to asset ${asset.id}`);
  }

  const scale = config.roundingScale ?? DEFAULT_DEPRECIATION_ROUNDING_SCALE;
  const allocation = allocateAcquisitionCosts(asset, scale);
  const acquired = parseYearMonth(asset.acquiredOn, "acquiredOn");
  const { improvementsByYear, disposal } = validateEvents(asset, input.events ?? [], acquired);

  const residual =
    config.residualValue === undefined
      ? 0n
      : requireMoneyInCommodity(config.residualValue, asset.commodity, scale, "Residual value");
  const acquisitionBasis = toScaledBigInt(allocation.depreciableBasis, scale);
  if (acquisitionBasis < residual) {
    throw new DepreciationError(
      `Residual value ${config.residualValue?.amount} exceeds depreciable basis ${allocation.depreciableBasis}`,
    );
  }

  const depreciableComponentIds = new Set(
    asset.components.filter((c) => c.depreciable).map((c) => c.id),
  );
  const baseEvidence = unique([
    ...asset.evidenceDocumentIds,
    ...asset.acquisitionSideCosts.flatMap((s) => s.evidenceDocumentIds),
  ]);
  const baseMissing = [
    ...(asset.evidenceDocumentIds.length === 0 ? [`asset:${asset.id}`] : []),
    ...asset.acquisitionSideCosts
      .filter((s) => s.evidenceDocumentIds.length === 0)
      .map((s) => `side_cost:${s.id}`),
  ];
  const lastImprovementYear = Math.max(acquired.year - 1, ...improvementsByYear.keys());

  const rows: DepreciationScheduleRow[] = [];
  /** Improvements applied so far, plus the disposal in its year; each row reports their evidence. */
  const applied: Array<AssetImprovementEvent | AssetDisposalEvent> = [];
  let basis = acquisitionBasis;
  let accumulated = 0n;
  let monthsElapsed = 0;

  for (let year = acquired.year; ; year++) {
    if (year - acquired.year >= MAX_SCHEDULE_YEARS) {
      throw new DepreciationError(
        `Schedule for asset ${asset.id} did not terminate within ${MAX_SCHEDULE_YEARS} years`,
      );
    }

    const exhaustedBefore = rows.length > 0 && basis - residual - accumulated <= 0n;
    const improvements = improvementsByYear.get(year) ?? [];
    for (const improvement of improvements) {
      applied.push(improvement);
      if (depreciableComponentIds.has(improvement.componentId)) {
        basis += requireMoneyInCommodity(
          improvement.amount,
          asset.commodity,
          scale,
          `Improvement ${improvement.id}`,
        );
      }
    }

    const remaining = basis - residual - accumulated;
    const isDisposalYear = disposal?.on.year === year;
    if (isDisposalYear) {
      applied.push(disposal.event);
    }
    if (remaining <= 0n) {
      if (isDisposalYear || year >= lastImprovementYear) {
        break;
      }
      continue;
    }

    const notes: DepreciationRowNote[] = [];
    let months = 12;
    if (config.proRataTemporis) {
      const firstMonth = year === acquired.year ? acquired.month : 1;
      const lastMonth = isDisposalYear ? disposal.on.month : 12;
      months = lastMonth - firstMonth + 1;
      if (months < 12) {
        notes.push("pro_rata");
      }
    }
    if (months < 1) {
      throw new DepreciationError(`Asset ${asset.id} has no months in service in ${year}`);
    }
    if (isDisposalYear) {
      notes.push("disposal_year");
    }
    if (exhaustedBefore && improvements.length > 0) {
      notes.push("post_completion_improvement");
    }

    let amount = yearAmount(config.method, { basis, remaining, months, monthsElapsed });
    if (amount <= 0n) {
      throw new DepreciationError(
        `Configured rule for asset ${asset.id} rounds to zero in ${year} at scale ${scale}`,
      );
    }
    if (amount >= remaining) {
      amount = remaining;
      if (!isDisposalYear) {
        notes.push("final_remainder");
      }
    }

    rows.push({
      year,
      monthsInService: months,
      depreciableBasis: fromScaledBigInt(basis, scale),
      openingBookValue: fromScaledBigInt(basis - accumulated, scale),
      amount: fromScaledBigInt(amount, scale),
      closingBookValue: fromScaledBigInt(basis - accumulated - amount, scale),
      accumulatedDepreciation: fromScaledBigInt(accumulated + amount, scale),
      notes,
      appliedEventIds: applied.map((e) => e.id),
      evidenceDocumentIds: unique([
        ...baseEvidence,
        ...applied.flatMap((e) => e.evidenceDocumentIds),
      ]),
      missingEvidenceFor: [
        ...baseMissing,
        ...applied.filter((e) => e.evidenceDocumentIds.length === 0).map((e) => `event:${e.id}`),
      ],
    });
    accumulated += amount;
    monthsElapsed += months;

    if (isDisposalYear) {
      break;
    }
    if (basis - residual - accumulated <= 0n && year >= lastImprovementYear) {
      break;
    }
  }

  const complete = disposal !== undefined || basis - residual - accumulated <= 0n;

  return {
    assetId: asset.id,
    configId: config.id,
    configVersion: config.version,
    method: config.method,
    proRataTemporis: config.proRataTemporis,
    commodity: asset.commodity,
    scale,
    acquisitionBasis: allocation.depreciableBasis,
    residualValue: fromScaledBigInt(residual, scale),
    totalDepreciation: fromScaledBigInt(accumulated, scale),
    complete,
    disposedOn: disposal?.event.occurredOn,
    rows,
  };
}

interface YearAmountContext {
  /** Depreciable basis in effect this year. */
  basis: bigint;
  /** Basis less residual less accumulated depreciation before this year. */
  remaining: bigint;
  /** Months counted for this year. */
  months: number;
  /** Months already counted in prior rows. */
  monthsElapsed: number;
}

function yearAmount(method: DepreciationMethod, ctx: YearAmountContext): bigint {
  switch (method.kind) {
    case "linear_percentage": {
      const rate = toScaledBigInt(method.annualRatePercent, DEPRECIATION_RATE_SCALE);
      const numerator = ctx.basis * rate * BigInt(ctx.months);
      const denominator = 10n ** BigInt(DEPRECIATION_RATE_SCALE) * 100n * 12n;
      return divideRoundHalfAwayFromZero(numerator, denominator);
    }
    case "linear_useful_life": {
      const remainingMonths = method.usefulLifeYears * 12 - ctx.monthsElapsed;
      if (remainingMonths <= ctx.months) {
        return ctx.remaining;
      }
      return divideRoundHalfAwayFromZero(
        ctx.remaining * BigInt(ctx.months),
        BigInt(remainingMonths),
      );
    }
  }
}

/** Human-readable label of a configured method, for exports and descriptions. */
export function describeDepreciationMethod(method: DepreciationMethod): string {
  switch (method.kind) {
    case "linear_percentage":
      return `linear ${method.annualRatePercent} % per year`;
    case "linear_useful_life":
      return `linear over ${method.usefulLifeYears} years`;
  }
}
