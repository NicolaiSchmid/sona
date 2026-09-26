/**
 * Portfolio domain: securities, broker accounts, security transactions, cash
 * movements, and informational valuation snapshots.
 *
 * Portfolio events are normalized from immutable raw source records (e.g. a
 * Portfolio Performance export). They are evidence for the ledger — draft
 * postings are derived from them (see {@link ./postings}) and never
 * auto-approved. Sona does not compute capital gains tax here; it collects
 * traceable events and flags what needs human review.
 */
import { isZeroDecimal } from "../money/decimal";
import type { MoneyAmount } from "../money/types";
import type { JsonValue } from "../util/hash";

/** Identifiers for a security. At least one of isin/wkn/ticker/name is set. */
export interface SecurityRef {
  isin: string | undefined;
  wkn: string | undefined;
  ticker: string | undefined;
  name: string | undefined;
}

export interface Security extends SecurityRef {
  id: string;
  workspaceId: string;
  /** Stable key derived from the strongest identifier; see {@link securityKey}. */
  key: string;
}

/**
 * Stable identity for a security: ISIN first, then WKN, ticker, and finally a
 * normalized name. Returns `undefined` if nothing identifies the security.
 */
export function securityKey(ref: SecurityRef): string | undefined {
  if (ref.isin !== undefined) {
    return `isin:${ref.isin.toUpperCase()}`;
  }
  if (ref.wkn !== undefined) {
    return `wkn:${ref.wkn.toUpperCase()}`;
  }
  if (ref.ticker !== undefined) {
    return `ticker:${ref.ticker.toUpperCase()}`;
  }
  if (ref.name !== undefined) {
    return `name:${ref.name.trim().toLowerCase()}`;
  }
  return undefined;
}

export const BROKER_ACCOUNT_KINDS = ["securities", "cash"] as const;

export type BrokerAccountKind = (typeof BROKER_ACCOUNT_KINDS)[number];

export function isBrokerAccountKind(value: string): value is BrokerAccountKind {
  return (BROKER_ACCOUNT_KINDS as readonly string[]).includes(value);
}

export interface BrokerAccount {
  id: string;
  workspaceId: string;
  sourceId: string;
  /** Provider-side account name/id, e.g. the Portfolio Performance account name. */
  externalId: string;
  name: string;
  kind: BrokerAccountKind;
  currency: string | undefined;
}

/**
 * Events that move a security position. `security_transfer_*` are position
 * transfers between securities accounts (Portfolio Performance labels them
 * "Umbuchung" like cash transfers); they move no cash and are booked like
 * deliveries.
 */
export const SECURITY_TRANSACTION_TYPES = [
  "buy",
  "sell",
  "delivery_inbound",
  "delivery_outbound",
  "security_transfer_inbound",
  "security_transfer_outbound",
  "dividend",
] as const;

export type SecurityTransactionType = (typeof SECURITY_TRANSACTION_TYPES)[number];

export const CASH_MOVEMENT_TYPES = [
  "deposit",
  "withdrawal",
  "transfer_in",
  "transfer_out",
  "interest",
  "interest_charge",
  "fee",
  "fee_refund",
  "tax",
  "tax_refund",
] as const;

export type CashMovementType = (typeof CASH_MOVEMENT_TYPES)[number];

export type PortfolioEventType = SecurityTransactionType | CashMovementType;

export function isSecurityTransactionType(value: string): value is SecurityTransactionType {
  return (SECURITY_TRANSACTION_TYPES as readonly string[]).includes(value);
}

export function isCashMovementType(value: string): value is CashMovementType {
  return (CASH_MOVEMENT_TYPES as readonly string[]).includes(value);
}

/** Cash direction of an event type from the broker account's perspective. */
export type CashDirection = "inflow" | "outflow";

const OUTFLOW_TYPES: ReadonlySet<PortfolioEventType> = new Set<PortfolioEventType>([
  "buy",
  "delivery_outbound",
  "security_transfer_outbound",
  "withdrawal",
  "transfer_out",
  "interest_charge",
  "fee",
  "tax",
]);

export function cashDirectionFor(type: PortfolioEventType): CashDirection {
  return OUTFLOW_TYPES.has(type) ? "outflow" : "inflow";
}

