/**
 * Money is an amount paired with a commodity (currency or asset symbol).
 * Amounts are decimal strings, never floats. See {@link ./decimal}.
 */
import { z } from "zod";
import { decimalsEqual, isValidDecimalString } from "./decimal";

export interface MoneyAmount {
  /** Decimal string, e.g. "-84.23". */
  amount: string;
  /** ISO 4217 currency code or asset symbol, e.g. "EUR", "USD", "VWRL". */
  commodity: string;
}

/** A syntactically valid decimal string (see {@link isValidDecimalString}). */
export const decimalStringSchema = z
  .string()
  .refine(isValidDecimalString, { message: "expected a decimal string" });

/** Boundary schema for {@link MoneyAmount}. */
export const moneyAmountSchema = z.object({
  amount: decimalStringSchema,
  commodity: z.string().min(1),
}) satisfies z.ZodType<MoneyAmount>;

/** Returns true if both amounts denote the same value in the same commodity ("6360" EUR equals "6360.00" EUR). */
export function moneyAmountsEqual(a: MoneyAmount, b: MoneyAmount): boolean {
  return a.commodity === b.commodity && decimalsEqual(a.amount, b.amount);
}
