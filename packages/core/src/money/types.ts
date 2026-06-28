/**
 * Money is an amount paired with a commodity (currency or asset symbol).
 * Amounts are decimal strings, never floats. See {@link ./decimal}.
 */
export interface MoneyAmount {
  /** Decimal string, e.g. "-84.23". */
  amount: string;
  /** ISO 4217 currency code or asset symbol, e.g. "EUR", "USD", "VWRL". */
  commodity: string;
}
