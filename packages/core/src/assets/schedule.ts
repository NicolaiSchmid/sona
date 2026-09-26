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
  type DepreciationMethod,
  type DepreciationScheduleConfig,
} from "./types";

/** Hard stop so a mis-configured tiny rate cannot loop indefinitely. */
const MAX_SCHEDULE_YEARS = 200;

export class DepreciationScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DepreciationScheduleError";
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
 * Splits acquisition side costs across components proportional to their cost
 * share. Each component's share is rounded at `scale`; the last component
 * absorbs the remainder so the allocated total equals the side costs exactly.
 */
export function allocateAcquisitionCosts(
  asset: Asset,
  scale: number = DEFAULT_DEPRECIATION_ROUNDING_SCALE,
): AcquisitionCostAllocation {
  const costs = asset.components.map((c) => toScaledBigInt(c.cost.amount, scale));
  const purchasePrice = costs.reduce((sum, c) => sum + c, 0n);
  if (purchasePrice <= 0n) {
    throw new DepreciationScheduleError(`Asset ${asset.id} has no positive component cost`);
  }
  const sideCosts = asset.acquisitionSideCosts
    .map((s) => toScaledBigInt(s.amount.amount, scale))
    .reduce((sum, s) => sum + s, 0n);

  let allocated = 0n;
  let depreciableBasis = 0n;
  const components: ComponentCostAllocation[] = asset.components.map((component, index) => {
    const cost = costs[index] ?? 0n;
    const isLast = index === asset.components.length - 1;
    const share = isLast
      ? sideCosts - allocated
      : divideRoundHalfAwayFromZero(sideCosts * cost, purchasePrice);
    allocated += share;
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
export type DepreciationRowNote = "pro_rata" | "final_remainder" | "disposal_year";

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
  /** Improvement event ids whose amounts are part of this year's basis. */
  appliedEventIds: string[];
  /** Acquisition, side-cost, and applied-improvement documents substantiating this row. */
  evidenceDocumentIds: string[];
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
    throw new DepreciationScheduleError(`${label} must be an ISO date (YYYY-MM-DD): ${date}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw new DepreciationScheduleError(`${label} has an invalid month: ${date}`);
  }
  return { year, month };
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
    throw new DepreciationScheduleError(
      `${label} is denominated in ${money.commodity}, expected ${commodity}`,
    );
  }
  return toScaledBigInt(money.amount, scale);
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

function validateEvents(
  asset: Asset,
  events: readonly AssetEvent[],
  acquired: YearMonth,
): ValidatedEvents {
  const componentIds = new Set(asset.components.map((c) => c.id));
  const improvementsByYear = new Map<number, AssetImprovementEvent[]>();
  let disposal: ValidatedDisposal | undefined;

  for (const event of events) {
    if (event.assetId !== asset.id || event.workspaceId !== asset.workspaceId) {
      throw new DepreciationScheduleError(`Event ${event.id} does not belong to asset ${asset.id}`);
    }
    const occurred = parseYearMonth(event.occurredOn, `Event ${event.id} occurredOn`);
    if (occurred.year < acquired.year) {
      throw new DepreciationScheduleError(
        `Event ${event.id} occurred before the asset was acquired (${asset.acquiredOn})`,
      );
    }
    if (event.kind === "improvement") {
      if (!componentIds.has(event.componentId)) {
        throw new DepreciationScheduleError(
          `Improvement ${event.id} references unknown component ${event.componentId}`,
        );
      }
      const bucket = improvementsByYear.get(occurred.year) ?? [];
      bucket.push(event);
      improvementsByYear.set(occurred.year, bucket);
    } else {
      if (disposal !== undefined) {
        throw new DepreciationScheduleError(`Asset ${asset.id} has more than one disposal event`);
      }
      disposal = { event, on: occurred };
    }
  }

  if (disposal !== undefined) {
    for (const [year, improvements] of improvementsByYear) {
      if (year > disposal.on.year) {
        const ids = improvements.map((i) => i.id).join(", ");
        throw new DepreciationScheduleError(
          `Improvement ${ids} occurred after disposal on ${disposal.event.occurredOn}`,
        );
      }
    }
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
 * a full-year amount; earlier rows are unaffected.
 */
export function computeDepreciationSchedule(
  input: ComputeDepreciationScheduleInput,
): DepreciationSchedule {
  const { asset, config } = input;
  if (config.assetId !== asset.id || config.workspaceId !== asset.workspaceId) {
    throw new DepreciationScheduleError(`Config ${config.id} does not belong to asset ${asset.id}`);
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
    throw new DepreciationScheduleError(
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
  const lastImprovementYear = Math.max(acquired.year - 1, ...improvementsByYear.keys());

  const rows: DepreciationScheduleRow[] = [];
  const appliedEventIds: string[] = [];
  const appliedEvidence: string[] = [];
  let basis = acquisitionBasis;
  let accumulated = 0n;
  let monthsElapsed = 0;

  for (let year = acquired.year; ; year++) {
    if (rows.length >= MAX_SCHEDULE_YEARS) {
      throw new DepreciationScheduleError(
        `Schedule for asset ${asset.id} did not terminate within ${MAX_SCHEDULE_YEARS} years`,
      );
    }

    for (const improvement of improvementsByYear.get(year) ?? []) {
      appliedEventIds.push(improvement.id);
      appliedEvidence.push(...improvement.evidenceDocumentIds);
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
      const lastMonth = disposal?.on.year === year ? disposal.on.month : 12;
      months = lastMonth - firstMonth + 1;
      if (months < 12) {
        notes.push("pro_rata");
      }
    }
    if (isDisposalYear) {
      notes.push("disposal_year");
    }

    let amount = yearAmount(config.method, {
      basis,
      remaining,
      months,
      monthsElapsed,
    });
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
      appliedEventIds: [...appliedEventIds],
      evidenceDocumentIds: unique([...baseEvidence, ...appliedEvidence]),
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
      // rate is a decimal string like "2.5"; scale it to an integer numerator.
      const rateScale = (method.annualRatePercent.split(".")[1] ?? "").length;
      const rate = toScaledBigInt(method.annualRatePercent, rateScale);
      const numerator = ctx.basis * rate * BigInt(ctx.months);
      const denominator = 10n ** BigInt(rateScale) * 100n * 12n;
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
