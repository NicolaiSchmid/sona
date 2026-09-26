/**
 * SQLite-backed double-entry ledger repository.
 *
 * Invariants enforced here, before anything is written:
 *
 * - every transaction balances per commodity (`validateBalancedTransaction`),
 * - postings only book against accounts that exist in the same workspace and
 *   accept the posting's commodity,
 * - a transaction and its postings land atomically or not at all,
 * - re-creating a transaction under the same workspace-scoped idempotency key
 *   returns the existing transaction instead of duplicating it,
 * - corrections are append-only: a superseding transaction is a new balanced
 *   transaction; the original keeps its postings and only its review state
 *   flips to `superseded`, recorded by a review event.
 */
import {
  type AccountKind,
  DEFAULT_ACCOUNTS,
  type LedgerAccount,
  type LedgerPosting,
  type LedgerTransaction,
  type MoneyAmount,
  type ReviewState,
  validateAccountPath,
  validateBalancedTransaction,
} from "@sona/core";
import type { DbClient, DbValue } from "../runner.js";
import {
  insertReviewEvent,
  optionalString,
  placeholders,
  type Row,
  requiredString,
  row,
  rows,
  withTransaction,
} from "./helpers.js";

export interface LedgerAccountInput {
  /** Application-generated id, used only when the path is first created. */
  id: string;
  /** Colon-separated path, e.g. "Assets:Bank:DKB:Giro". */
  path: string;
  /** Defaults to the kind inferred from the path root; required for unknown roots. */
  kind?: AccountKind;
  /** Optional commodity restriction; postings in another commodity are rejected. */
  commodity?: string;
  /** Defaults to false. */
  receiptRequired?: boolean;
  createdAt: string;
}

export interface EnsureDefaultAccountsInput {
  createdAt: string;
  /** Generates the id for a default account path that does not exist yet. */
  accountId: (path: string) => string;
}

export interface LedgerPostingInput {
  /** Account path the posting books against; must exist in the workspace. */
  account: string;
  amount: MoneyAmount;
  memo?: string;
}

export interface CreateLedgerTransactionInput {
  id: string;
  /** ISO date (YYYY-MM-DD). */
  bookedOn: string;
  description: string;
  postings: readonly LedgerPostingInput[];
  /** Defaults to "draft". `superseded` is only reachable through supersession. */
  reviewState?: Exclude<ReviewState, "superseded">;
  createdAt: string;
  /**
   * Workspace-scoped natural key of the logical import (e.g. a bank transaction
   * reference). Creating again with the same key returns the existing
   * transaction and writes nothing.
   */
  idempotencyKey?: string;
}

export interface PersistedLedgerTransaction extends LedgerTransaction {
  idempotencyKey: string | undefined;
  /** Set on a correcting transaction: the id of the transaction it replaces. */
  supersedesTransactionId: string | undefined;
  /** Set on a superseded transaction: the id of its replacement. */
  supersededByTransactionId: string | undefined;
}

export interface CreateLedgerTransactionResult {
  transaction: PersistedLedgerTransaction;
  /** False when an existing transaction was returned via its idempotency key. */
  created: boolean;
}

export interface LedgerTransactionFilter {
  /** Inclusive lower bound on `bookedOn` (YYYY-MM-DD). */
  from?: string;
  /** Inclusive upper bound on `bookedOn` (YYYY-MM-DD). */
  to?: string;
  /** Only transactions with at least one posting on this exact account path. */
  account?: string;
  /** Only transactions in one of these review states; an empty list matches nothing. */
  reviewStates?: readonly ReviewState[];
}

export interface SupersedeLedgerTransactionInput {
  supersedesTransactionId: string;
  replacement: CreateLedgerTransactionInput;
  /** Who performed the correction: a user id, "rule:<id>", or "system". */
  actor: string;
  supersededAt: string;
  notes?: string;
}

export interface SupersedeLedgerTransactionResult {
  superseded: PersistedLedgerTransaction;
  replacement: PersistedLedgerTransaction;
  /** False when the same supersession had already been recorded (idempotent retry). */
  created: boolean;
}

/** Thrown when a transaction's postings do not net to zero per commodity. */
export class UnbalancedLedgerTransactionError extends Error {
  readonly transactionId: string;
  readonly errors: readonly string[];

