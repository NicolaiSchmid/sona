/**
 * Synthetic Enable Banking payloads for tests. These contain no real account,
 * IBAN, or credential data — only obviously-fake sandbox values.
 */
import type {
  EbAccountDetails,
  EbBalancesResponse,
  EbSession,
  EbTransactionsResponse,
} from "./types.js";

export const SESSION_FIXTURE: EbSession = {
  session_id: "sess_demo_1",
  status: "AUTHORIZED",
  aspsp: { name: "Mock ASPSP", country: "DE" },
  accounts: [{ uid: "acc_demo_1" }, "acc_demo_2"],
};

export const ACCOUNT_DETAILS_FIXTURE: EbAccountDetails = {
  uid: "acc_demo_1",
  name: "Demo Giro",
  product: "Current Account",
  currency: "EUR",
  account_id: { iban: "DE00000000000000000000" },
  cash_account_type: "CACC",
};

export const BALANCES_FIXTURE: EbBalancesResponse = {
  balances: [
    {
      name: "Closing booked",
      balance_amount: { amount: "1234.56", currency: "EUR" },
      balance_type: "CLBD",
      reference_date: "2026-01-31",
    },
  ],
};

export const TRANSACTIONS_FIXTURE: EbTransactionsResponse = {
  transactions: [
    {
      entry_reference: "txn_demo_out",
      transaction_amount: { amount: "84.23", currency: "EUR" },
      credit_debit_indicator: "DBIT",
      booking_date: "2026-01-15",
      value_date: "2026-01-15",
      creditor: { name: "Example Handwerk GmbH" },
      remittance_information: ["Rechnung 2026-0042"],
    },
    {
      entry_reference: "txn_demo_in",
      transaction_amount: { amount: "2500.00", currency: "EUR" },
      credit_debit_indicator: "CRDT",
      booking_date: "2026-01-28",
      value_date: "2026-01-28",
      debtor: { name: "Tenant Mietzahlung" },
      remittance_information: ["Miete Februar"],
    },
  ],
};