interface PortfolioEventBase {
  /** Stable, provider-or-content-derived id; the idempotency key for imports. */
  externalId: string;
  /** External id of the broker account the event is booked on. */
  brokerAccountExternalId: string;
  /** ISO YYYY-MM-DD. */
  date: string;
  /**
   * Signed net cash effect on the broker account in its booking currency.
   * Deposits, sales, and dividends are positive; buys, fees, taxes, and
   * withdrawals are negative. Deliveries carry the reported value.
   */
  amount: MoneyAmount;
  note: string | undefined;
  /** Provider payload the event was normalized from (also in the raw vault). */
  raw: JsonValue;
}

export interface SecurityTransaction extends PortfolioEventBase {
  kind: "security_transaction";
  type: SecurityTransactionType;
  security: SecurityRef;
  /** Number of shares as a decimal string, if reported. */
  shares: string | undefined;
  /**
   * Gross amount in the security's trading currency when it differs from the
   * booking currency (e.g. a USD dividend booked on a EUR account).
   */
  gross: MoneyAmount | undefined;
  exchangeRate: string | undefined;
  /** Fees in booking currency as a non-negative decimal string. */
  fees: string;
  /**
   * Taxes deducted in booking currency as a non-negative decimal string. For
   * dividends this is the withholding shown by the broker; whether it is
   * foreign withholding is only *suggested* (see {@link suggestsForeignWithholding}).
   */
  taxes: string;
}

export interface CashMovement extends PortfolioEventBase {
  kind: "cash_movement";
  type: CashMovementType;
  /** Some fee/tax rows reference a security (e.g. custody fee per position). */
  security: SecurityRef | undefined;
}

export type PortfolioEvent = SecurityTransaction | CashMovement;

/** Cash movements that pair with a bank transaction leg (external transfers). */
export const TRANSFER_LEG_TYPES = [
  "deposit",
  "withdrawal",
] as const satisfies readonly CashMovementType[];

export type TransferLegType = (typeof TRANSFER_LEG_TYPES)[number];

export function isTransferLeg(
  event: PortfolioEvent,
): event is CashMovement & { type: TransferLegType } {
  return (
    event.kind === "cash_movement" && (TRANSFER_LEG_TYPES as readonly string[]).includes(event.type)
  );
}

/**
 * Heuristic *suggestion* that a dividend's deducted tax is foreign withholding:
 * the gross currency differs from the booking currency, or the ISIN country
 * prefix is not the home country. This is not a legal determination; the
 * flagged events must be reviewed by the user.
 */
export function suggestsForeignWithholding(
  event: SecurityTransaction,
  homeCountry = "DE",
): boolean {
  if (event.type !== "dividend" || isZeroDecimal(event.taxes)) {
    return false;
  }
  if (event.gross !== undefined && event.gross.commodity !== event.amount.commodity) {
    return true;
  }
  const isin = event.security.isin?.toUpperCase();
  return isin !== undefined && isin.length >= 2 && !isin.startsWith(homeCountry.toUpperCase());
}

// --- Valuation snapshots ------------------------------------------------------

export const VALUATION_SOURCES = ["portfolio_performance", "manual"] as const;

export type ValuationSource = (typeof VALUATION_SOURCES)[number];

export function isValuationSource(value: string): value is ValuationSource {
  return (VALUATION_SOURCES as readonly string[]).includes(value);
}

/**
 * Informational point-in-time valuation of a position or account. Snapshots
 * are append-only reference data and are never ledger postings.
 */
export interface ValuationSnapshot {
  /** Caller-assigned; importers derive it from the holding's identity so re-imports collide. */
  readonly id: string;
  readonly workspaceId: string;
  readonly sourceId: string;
  readonly brokerAccountExternalId: string | undefined;
  readonly security: SecurityRef | undefined;
  /** ISO YYYY-MM-DD the valuation refers to. */
  readonly asOf: string;
  readonly shares: string | undefined;
  readonly marketValue: MoneyAmount;
  readonly valuationSource: ValuationSource;
  /** Raw source record the snapshot came from, if imported. */
  readonly rawRecordId: string | undefined;
  readonly createdAt: string;
}

/**
 * Creates a frozen, informational valuation snapshot. The input already has the
 * final shape; this factory only deep-freezes it so stored snapshots cannot be
 * edited in place.
 */
export function createValuationSnapshot(input: ValuationSnapshot): ValuationSnapshot {
  return Object.freeze({
    ...input,
    security: input.security === undefined ? undefined : Object.freeze({ ...input.security }),
    marketValue: Object.freeze({ ...input.marketValue }),
  });
}