  constructor(transactionId: string, errors: readonly string[]) {
    super(`Ledger transaction ${transactionId} is unbalanced: ${errors.join("; ")}`);
    this.name = "UnbalancedLedgerTransactionError";
    this.transactionId = transactionId;
    this.errors = errors;
  }
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const REVIEW_TARGET_TYPE = "ledger_transaction" as const;

const TRANSACTION_SELECT =
  "SELECT t.id, t.workspace_id, t.booked_on, t.description, t.review_state, t.created_at, k.idempotency_key, s.supersedes_transaction_id, sb.transaction_id AS superseded_by_transaction_id FROM ledger_transactions t LEFT JOIN ledger_transaction_idempotency_keys k ON k.workspace_id = t.workspace_id AND k.transaction_id = t.id LEFT JOIN ledger_transaction_supersessions s ON s.workspace_id = t.workspace_id AND s.transaction_id = t.id LEFT JOIN ledger_transaction_supersessions sb ON sb.workspace_id = t.workspace_id AND sb.supersedes_transaction_id = t.id";

const POSTING_ACCOUNT_JOIN =
  "ledger_postings p JOIN ledger_accounts a ON a.workspace_id = p.workspace_id AND a.id = p.account_id";

const POSTING_SELECT = `SELECT p.id, p.transaction_id, a.path AS account, p.amount, p.commodity, p.memo FROM ${POSTING_ACCOUNT_JOIN}`;

const ACCOUNT_SELECT =
  "SELECT id, workspace_id, path, kind, commodity, receipt_required FROM ledger_accounts";

export class SqliteLedgerRepository {
  readonly #db: DbClient;

  constructor(db: DbClient) {
    this.#db = db;
  }

  // --- Accounts -------------------------------------------------------------

  /** Creates the account or updates kind/commodity/receiptRequired of the existing path. */
  async upsertAccount(workspaceId: string, input: LedgerAccountInput): Promise<LedgerAccount> {
    return this.#upsertAccount(workspaceId, input);
  }

