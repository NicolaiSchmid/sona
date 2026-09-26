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
 *   returns the existing transaction when the content matches and fails
 *   loudly when it does not — never a silent merge,
 * - transactions are created as `draft` or `suggested`; every further review
 *   state is reached through a recorded transition with an actor,
 * - corrections are append-only: a superseding transaction is a new balanced
 *   transaction; the original keeps its postings and only its review state
 *   flips to `superseded`, recorded by a review event.
 */
import {
  type AccountKind,
  DEFAULT_ACCOUNTS,
  isAccountKind,
  isReviewState,
  type LedgerAccount,
  type LedgerPosting,
  type LedgerTransaction,
  type MoneyAmount,
  type ReviewState,
  stableJsonHash,
  validateAccountPath,
  validateBalancedTransaction,
} from "@sona/core";
import type { DbClient, DbValue } from "../runner.js";
import {
  optionalString,
  placeholders,
  type Row,
  requiredBoolean,
  requiredLiteral,
  requiredString,
  row,
  rows,
  withTransaction,
} from "./helpers.js";
import { RECORD_TYPES } from "./records.js";
import { insertReviewEvent, reviewEventId } from "./review-events.js";

// --- Public types -----------------------------------------------------------

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
  accountIdFor: (path: string) => string;
}

export interface LedgerPostingInput {
  /** Account path the posting books against; must exist in the workspace. */
  account: string;
  amount: MoneyAmount;
  memo?: string;
}

/** Review states a transaction may be created in; anything further needs a recorded transition. */
export const LEDGER_CREATION_REVIEW_STATES = [
  "draft",
  "suggested",
] as const satisfies readonly ReviewState[];

export type LedgerCreationReviewState = (typeof LEDGER_CREATION_REVIEW_STATES)[number];

export interface CreateLedgerTransactionInput {
  id: string;
  /** ISO date (YYYY-MM-DD). */
  bookedOn: string;
  description: string;
  postings: readonly LedgerPostingInput[];
  /** Defaults to "draft". */
  reviewState?: LedgerCreationReviewState;
  createdAt: string;
  /**
   * Workspace-scoped natural key of the logical import (e.g. a bank transaction
   * reference). Creating again with the same key and content returns the
   * existing transaction (even after it was superseded); the same key with
   * different content is rejected. "Same content" is byte-exact: importers
   * must emit stable posting order, amount strings, and memos.
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
  /** Maximum number of transactions to return, oldest first. */
  limit?: number;
}

export interface LedgerReviewTransitionInput {
  id: string;
  /** `superseded` is only reachable through {@link SqliteLedgerRepository.supersedeTransaction}. */
  toState: Exclude<ReviewState, "superseded">;
  /** Who decided: a user id, "rule:<id>", or "system". */
  actor: string;
  at: string;
  notes?: string;
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

export const LEDGER_ERROR_CODES = [
  "invalid_input",
  "unbalanced",
  "unknown_account",
  "commodity_mismatch",
  "not_found",
  "already_superseded",
  "idempotency_conflict",
  "invalid_review_state",
] as const;

export type LedgerErrorCode = (typeof LEDGER_ERROR_CODES)[number];

/** Domain error with a stable `code` so callers can branch without parsing messages. */
export class LedgerError extends Error {
  readonly code: LedgerErrorCode;

  constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
  }
}

/** Thrown when a transaction's postings do not net to zero per commodity. */
export class UnbalancedLedgerTransactionError extends LedgerError {
  readonly transactionId: string;
  readonly errors: readonly string[];

  constructor(transactionId: string, errors: readonly string[]) {
    super("unbalanced", `ledger transaction ${transactionId} is unbalanced: ${errors.join("; ")}`);
    this.name = "UnbalancedLedgerTransactionError";
    this.transactionId = transactionId;
    this.errors = errors;
  }
}

// --- SQL fragments ----------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Posting ids are zero-padded to three digits so `ORDER BY id` preserves input order. */
const MAX_POSTINGS_PER_TRANSACTION = 999;

/** Keeps `IN (...)` lists well below SQLite's default bind-parameter limit. */
const MAX_IN_LIST_PARAMETERS = 500;

