/**
 * Draft ledger postings for portfolio events.
 *
 * Every event becomes one balanced double-entry transaction with each leg
 * explicit: net cash, acquisition cost, fees, taxes, and — when the gross
 * amount is in another currency — a conversion pair so every commodity
 * balances on its own. Counter-accounts are configurable; unknown counterparts
 * (deposits, withdrawals, deliveries) go to a suspense account until the user
 * reconciles them. Sale and outbound-delivery proceeds are parked in a
 * disposal suspense account because Sona tracks no lots and cannot split cost
 * basis from realized gain. The result is always `draft`: nothing here is
 * approved.
 */

import { validateBalancedTransaction } from "../ledger/balance";
import type { LedgerPosting, LedgerTransaction } from "../ledger/types";
import {
  absDecimal,
  isNegativeDecimal,
  isZeroDecimal,
  negateDecimal,
  sumDecimals,
} from "../money/decimal";
import type { MoneyAmount } from "../money/types";
import {
  type CashMovement,
  cashDirectionFor,
  type PortfolioEvent,
  type SecurityRef,
  type SecurityTransaction,
} from "./types";

/** Ledger accounts portfolio drafts book against. All paths are configurable. */
export interface PortfolioLedgerAccounts {
  /** Broker cash balance. */
  brokerCash: string;
  /** Securities positions at acquisition cost in booking currency. */
  brokerSecurities: string;
  dividends: string;
  interest: string;
  interestCharges: string;
  /** Period fees not tied to a position movement (custody, account fees, fees on income). */
  fees: string;
  /**
   * Fees on buys, sells, deliveries, and position transfers. Kept apart from
   * period fees so the export can tell acquisition/disposal costs from
   * running expenses; whether they are capitalized is a review decision.
   */
  tradeCosts: string;
  /** Taxes deducted by the broker on income and disposals (withholding, Kapitalertragsteuer, …). */
  taxesWithheld: string;
  /** Taxes charged on a purchase (transaction/stamp taxes); not withheld income tax. */
  transactionTaxes: string;
  /** Counter-leg for deposits/withdrawals/deliveries until matched to a bank leg. */
  transferSuspense: string;
  /**
   * Counter-leg for sale and outbound-delivery proceeds. Sona tracks no lots,
   * so it cannot split proceeds into cost basis and realized gain; the user
   * allocates from here.
   */
  disposalSuspense: string;
  /** Pass-through account for gross amounts booked in another currency. */
  currencyConversion: string;
}

export const DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS = {
  brokerCash: "Assets:Broker:Cash",
  brokerSecurities: "Assets:Broker:Securities",
  dividends: "Income:Dividends",
  interest: "Income:Interest",
  interestCharges: "Expenses:Investment:Interest",
  fees: "Expenses:Investment:Fees",
  tradeCosts: "Expenses:Investment:TradeCosts",
  taxesWithheld: "Expenses:Investment:TaxesWithheld",
  transactionTaxes: "Expenses:Investment:TransactionTaxes",
  transferSuspense: "Suspense:Unclassified",
  disposalSuspense: "Suspense:Disposals",
  currencyConversion: "Equity:CurrencyConversion",
} as const satisfies PortfolioLedgerAccounts;

export interface PortfolioDraftTransaction extends LedgerTransaction {
  reviewState: "draft";
  /** External id of the portfolio event this draft was derived from. */
  sourceEventExternalId: string;
}

export interface BuildPortfolioDraftInput {
  workspaceId: string;
  /** Id generator for the transaction and its postings. */
  ids: () => string;
  createdAt: string;
  accounts?: PortfolioLedgerAccounts;
}

/** Thrown when a recipe yields unbalanced postings — an invariant violation. */
export class UnbalancedPortfolioDraftError extends Error {
  readonly errors: readonly string[];
  constructor(eventExternalId: string, errors: readonly string[]) {
    super(`Portfolio draft for ${eventExternalId} does not balance: ${errors.join("; ")}`);
    this.name = "UnbalancedPortfolioDraftError";
    this.errors = errors;
  }
}

interface Leg {
  account: string;
  amount: MoneyAmount;
  memo?: string;
}

function leg(account: string, amount: string, commodity: string, memo?: string): Leg {
  return memo === undefined
    ? { account, amount: { amount, commodity } }
    : { account, amount: { amount, commodity }, memo };
}

function securityLabel(security: SecurityRef | undefined): string {
  if (security === undefined) {
    return "";
  }
  const name = security.name ?? security.ticker ?? security.wkn ?? security.isin ?? "security";
  return security.isin !== undefined && security.name !== undefined
    ? `${name} (${security.isin})`
    : name;
}

/**
 * Thrown for an event whose data cannot be booked (wrong sign for its type,
 * negative charges, charges exceeding the amount). A data condition, not a
 * bug — batch callers should record it per event rather than abort.
 */
export class InvalidPortfolioEventError extends Error {
  readonly eventExternalId: string;
  constructor(eventExternalId: string, message: string) {
    super(`Portfolio event ${eventExternalId}: ${message}`);
    this.name = "InvalidPortfolioEventError";
    this.eventExternalId = eventExternalId;
  }
}