  /** Idempotently installs the `@sona/core` default private-tax account tree. */
  async ensureDefaultAccounts(
    workspaceId: string,
    input: EnsureDefaultAccountsInput,
  ): Promise<LedgerAccount[]> {
    return withTransaction(this.#db, () =>
      DEFAULT_ACCOUNTS.map((account) =>
        this.#upsertAccount(workspaceId, {
          id: input.accountId(account.path),
          path: account.path,
          kind: account.kind,
          receiptRequired: account.receiptRequired,
          createdAt: input.createdAt,
        }),
      ),
    );
  }

  async getAccountByPath(workspaceId: string, path: string): Promise<LedgerAccount | undefined> {
    return this.#accountByPath(workspaceId, path);
  }

  async listAccounts(workspaceId: string): Promise<LedgerAccount[]> {
    return rows(
      this.#db.prepare(`${ACCOUNT_SELECT} WHERE workspace_id = ? ORDER BY path`).all(workspaceId),
    ).map(accountFromRow);
  }

  // --- Transactions ---------------------------------------------------------

  /**
   * Writes a balanced transaction and its postings atomically. Rejects
   * unbalanced postings, unknown accounts, commodity mismatches, and malformed
   * dates before touching the database.
   */
  async createTransaction(
    workspaceId: string,
    input: CreateLedgerTransactionInput,
  ): Promise<CreateLedgerTransactionResult> {
    return withTransaction(this.#db, () => this.#createTransaction(workspaceId, input));
  }

  async getTransaction(
    workspaceId: string,
    id: string,
  ): Promise<PersistedLedgerTransaction | undefined> {
    return this.#getTransaction(workspaceId, id);
  }

  async listTransactions(
    workspaceId: string,
    filter: LedgerTransactionFilter = {},
  ): Promise<PersistedLedgerTransaction[]> {
    const clauses = ["t.workspace_id = ?"];
    const params: DbValue[] = [workspaceId];

    if (filter.from !== undefined) {
      clauses.push("t.booked_on >= ?");
      params.push(filter.from);
    }
    if (filter.to !== undefined) {
      clauses.push("t.booked_on <= ?");
      params.push(filter.to);
    }
    if (filter.reviewStates !== undefined) {
      if (filter.reviewStates.length === 0) {
        return [];
      }
      clauses.push(`t.review_state IN ${placeholders(filter.reviewStates.length)}`);
      params.push(...filter.reviewStates);
    }
    if (filter.account !== undefined) {
      clauses.push(
        `EXISTS (SELECT 1 FROM ${POSTING_ACCOUNT_JOIN} WHERE p.workspace_id = t.workspace_id AND p.transaction_id = t.id AND a.path = ?)`,
      );
      params.push(filter.account);
    }

    const transactions = rows(
      this.#db
        .prepare(
          `${TRANSACTION_SELECT} WHERE ${clauses.join(" AND ")} ORDER BY t.booked_on, t.created_at, t.id`,
        )
        .all(...params),
    ).map(transactionFromRow);
    return this.#attachPostings(workspaceId, transactions);
  }

  /**
   * Replaces a transaction with a corrected one. The original's postings are
   * never modified; its review state becomes `superseded`, a review event
   * records who did it, and the replacement points back via
   * `supersedesTransactionId`. Retrying the same supersession is a no-op.
   */
  async supersedeTransaction(
    workspaceId: string,
    input: SupersedeLedgerTransactionInput,
  ): Promise<SupersedeLedgerTransactionResult> {
    return withTransaction(this.#db, () => {
      const original = this.#getTransaction(workspaceId, input.supersedesTransactionId);
      if (original === undefined) {
        throw new Error("ledger transaction not found in workspace");
      }
      if (input.replacement.id === original.id) {
        throw new Error("a ledger transaction cannot supersede itself");
      }

      if (original.supersededByTransactionId !== undefined) {
        const existing = this.#getTransaction(workspaceId, original.supersededByTransactionId);
        if (existing !== undefined && isSameReplacement(existing, input.replacement)) {
          return { superseded: original, replacement: existing, created: false };
        }
        throw new Error(
          `ledger transaction ${original.id} is already superseded by ${original.supersededByTransactionId}`,
        );
      }
      if (original.reviewState === "superseded") {
        throw new Error(`ledger transaction ${original.id} is already superseded`);
      }

      const { transaction: replacement, created } = this.#createTransaction(
        workspaceId,
        input.replacement,
      );
      if (!created) {
        throw new Error(
          `idempotency key ${JSON.stringify(input.replacement.idempotencyKey)} already belongs to ledger transaction ${replacement.id}`,
        );
      }

      this.#db
        .prepare(
          "INSERT INTO ledger_transaction_supersessions (workspace_id, transaction_id, supersedes_transaction_id, superseded_at) VALUES (?, ?, ?, ?)",
        )
        .run(workspaceId, replacement.id, original.id, input.supersededAt);
      // The only mutation a superseded transaction ever receives.
      this.#db
        .prepare(
          "UPDATE ledger_transactions SET review_state = ? WHERE workspace_id = ? AND id = ?",
        )
        .run("superseded" satisfies ReviewState, workspaceId, original.id);
      insertReviewEvent(this.#db, {
        id: `review_event:${original.id}:${input.supersededAt}`,
        workspaceId,
        targetType: REVIEW_TARGET_TYPE,
        targetId: original.id,
        fromState: original.reviewState,
        toState: "superseded",
        actor: input.actor,
        notes: input.notes,
        createdAt: input.supersededAt,
      });

      return {
        superseded: this.#requireTransaction(workspaceId, original.id),
        replacement: this.#requireTransaction(workspaceId, replacement.id),
        created: true,
      };
    });
  }

  // --- Internals (synchronous so they compose inside one transaction) -------

  #upsertAccount(workspaceId: string, input: LedgerAccountInput): LedgerAccount {
    const validation = validateAccountPath(input.path);
    if (!validation.valid) {
      throw new Error(`Invalid ledger account path: ${validation.errors.join("; ")}`);
    }
    const kind = input.kind ?? validation.kind;
    if (kind === undefined) {
      throw new Error(
        `Ledger account path "${input.path}" has no inferable kind; pass one explicitly`,
      );
    }
    if (validation.kind !== undefined && kind !== validation.kind) {
      throw new Error(
        `Ledger account kind "${kind}" conflicts with the root of "${input.path}" (${validation.kind})`,
      );
    }

    this.#db
      .prepare(
        "INSERT INTO ledger_accounts (id, workspace_id, path, kind, commodity, receipt_required, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id, path) DO UPDATE SET kind = excluded.kind, commodity = excluded.commodity, receipt_required = excluded.receipt_required",
      )
      .run(
        input.id,
        workspaceId,
        input.path,
        kind,
        input.commodity ?? null,
        input.receiptRequired === true ? 1 : 0,
        input.createdAt,
      );

    const account = this.#accountByPath(workspaceId, input.path);
    if (account === undefined) {
      throw new Error("ledger account upsert did not persist");
    }
    return account;
  }

  #accountByPath(workspaceId: string, path: string): LedgerAccount | undefined {
    const result = row(
      this.#db
        .prepare(`${ACCOUNT_SELECT} WHERE workspace_id = ? AND path = ?`)
        .get(workspaceId, path),
    );
    return result === undefined ? undefined : accountFromRow(result);
  }

  #createTransaction(
    workspaceId: string,
    input: CreateLedgerTransactionInput,
  ): CreateLedgerTransactionResult {
    if (input.idempotencyKey !== undefined) {
      const existingId = this.#transactionIdForKey(workspaceId, input.idempotencyKey);
      if (existingId !== undefined) {
        return { transaction: this.#requireTransaction(workspaceId, existingId), created: false };
      }
    }

    validateTransactionInput(input);
    const accounts = this.#resolveAccounts(workspaceId, input.postings);

    this.#db
      .prepare(
        "INSERT INTO ledger_transactions (id, workspace_id, booked_on, description, review_state, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.id,
        workspaceId,
        input.bookedOn,
        input.description,
        input.reviewState ?? ("draft" satisfies ReviewState),
        input.createdAt,
      );

    const insertPosting = this.#db.prepare(
      "INSERT INTO ledger_postings (id, workspace_id, transaction_id, account_id, amount, commodity, memo) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const [index, posting] of input.postings.entries()) {
      const account = accounts.get(posting.account);
      if (account === undefined) {
        throw new Error(`ledger account "${posting.account}" was not resolved`);
      }
      insertPosting.run(
        postingId(input.id, index),
        workspaceId,
        input.id,
        account.id,
        posting.amount.amount,
        posting.amount.commodity,
        posting.memo ?? null,
      );
    }

    if (input.idempotencyKey !== undefined) {
      this.#db
        .prepare(
          "INSERT INTO ledger_transaction_idempotency_keys (workspace_id, idempotency_key, transaction_id) VALUES (?, ?, ?)",
        )
        .run(workspaceId, input.idempotencyKey, input.id);
    }

    return { transaction: this.#requireTransaction(workspaceId, input.id), created: true };
  }

  /** Resolves posting account paths to ids and checks commodity restrictions. */
  #resolveAccounts(
    workspaceId: string,
    postings: readonly LedgerPostingInput[],
  ): Map<string, LedgerAccount> {
    const paths = [...new Set(postings.map((posting) => posting.account))];
    const resolved = new Map(
      rows(
        this.#db
          .prepare(
            `${ACCOUNT_SELECT} WHERE workspace_id = ? AND path IN ${placeholders(paths.length)}`,
          )
          .all(workspaceId, ...paths),
      )
        .map(accountFromRow)
        .map((account) => [account.path, account] as const),
    );

    const missing = paths.filter((path) => !resolved.has(path));
    if (missing.length > 0) {
      throw new Error(`Unknown ledger accounts in workspace: ${missing.join(", ")}`);
    }
    for (const posting of postings) {
      const restriction = resolved.get(posting.account)?.commodity;
      if (restriction !== undefined && restriction !== posting.amount.commodity) {
        throw new Error(
          `Ledger account "${posting.account}" only accepts ${restriction}, got ${posting.amount.commodity}`,
        );
      }
    }
    return resolved;
  }

  #transactionIdForKey(workspaceId: string, idempotencyKey: string): string | undefined {
    const result = row(
      this.#db
        .prepare(
          "SELECT transaction_id FROM ledger_transaction_idempotency_keys WHERE workspace_id = ? AND idempotency_key = ?",
        )
        .get(workspaceId, idempotencyKey),
    );
    return result === undefined ? undefined : requiredString(result, "transaction_id");
  }

  #getTransaction(workspaceId: string, id: string): PersistedLedgerTransaction | undefined {
    const result = row(
      this.#db
        .prepare(`${TRANSACTION_SELECT} WHERE t.workspace_id = ? AND t.id = ?`)
        .get(workspaceId, id),
    );
    if (result === undefined) {
      return undefined;
    }
    return this.#attachPostings(workspaceId, [transactionFromRow(result)])[0];
  }

  #requireTransaction(workspaceId: string, id: string): PersistedLedgerTransaction {
    const transaction = this.#getTransaction(workspaceId, id);
    if (transaction === undefined) {
      throw new Error(`ledger transaction ${id} was not persisted`);
    }
    return transaction;
  }

  /** Loads postings for all given transactions in one query and attaches them. */
  #attachPostings(
    workspaceId: string,
    transactions: PersistedLedgerTransaction[],
  ): PersistedLedgerTransaction[] {
    if (transactions.length === 0) {
      return transactions;
    }
    const byId = new Map(transactions.map((transaction) => [transaction.id, transaction]));
    const postings = rows(
      this.#db
        .prepare(
          `${POSTING_SELECT} WHERE p.workspace_id = ? AND p.transaction_id IN ${placeholders(byId.size)} ORDER BY p.id`,
        )
        .all(workspaceId, ...byId.keys()),
    ).map(postingFromRow);
    for (const posting of postings) {
      byId.get(posting.transactionId)?.postings.push(posting);
    }
    return transactions;
  }
}

