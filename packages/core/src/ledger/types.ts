import type { MoneyAmount } from "../money/types";
import type { ReviewState } from "../review/types";

export type AccountKind = "asset" | "liability" | "equity" | "income" | "expense" | "suspense";

export interface LedgerAccount {
  id: string;
  workspaceId: string;
  /** Colon-separated path, e.g. "Assets:Bank:DKB:Giro". */
  path: string;
  kind: AccountKind;
  /** Optional commodity restriction; if unset the account accepts any commodity. */
  commodity?: string;
  /** Whether postings to this account require substantiating evidence. */
  receiptRequired: boolean;
}

/** A single leg of a double-entry transaction. */
export interface LedgerPosting {
  id: string;
  transactionId: string;
  /** Account path the posting books against. */
  account: string;
  amount: MoneyAmount;
  memo?: string;
}

/**
 * A balanced double-entry transaction. The sum of postings must be zero per
 * commodity (see {@link ./balance}).
 */
export interface LedgerTransaction {
  id: string;
  workspaceId: string;
  /** ISO date (YYYY-MM-DD) the transaction is booked on. */
  bookedOn: string;
  description: string;
  postings: LedgerPosting[];
  reviewState: ReviewState;
  createdAt: string;
}