const TRANSACTION_SELECT =
  "SELECT t.id, t.workspace_id, t.booked_on, t.description, t.review_state, t.created_at, k.idempotency_key, s.supersedes_transaction_id, sb.transaction_id AS superseded_by_transaction_id FROM ledger_transactions t LEFT JOIN ledger_transaction_idempotency_keys k ON k.workspace_id = t.workspace_id AND k.transaction_id = t.id LEFT JOIN ledger_transaction_supersessions s ON s.workspace_id = t.workspace_id AND s.transaction_id = t.id LEFT JOIN ledger_transaction_supersessions sb ON sb.workspace_id = t.workspace_id AND sb.supersedes_transaction_id = t.id";

const POSTING_ACCOUNT_JOIN =
  "ledger_postings p JOIN ledger_accounts a ON a.workspace_id = p.workspace_id AND a.id = p.account_id";

const POSTING_SELECT = `SELECT p.id, p.transaction_id, a.path AS account, p.amount, p.commodity, p.memo FROM ${POSTING_ACCOUNT_JOIN}`;

const ACCOUNT_SELECT =
  "SELECT id, workspace_id, path, kind, commodity, receipt_required FROM ledger_accounts";

const ACCOUNT_INSERT =
  "INSERT INTO ledger_accounts (id, workspace_id, path, kind, commodity, receipt_required, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)";

// --- Repository -------------------------------------------------------------

export class SqliteLedgerRepository {
  readonly #db: DbClient;

  constructor(db: DbClient) {
    this.#db = db;
  }

  // Accounts -----------------------------------------------------------------

  /**
   * Creates the account if the path is new, otherwise returns the existing
   * account untouched. Use this to install defaults without clobbering
   * user configuration.
   */
  async ensureAccount(workspaceId: string, input: LedgerAccountInput): Promise<LedgerAccount> {
    return withTransaction(this.#db, () => this.#ensureAccount(workspaceId, input));
  }

  /**
   * Creates the account or explicitly overwrites kind/commodity/receiptRequired
   * of the existing path. Changes that would contradict existing postings
   * (kind change, tighter commodity) are rejected.
   */
  async upsertAccount(workspaceId: string, input: LedgerAccountInput): Promise<LedgerAccount> {
    return withTransaction(this.#db, () => {
      const { kind, commodity, receiptRequired } = normalizeAccountInput(input);
      const existing = this.#accountByPath(workspaceId, input.path);
      if (existing !== undefined) {
        this.#assertAccountChangeIsSafe(workspaceId, existing, kind, commodity);
      }
      this.#db
        .prepare(
          `${ACCOUNT_INSERT} ON CONFLICT (workspace_id, path) DO UPDATE SET kind = excluded.kind, commodity = excluded.commodity, receipt_required = excluded.receipt_required`,
        )
        .run(
          input.id,
          workspaceId,
          input.path,
          kind,
          commodity ?? null,
          receiptRequired ? 1 : 0,
          input.createdAt,
        );
      return this.#requireAccount(workspaceId, input.path);
    });
  }