function validateTransactionInput(input: CreateLedgerTransactionInput): void {
  if (!ISO_DATE_RE.test(input.bookedOn)) {
    throw new Error(
      `Ledger transaction bookedOn must be YYYY-MM-DD, got ${JSON.stringify(input.bookedOn)}`,
    );
  }
  if ((input.reviewState as ReviewState | undefined) === "superseded") {
    throw new Error("A ledger transaction cannot be created in the superseded state");
  }
  const balance = validateBalancedTransaction(input.postings);
  if (!balance.balanced) {
    throw new UnbalancedLedgerTransactionError(input.id, balance.errors);
  }
}

/** Deterministic, order-preserving posting id (zero-padded so `ORDER BY id` keeps input order). */
function postingId(transactionId: string, index: number): string {
  return `${transactionId}:${String(index + 1).padStart(3, "0")}`;
}

function isSameReplacement(
  existing: PersistedLedgerTransaction,
  replacement: CreateLedgerTransactionInput,
): boolean {
  return (
    existing.id === replacement.id ||
    (replacement.idempotencyKey !== undefined &&
      existing.idempotencyKey === replacement.idempotencyKey)
  );
}

function accountFromRow(source: Row): LedgerAccount {
  return {
    id: requiredString(source, "id"),
    workspaceId: requiredString(source, "workspace_id"),
    path: requiredString(source, "path"),
    kind: requiredString(source, "kind") as AccountKind,
    commodity: optionalString(source, "commodity"),
    receiptRequired: source["receipt_required"] === 1,
  };
}

function transactionFromRow(source: Row): PersistedLedgerTransaction {
  return {
    id: requiredString(source, "id"),
    workspaceId: requiredString(source, "workspace_id"),
    bookedOn: requiredString(source, "booked_on"),
    description: requiredString(source, "description"),
    postings: [],
    reviewState: requiredString(source, "review_state") as ReviewState,
    createdAt: requiredString(source, "created_at"),
    idempotencyKey: optionalString(source, "idempotency_key"),
    supersedesTransactionId: optionalString(source, "supersedes_transaction_id"),
    supersededByTransactionId: optionalString(source, "superseded_by_transaction_id"),
  };
}

function postingFromRow(source: Row): LedgerPosting {
  return {
    id: requiredString(source, "id"),
    transactionId: requiredString(source, "transaction_id"),
    account: requiredString(source, "account"),
    amount: {
      amount: requiredString(source, "amount"),
      commodity: requiredString(source, "commodity"),
    },
    memo: optionalString(source, "memo"),
  };
}