function assertNonNegative(label: string, value: string, eventExternalId: string): void {
  if (isNegativeDecimal(value)) {
    throw new InvalidPortfolioEventError(eventExternalId, `negative ${label}: ${value}`);
  }
}

/**
 * The public builder accepts events from any caller, so the amount's sign must
 * agree with the event type's cash direction: a "buy" with a positive amount
 * would produce a balanced but economically inverted draft.
 */
function assertDirection(event: PortfolioEvent): void {
  const amount = event.amount.amount;
  if (isZeroDecimal(amount)) {
    return;
  }
  const expectedOutflow = cashDirectionFor(event.type) === "outflow";
  if (isNegativeDecimal(amount) !== expectedOutflow) {
    throw new InvalidPortfolioEventError(
      event.externalId,
      `${event.type} has amount ${amount} but is an ${expectedOutflow ? "outflow" : "inflow"}`,
    );
  }
}

/** Which accounts the fee and tax legs of a security transaction book to. */
interface ChargeLegKinds {
  /** `trade` for position movements (acquisition/disposal cost), `period` otherwise. */
  fee: "trade" | "period";
  /** `transaction` for taxes charged on a purchase, `withheld` for taxes deducted by the broker. */
  tax: "transaction" | "withheld";
}

/** Fee and tax legs shared by trades, income, and deliveries; zero legs are omitted. */
function chargeLegs(
  event: SecurityTransaction,
  commodity: string,
  accounts: PortfolioLedgerAccounts,
  kinds: ChargeLegKinds,
): Leg[] {
  const legs: Leg[] = [];
  if (!isZeroDecimal(event.fees)) {
    legs.push(
      kinds.fee === "trade"
        ? leg(accounts.tradeCosts, event.fees, commodity, "trade fees")
        : leg(accounts.fees, event.fees, commodity, "broker fees"),
    );
  }
  if (!isZeroDecimal(event.taxes)) {
    legs.push(
      kinds.tax === "withheld"
        ? leg(accounts.taxesWithheld, event.taxes, commodity, "taxes withheld by broker")
        : leg(accounts.transactionTaxes, event.taxes, commodity, "transaction taxes"),
    );
  }
  return legs;
}

function incomeLegs(
  event: SecurityTransaction,
  incomeAccount: string,
  accounts: PortfolioLedgerAccounts,
): Leg[] {
  const commodity = event.amount.commodity;
  const net = event.amount.amount;
  const grossBooking = sumDecimals([net, event.fees, event.taxes]);
  const legs: Leg[] = [
    leg(accounts.brokerCash, net, commodity, "net credited"),
    ...chargeLegs(event, commodity, accounts, { fee: "period", tax: "withheld" }),
  ];
  const gross = event.gross;
  if (gross !== undefined && gross.commodity !== commodity) {
    // Gross stays in its own currency so the foreign amount is preserved as
    // evidence; the conversion pair makes both commodities balance.
    legs.push(
      leg(incomeAccount, negateDecimal(gross.amount), gross.commodity, "gross"),
      leg(accounts.currencyConversion, gross.amount, gross.commodity, "conversion"),
      leg(
        accounts.currencyConversion,
        negateDecimal(grossBooking),
        commodity,
        `conversion @ ${event.exchangeRate ?? "unknown rate"}`,
      ),
    );
  } else {
    legs.push(leg(incomeAccount, negateDecimal(grossBooking), commodity, "gross"));
  }
  return legs;
}

function sharesMemoFor(event: SecurityTransaction): string | undefined {
  return event.shares === undefined ? undefined : `${event.shares} shares`;
}

/**
 * Deliveries and position transfers move no cash, so the position and any
 * charges are all offset against suspense until the user reconciles them. An
 * outbound delivery leaves the portfolio at a user-reported value with no lot
 * basis, so — like a sale — its value goes to disposal suspense rather than
 * being credited against the position. Position transfers between own
 * accounts move at the reported (acquisition) value.
 */
function positionTransferLegs(
  event: SecurityTransaction,
  accounts: PortfolioLedgerAccounts,
): Leg[] {
  const commodity = event.amount.commodity;
  const net = event.amount.amount;
  const sharesMemo = sharesMemoFor(event);
  const counterpart = negateDecimal(sumDecimals([net, event.fees, event.taxes]));
  const label = event.type.startsWith("delivery") ? "delivery" : "position transfer";
  const positionLeg =
    event.type === "delivery_outbound"
      ? leg(
          accounts.disposalSuspense,
          net,
          commodity,
          `${sharesMemo ?? "outbound delivery"} at reported value; cost basis not computed — lot review required`,
        )
      : leg(accounts.brokerSecurities, net, commodity, sharesMemo ?? label);
  return [
    positionLeg,
    ...chargeLegs(event, commodity, accounts, { fee: "trade", tax: "withheld" }),
    leg(
      accounts.transferSuspense,
      counterpart,
      commodity,
      `${label} counterpart — review required`,
    ),
  ];
}