  /** Idempotently installs the `@sona/core` default private-tax account tree, keeping existing accounts as they are. */
  async ensureDefaultAccounts(
    workspaceId: string,
    input: EnsureDefaultAccountsInput,
  ): Promise<LedgerAccount[]> {
    return withTransaction(this.#db, () =>
      DEFAULT_ACCOUNTS.map((account) =>
        this.#ensureAccount(workspaceId, {
          id: input.accountIdFor(account.path),
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

  // Transactions -------------------------------------------------------------

  /**
   * Writes a balanced transaction and its postings atomically. Rejects
   * unbalanced postings, unknown accounts, commodity mismatches, malformed
   * dates, and non-creation review states before writing anything.
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
    let limitClause = "";
    if (filter.limit !== undefined) {
      if (!Number.isInteger(filter.limit) || filter.limit < 1) {
        throw new LedgerError(
          "invalid_input",
          `ledger transaction limit must be a positive integer, got ${String(filter.limit)}`,
        );
      }
      limitClause = " LIMIT ?";
      params.push(filter.limit);
    }

    const transactions = rows(
      this.#db
        .prepare(
          `${TRANSACTION_SELECT} WHERE ${clauses.join(" AND ")} ORDER BY t.booked_on, t.created_at, t.id${limitClause}`,
        )
        .all(...params),
    ).map(transactionFromRow);
    return this.#attachPostings(workspaceId, transactions);
  }

  /**
   * Moves a transaction to another review state and records who did it. The
   * same state again is an idempotent no-op. `superseded` and `exported` are
   * terminal: a correction to either is a new transaction via supersession,
   * never a quiet regression to `draft`. Who may approve what (user vs. rule
   * vs. agent) is policy for the service layer; this only guarantees the
   * transition is attributed and recorded.
   */
  async transitionReviewState(
    workspaceId: string,
    input: LedgerReviewTransitionInput,
  ): Promise<PersistedLedgerTransaction> {
    return withTransaction(this.#db, () => {
      if (input.actor.trim() === "") {
        throw new LedgerError("invalid_input", "review transition actor is required");
      }
      // The type already excludes this; the runtime check guards callers arriving via JSON/MCP.
      const toState: string = input.toState;
      if (toState === "superseded") {
        throw new LedgerError(
          "invalid_review_state",
          "ledger transactions reach superseded only through supersession",
        );
      }
      const current = this.#requireExistingTransaction(workspaceId, input.id);
      if (current.reviewState === toState) {
        return current;
      }
      if (current.reviewState === "superseded") {
        throw new LedgerError(
          "already_superseded",
          `ledger transaction ${current.id} is already superseded`,
        );
      }
      if (current.reviewState === "exported") {
        throw new LedgerError(
          "invalid_review_state",
          `ledger transaction ${current.id} is exported; correct it by supersession instead of changing its state`,
        );
      }
      this.#setReviewState(workspaceId, current, input.toState, {
        actor: input.actor,
        at: input.at,
        notes: input.notes,
      });
      return this.#requireTransaction(workspaceId, current.id);
    });
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
      const original = this.#requireExistingTransaction(workspaceId, input.supersedesTransactionId);
      if (input.replacement.id === original.id) {
        throw new LedgerError("invalid_input", "a ledger transaction cannot supersede itself");
      }

      if (original.supersededByTransactionId !== undefined) {
        const existing = this.#requireTransaction(workspaceId, original.supersededByTransactionId);
        if (isSameReplacement(existing, input.replacement)) {
          return { superseded: original, replacement: existing, created: false };
        }
        throw new LedgerError(
          "already_superseded",
          `ledger transaction ${original.id} is already superseded by ${existing.id}`,
        );
      }
      if (original.reviewState === "superseded") {
        throw new LedgerError(
          "already_superseded",
          `ledger transaction ${original.id} is already superseded`,
        );
      }

      const { transaction: replacement, created } = this.#createTransaction(
        workspaceId,
        input.replacement,
      );
      if (!created) {
        throw new LedgerError(
          "idempotency_conflict",
          `idempotency key ${JSON.stringify(input.replacement.idempotencyKey)} already belongs to ledger transaction ${replacement.id}`,
        );
      }

