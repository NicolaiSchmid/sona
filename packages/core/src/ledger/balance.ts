/**
 * Double-entry balance validation.
 *
 * A transaction is balanced when, for every commodity, the sum of its posting
 * amounts is exactly zero. Commodities balance independently — an EUR leg never
 * offsets a USD leg. Invalid decimal strings make the transaction unbalanced
 * with an explanatory error rather than throwing.
 */
import {
  InvalidDecimalError,
  isValidDecimalString,
  isZeroDecimal,
  sumDecimals,
} from "../money/decimal";
import type { MoneyAmount } from "../money/types";

export interface BalanceInputPosting {
  amount: MoneyAmount;
}

export interface BalanceResult {
  balanced: boolean;
  /** Net sum per commodity as a canonical decimal string. */
  totalsByCommodity: Record<string, string>;
  errors: string[];
}

export function validateBalancedTransaction(
  postings: readonly BalanceInputPosting[],
): BalanceResult {
  const errors: string[] = [];

  if (postings.length < 2) {
    return {
      balanced: false,
      totalsByCommodity: {},
      errors: ["Transaction must have at least two postings"],
    };
  }

  const amountsByCommodity = new Map<string, string[]>();
  for (const [index, posting] of postings.entries()) {
    const { amount, commodity } = posting.amount;
    if (commodity.length === 0) {
      errors.push(`Posting ${index} has an empty commodity`);
      continue;
    }
    if (!isValidDecimalString(amount)) {
      errors.push(`Posting ${index} has an invalid amount ${JSON.stringify(amount)}`);
      continue;
    }
    const bucket = amountsByCommodity.get(commodity);
    if (bucket) {
      bucket.push(amount);
    } else {
      amountsByCommodity.set(commodity, [amount]);
    }
  }

  const totalsByCommodity: Record<string, string> = {};
  for (const [commodity, amounts] of amountsByCommodity) {
    try {
      const total = sumDecimals(amounts);
      totalsByCommodity[commodity] = total;
      if (!isZeroDecimal(total)) {
        errors.push(`Commodity ${commodity} does not balance: net ${total}`);
      }
    } catch (error) {
      if (error instanceof InvalidDecimalError) {
        errors.push(`Commodity ${commodity} has an invalid amount ${JSON.stringify(error.value)}`);
      } else {
        throw error;
      }
    }
  }

  return { balanced: errors.length === 0, totalsByCommodity, errors };
}