function securityTransactionLegs(
  event: SecurityTransaction,
  accounts: PortfolioLedgerAccounts,
): Leg[] {
  const commodity = event.amount.commodity;
  const net = event.amount.amount;
  const sharesMemo = sharesMemoFor(event);
  assertNonNegative("fees", event.fees, event.externalId);
  assertNonNegative("taxes", event.taxes, event.externalId);

  switch (event.type) {
    case "buy": {
      const cost = sumDecimals([
        absDecimal(net),
        negateDecimal(event.fees),
        negateDecimal(event.taxes),
      ]);
      assertNonNegative("acquisition cost (net minus fees and taxes)", cost, event.externalId);
      return [
        leg(accounts.brokerCash, net, commodity, "net debited"),
        leg(accounts.brokerSecurities, cost, commodity, sharesMemo ?? "acquisition"),
        ...chargeLegs(event, commodity, accounts, { fee: "trade", tax: "transaction" }),
      ];
    }
    case "sell": {
      // Proceeds are parked in suspense rather than credited to the position:
      // without lot tracking the cost basis is unknown, and crediting the
      // position by proceeds would silently misstate it by the realized result.
      const proceeds = sumDecimals([net, event.fees, event.taxes]);
      return [
        leg(accounts.brokerCash, net, commodity, "net credited"),
        leg(
          accounts.disposalSuspense,
          negateDecimal(proceeds),
          commodity,
          `${sharesMemo ?? "disposal"} proceeds; cost basis and realized gain/loss not computed — lot review required`,
        ),
        ...chargeLegs(event, commodity, accounts, { fee: "trade", tax: "withheld" }),
      ];
    }
    case "dividend":
      return incomeLegs(event, accounts.dividends, accounts);
    case "delivery_inbound":
    case "delivery_outbound":
    case "security_transfer_inbound":
    case "security_transfer_outbound":
      return positionTransferLegs(event, accounts);
  }
}

function cashMovementLegs(event: CashMovement, accounts: PortfolioLedgerAccounts): Leg[] {
  const commodity = event.amount.commodity;
  const net = event.amount.amount;
  const counter = negateDecimal(net);
  switch (event.type) {
    case "deposit":
    case "withdrawal":
      return [
        leg(accounts.brokerCash, net, commodity),
        leg(
          accounts.transferSuspense,
          counter,
          commodity,
          "transfer counterpart — match to bank leg",
        ),
      ];
    case "transfer_in":
    case "transfer_out":
      // Between the user's own broker cash accounts; both legs net out in
      // suspense once the counterpart account's export is imported.
      return [
        leg(accounts.brokerCash, net, commodity),
        leg(
          accounts.transferSuspense,
          counter,
          commodity,
          "internal transfer counterpart — review required",
        ),
      ];
    case "interest":
      return [leg(accounts.brokerCash, net, commodity), leg(accounts.interest, counter, commodity)];
    case "interest_charge":
      return [
        leg(accounts.brokerCash, net, commodity),
        leg(accounts.interestCharges, counter, commodity),
      ];
    case "fee":
    case "fee_refund":
      return [leg(accounts.brokerCash, net, commodity), leg(accounts.fees, counter, commodity)];
    case "tax":
    case "tax_refund":
      return [
        leg(accounts.brokerCash, net, commodity),
        leg(accounts.taxesWithheld, counter, commodity),
      ];
  }
}

function describeEvent(event: PortfolioEvent): string {
  const label = securityLabel(event.security);
  const base = `${event.type.replace(/_/g, " ")}${label === "" ? "" : ` ${label}`}`;
  return event.note === undefined || event.note === "" ? base : `${base} — ${event.note}`;
}

/**
 * Builds a balanced `draft` ledger transaction for a portfolio event. Throws
 * {@link UnbalancedPortfolioDraftError} if the recipe's legs do not balance per
 * commodity — that is a bug, not a data condition, so it is never persisted.
 */
export function buildPortfolioDraftTransaction(
  event: PortfolioEvent,
  input: BuildPortfolioDraftInput,
): PortfolioDraftTransaction {
  const accounts = input.accounts ?? DEFAULT_PORTFOLIO_LEDGER_ACCOUNTS;
  assertDirection(event);
  const legs =
    event.kind === "security_transaction"
      ? securityTransactionLegs(event, accounts)
      : cashMovementLegs(event, accounts);

  const balance = validateBalancedTransaction(legs);
  if (!balance.balanced) {
    throw new UnbalancedPortfolioDraftError(event.externalId, balance.errors);
  }

  const transactionId = input.ids();
  const postings: LedgerPosting[] = legs.map((l) => ({
    id: input.ids(),
    transactionId,
    account: l.account,
    amount: l.amount,
    ...(l.memo === undefined ? {} : { memo: l.memo }),
  }));

  return {
    id: transactionId,
    workspaceId: input.workspaceId,
    bookedOn: event.date,
    description: describeEvent(event),
    postings,
    reviewState: "draft",
    createdAt: input.createdAt,
    sourceEventExternalId: event.externalId,
  };
}