      this.#db
        .prepare(
          "INSERT INTO ledger_transaction_supersessions (workspace_id, transaction_id, supersedes_transaction_id, superseded_at) VALUES (?, ?, ?, ?)",
        )
        .run(workspaceId, replacement.id, original.id, input.supersededAt);
      this.#setReviewState(workspaceId, original, "superseded", {
        actor: input.actor,
        at: input.supersededAt,
        notes: input.notes,
      });

      return {
        superseded: this.#requireTransaction(workspaceId, original.id),
        replacement: this.#requireTransaction(workspaceId, replacement.id),
        created: true,
      };
    });
  }

  // Internals (synchronous so they compose inside one transaction) -----------

  #ensureAccount(workspaceId: string, input: LedgerAccountInput): LedgerAccount {
    const { kind, commodity, receiptRequired } = normalizeAccountInput(input);
    this.#db
      .prepare(`${ACCOUNT_INSERT} ON CONFLICT (workspace_id, path) DO NOTHING`)
      .run(
        input.id,
        workspaceId,
        input.path,
        kind,
        commodity ?? null,
        receiptRequired ? 1 : 0,
        input.createdAt,
      );
    return this.#requireAccount(workspaceId, input.path);
  }

  #assertAccountChangeIsSafe(
    workspaceId: string,
    existing: LedgerAccount,
    kind: AccountKind,
    commodity: string | undefined,
  ): void {
    if (existing.kind !== kind && this.#hasPostings(workspaceId, existing.id)) {
      throw new LedgerError(
        "invalid_input",
        `cannot change the kind of ledger account "${existing.path}" while it has postings`,
      );
    }
    if (
      commodity !== undefined &&
      commodity !== existing.commodity &&
      this.#hasPostings(workspaceId, existing.id, { otherThanCommodity: commodity })
    ) {
      throw new LedgerError(
        "commodity_mismatch",
        `cannot restrict ledger account "${existing.path}" to ${commodity}: it has postings in another commodity`,
      );
    }
  }

  #hasPostings(
    workspaceId: string,
    accountId: string,
    options: { otherThanCommodity?: string } = {},
  ): boolean {
    const params: DbValue[] = [workspaceId, accountId];
    let commodityClause = "";
    if (options.otherThanCommodity !== undefined) {
      commodityClause = " AND commodity <> ?";
      params.push(options.otherThanCommodity);
    }
    return (
      this.#db
        .prepare(
          `SELECT 1 FROM ledger_postings WHERE workspace_id = ? AND account_id = ?${commodityClause} LIMIT 1`,
        )
        .get(...params) !== undefined
    );
  }

  #accountByPath(workspaceId: string, path: string): LedgerAccount | undefined {
    const result = row(
      this.#db
        .prepare(`${ACCOUNT_SELECT} WHERE workspace_id = ? AND path = ?`)
        .get(workspaceId, path),
    );
    return result === undefined ? undefined : accountFromRow(result);
  }

  #requireAccount(workspaceId: string, path: string): LedgerAccount {
    const account = this.#accountByPath(workspaceId, path);
    if (account === undefined) {
      throw new Error(`ledger account "${path}" was not persisted`);
    }
    return account;
  }

  #createTransaction(
    workspaceId: string,
    input: CreateLedgerTransactionInput,
  ): CreateLedgerTransactionResult {
    if (input.idempotencyKey !== undefined) {
      if (input.idempotencyKey.trim() === "") {
        throw new LedgerError(
          "invalid_input",
          "ledger transaction idempotencyKey must not be blank; omit it instead",
        );
      }
      const existingId = this.#transactionIdForKey(workspaceId, input.idempotencyKey);
      if (existingId !== undefined) {
        const existing = this.#requireTransaction(workspaceId, existingId);
        if (transactionFingerprint(existing) !== transactionFingerprint(input)) {
          throw new LedgerError(
            "idempotency_conflict",
            `idempotency key ${JSON.stringify(input.idempotencyKey)} already belongs to ledger transaction ${existing.id} whose content differs from the new input`,
          );
        }
        return { transaction: existing, created: false };
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
        input.reviewState ?? "draft",
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

  /** Resolves posting account paths to accounts and checks commodity restrictions. */
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
      throw new LedgerError(
        "unknown_account",
        `unknown ledger accounts in workspace: ${missing.join(", ")}`,
      );
    }
    for (const posting of postings) {
      const restriction = resolved.get(posting.account)?.commodity;
      if (restriction !== undefined && restriction !== posting.amount.commodity) {
        throw new LedgerError(
          "commodity_mismatch",
          `ledger account "${posting.account}" only accepts ${restriction}, got ${posting.amount.commodity}`,
        );
      }
    }
    return resolved;
  }

  /** The only mutation a ledger transaction row ever receives, always paired with a review event. */
  #setReviewState(
    workspaceId: string,
    current: PersistedLedgerTransaction,
    toState: ReviewState,
    decision: { actor: string; at: string; notes: string | undefined },
  ): void {
    this.#db
      .prepare("UPDATE ledger_transactions SET review_state = ? WHERE workspace_id = ? AND id = ?")
      .run(toState, workspaceId, current.id);
    const target = { type: RECORD_TYPES.ledgerTransaction, id: current.id };
    insertReviewEvent(this.#db, {
      id: reviewEventId(target, decision.at, toState),
      workspaceId,
      targetType: target.type,
      targetId: target.id,
      fromState: current.reviewState,
      toState,
      actor: decision.actor,
      notes: decision.notes,
      createdAt: decision.at,
    });
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

  /** Caller-facing lookup: the transaction must exist in this workspace. */
  #requireExistingTransaction(workspaceId: string, id: string): PersistedLedgerTransaction {
    const transaction = this.#getTransaction(workspaceId, id);
    if (transaction === undefined) {
      throw new LedgerError("not_found", `ledger transaction ${id} not found in workspace`);
    }
    return transaction;
  }

  /** Post-write read-back: a miss here is an internal persistence failure. */
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
    const ids = [...byId.keys()];
    for (let offset = 0; offset < ids.length; offset += MAX_IN_LIST_PARAMETERS) {
      const chunk = ids.slice(offset, offset + MAX_IN_LIST_PARAMETERS);
      const postings = rows(
        this.#db
          .prepare(
            `${POSTING_SELECT} WHERE p.workspace_id = ? AND p.transaction_id IN ${placeholders(chunk.length)} ORDER BY p.id`,
          )
          .all(workspaceId, ...chunk),
      ).map(postingFromRow);
      for (const posting of postings) {
        byId.get(posting.transactionId)?.postings.push(posting);
      }
    }
    return transactions;
  }
}

