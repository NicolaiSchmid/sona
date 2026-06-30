/**
 * Normalizers turn raw Enable Banking payloads into Sona's banking records.
 * Each normalized record keeps a deep-cloned copy of the provider payload on
 * `raw`, and uses a stable external id so repeated syncs are idempotent.
 */
import { type JsonValue, stableJsonHash } from "@sona/core";
import type {
  EbAccountDetails,
  EbBalance,
  EbSession,
  EbTransaction,
  NormalizedAccount,
  NormalizedBalance,
  NormalizedTransaction,
} from "./types.js";

/** Deep-clones a JSON payload, stripping `undefined`, into a `JsonValue`. */
function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/** Extracts the account uids referenced by a session. */
export function accountUidsFromSession(session: EbSession): string[] {
  return session.accounts.map((account) => (typeof account === "string" ? account : account.uid));
}

export function normalizeAccount(details: EbAccountDetails): NormalizedAccount {
  const raw = asJson(details);
  // Enable Banking's `uid` is only valid for the current authorized session, so
  // prefer the stable identification hash; fall back to IBAN, then a content
  // hash. The session `uid` is intentionally not used as the durable id.
  const externalId =
    details.identification_hash ??
    details.identification_hashes?.[0] ??
    details.account_id?.iban ??
    `eb_${stableJsonHash(raw)}`;
  return {
    externalId,
    name: details.name,
    iban: details.account_id?.iban,
    currency: details.currency,
    product: details.product,
    raw,
  };
}

export function normalizeBalance(accountExternalId: string, balance: EbBalance): NormalizedBalance {
  return {
    accountExternalId,
    type: balance.balance_type,
    amount: balance.balance_amount.amount,
    currency: balance.balance_amount.currency,
    referenceDate: balance.reference_date,
    raw: asJson(balance),
  };
}

function signedAmount(transaction: EbTransaction): string {
  const amount = transaction.transaction_amount.amount;
  if (transaction.credit_debit_indicator === "DBIT" && !amount.startsWith("-")) {
    return `-${amount}`;
  }
  return amount;
}

function counterpartyName(transaction: EbTransaction): string | undefined {
  const { creditor, debtor, credit_debit_indicator } = transaction;
  const primary = credit_debit_indicator === "DBIT" ? creditor?.name : debtor?.name;
  return primary ?? creditor?.name ?? debtor?.name;
}

export function normalizeTransaction(
  accountExternalId: string,
  transaction: EbTransaction,
): NormalizedTransaction {
  const raw = asJson(transaction);
  const externalId = transaction.entry_reference ?? `eb_${stableJsonHash(raw)}`;
  const remittance = transaction.remittance_information;
  return {
    accountExternalId,
    externalId,
    bookedOn: transaction.booking_date,
    valueDate: transaction.value_date,
    amount: signedAmount(transaction),
    currency: transaction.transaction_amount.currency,
    counterpartyName: counterpartyName(transaction),
    remittanceInfo: remittance && remittance.length > 0 ? remittance.join(" ").trim() : undefined,
    raw,
  };
}
