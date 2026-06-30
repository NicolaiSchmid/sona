/**
 * Minimal shapes for the Enable Banking AIS API and Sona's normalized banking
 * records. These cover only the fields Sona consumes; the full provider payload
 * is always preserved on the normalized record's `raw` field and in the raw
 * source vault.
 */
import type { JsonValue } from "@sona/core";

/** `{ amount, currency }` as returned by the provider (amount is a string). */
export interface EbAmount {
  amount: string;
  currency: string;
}

export interface EbApplication {
  name: string;
  active?: boolean;
  redirect_urls?: string[];
}

export interface EbAspsp {
  name: string;
  country: string;
  [key: string]: JsonValue | undefined;
}

export interface EbAspspList {
  aspsps: EbAspsp[];
}

export interface EbAuthResponse {
  url: string;
  authorization_id?: string;
}

/** An account reference as returned in a session (uid + optional metadata). */
export interface EbAccountReference {
  uid: string;
  [key: string]: JsonValue | undefined;
}

export interface EbSession {
  session_id: string;
  status?: string;
  aspsp?: EbAspsp;
  accounts: Array<EbAccountReference | string>;
}

export interface EbAccountDetails {
  uid?: string;
  name?: string;
  product?: string;
  currency?: string;
  account_id?: { iban?: string; other?: { identification?: string } };
  cash_account_type?: string;
}

export interface EbBalance {
  name?: string;
  balance_amount: EbAmount;
  balance_type?: string;
  reference_date?: string;
}

export interface EbBalancesResponse {
  balances: EbBalance[];
}

export type EbCreditDebit = "CRDT" | "DBIT";

export interface EbTransaction {
  entry_reference?: string;
  transaction_amount: EbAmount;
  credit_debit_indicator: EbCreditDebit;
  booking_date?: string;
  value_date?: string;
  status?: string;
  creditor?: { name?: string };
  debtor?: { name?: string };
  remittance_information?: string[];
}

export interface EbTransactionsResponse {
  transactions: EbTransaction[];
  continuation_key?: string;
}

// --- Sona normalized records ------------------------------------------------

export interface NormalizedAccount {
  /** Stable provider id for the account. */
  externalId: string;
  name: string | undefined;
  iban: string | undefined;
  currency: string | undefined;
  product: string | undefined;
  raw: JsonValue;
}

export interface NormalizedBalance {
  accountExternalId: string;
  type: string | undefined;
  amount: string;
  currency: string;
  referenceDate: string | undefined;
  raw: JsonValue;
}

export interface NormalizedTransaction {
  accountExternalId: string;
  /** Stable provider id for the transaction. */
  externalId: string;
  bookedOn: string | undefined;
  valueDate: string | undefined;
  /** Signed decimal string: DBIT is negative, CRDT is positive. */
  amount: string;
  currency: string;
  counterpartyName: string | undefined;
  remittanceInfo: string | undefined;
  raw: JsonValue;
}