// --- Validation and mapping -------------------------------------------------

function normalizeAccountInput(input: LedgerAccountInput): {
  kind: AccountKind;
  commodity: string | undefined;
  receiptRequired: boolean;
} {
  const validation = validateAccountPath(input.path);
  if (!validation.valid) {
    throw new LedgerError(
      "invalid_input",
      `invalid ledger account path: ${validation.errors.join("; ")}`,
    );
  }
  const kind = input.kind ?? validation.kind;
  if (kind === undefined) {
    throw new LedgerError(
      "invalid_input",
      `ledger account path "${input.path}" has no inferable kind; pass one explicitly`,
    );
  }
  if (validation.kind !== undefined && kind !== validation.kind) {
    throw new LedgerError(
      "invalid_input",
      `ledger account kind "${kind}" conflicts with the root of "${input.path}" (${validation.kind})`,
    );
  }
  return { kind, commodity: input.commodity, receiptRequired: input.receiptRequired === true };
}

function validateTransactionInput(input: CreateLedgerTransactionInput): void {
  if (!isCalendarDate(input.bookedOn)) {
    throw new LedgerError(
      "invalid_input",
      `ledger transaction bookedOn must be a real YYYY-MM-DD calendar date, got ${JSON.stringify(input.bookedOn)}`,
    );
  }
  // The type already narrows this; the runtime check guards callers arriving via JSON/MCP.
  const reviewState: string = input.reviewState ?? "draft";
  if (!(LEDGER_CREATION_REVIEW_STATES as readonly string[]).includes(reviewState)) {
    throw new LedgerError(
      "invalid_review_state",
      `review state "${reviewState}" cannot be assigned on creation; create as draft or suggested and record a transition`,
    );
  }
  if (input.postings.length > MAX_POSTINGS_PER_TRANSACTION) {
    throw new LedgerError(
      "invalid_input",
      `ledger transaction ${input.id} has ${input.postings.length} postings; the maximum is ${MAX_POSTINGS_PER_TRANSACTION}`,
    );
  }
  const balance = validateBalancedTransaction(input.postings);
  if (!balance.balanced) {
    throw new UnbalancedLedgerTransactionError(input.id, balance.errors);
  }
}

/** True for `YYYY-MM-DD` strings that name a real calendar day (no 2026-02-31). */
function isCalendarDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) {
    return false;
  }
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/** Deterministic, order-preserving posting id (zero-padded so `ORDER BY id` keeps input order). */
function postingId(transactionId: string, index: number): string {
  return `${transactionId}:${String(index + 1).padStart(3, "0")}`;
}

interface TransactionContent {
  bookedOn: string;
  description: string;
  postings: readonly LedgerPostingInput[];
}

/** Stable hash of the financially relevant content, used to detect idempotency-key collisions. */
function transactionFingerprint(transaction: TransactionContent): string {
  return stableJsonHash({
    bookedOn: transaction.bookedOn,
    description: transaction.description,
    postings: transaction.postings.map((posting) => ({
      account: posting.account,
      amount: posting.amount.amount,
      commodity: posting.amount.commodity,
      memo: posting.memo ?? null,
    })),
  });
}

function isSameReplacement(
  existing: PersistedLedgerTransaction,
  replacement: CreateLedgerTransactionInput,
): boolean {
  const sameIdentity =
    existing.id === replacement.id ||
    (replacement.idempotencyKey !== undefined &&
      existing.idempotencyKey === replacement.idempotencyKey);
  return sameIdentity && transactionFingerprint(existing) === transactionFingerprint(replacement);
}

function accountFromRow(source: Row): LedgerAccount {
  return {
    id: requiredString(source, "id"),
    workspaceId: requiredString(source, "workspace_id"),
    path: requiredString(source, "path"),
    kind: requiredLiteral(source, "kind", isAccountKind),
    commodity: optionalString(source, "commodity"),
    receiptRequired: requiredBoolean(source, "receipt_required"),
  };
}

function transactionFromRow(source: Row): PersistedLedgerTransaction {
  return {
    id: requiredString(source, "id"),
    workspaceId: requiredString(source, "workspace_id"),
    bookedOn: requiredString(source, "booked_on"),
    description: requiredString(source, "description"),
    postings: [],
    reviewState: requiredLiteral(source, "review_state", isReviewState),
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
