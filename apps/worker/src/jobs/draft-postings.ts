/**
 * Turns synced bank transactions into balanced draft ledger transactions.
 *
 * Each bank transaction becomes one `draft` ledger transaction with two legs:
 * the bank asset account and `Suspense:Unclassified` (the counter-account is
 * unknown until a rule or a human classifies it). The ledger transaction id and
 * idempotency key are derived from the bank transaction, so re-running a sync
 * creates nothing new.
 *
 * If the bank later corrects an already-imported transaction, the worker only
 * acts on its own work: a `draft`/`suggested` head of the supersession chain is
 * superseded by a fresh balanced transaction (evidence carried over); a head a
 * human has reviewed is left untouched and the correction is queued for review.
 * Evidence links point every draft back at the normalized bank transaction and
 * the raw provider record.
 */
import {
  isZeroDecimal,
  type JsonValue,
  negateDecimal,
  type ReviewState,
  SUSPENSE_ACCOUNTS,
  stableJsonHash,
  type WorkspaceContext,
} from "@sona/core";
import {
  type CreateLedgerTransactionInput,
  type NormalizedTransaction,
  type PersistedLedgerTransaction,
  RECORD_TYPES,
  type SqliteEvidenceLinkRepository,
  type SqliteLedgerRepository,
  type SqliteReviewQueueRepository,
} from "@sona/db";

/** The bank transaction fields the draft needs, plus the records it links back to. */
export interface DraftPostingSource
  extends Pick<
    NormalizedTransaction,
    | "bookedOn"
    | "valueDate"
    | "amount"
    | "currency"
    | "status"
    | "counterpartyName"
    | "remittanceInfo"
  > {
  /** `bank_transactions.id`, see `bankTransactionId` in `@sona/db`. */
  bankTransactionId: string;
  rawRecordId: string;
}

export interface DraftPostingDependencies {
  ledger: SqliteLedgerRepository;
  evidenceLinks: SqliteEvidenceLinkRepository;
  reviewQueue: SqliteReviewQueueRepository;
  ids: () => string;
}

export interface DraftPostingInput {
  context: WorkspaceContext;
  /** Ledger account path for the bank leg, e.g. `Assets:Bank:src_1:idhash_1`. */
  bankAccountPath: string;
  transaction: DraftPostingSource;
  now: string;
}

export const DRAFT_POSTING_STATES = [
  "created",
  "unchanged",
  "superseded",
  "needs_review",
  "skipped",
] as const;

export type DraftPostingState = (typeof DRAFT_POSTING_STATES)[number];

export type DraftPostingResult =
  | {
      state: Exclude<DraftPostingState, "skipped">;
      /** The ledger transaction now representing the bank transaction. */
      transaction: PersistedLedgerTransaction;
      /** Why the correction was held for review, when it was. */
      reason: string | undefined;
    }
  | {
      state: "skipped";
      transaction: undefined;
      /** Why no draft was generated. */
      reason: string;
    };

export const BANK_CORRECTION_ACTOR = "system:bank_sync" as const;

const MAX_DESCRIPTION_LENGTH = 200;

/** Provider booking statuses for which drafts are generated; pending entries wait. */
const BOOKED_STATUSES: ReadonlySet<string> = new Set(["BOOK"]);

/** Review states the worker still owns; anything further belongs to a human. */
const WORKER_OWNED_STATES: ReadonlySet<ReviewState> = new Set(["draft", "suggested"]);

const ACCOUNT_SEGMENT_INVALID = /[^A-Za-z0-9 _-]/g;

/** Makes an arbitrary label safe as one ledger account path segment. */
export function accountSegment(label: string): string {
  const cleaned = label.replace(ACCOUNT_SEGMENT_INVALID, "_").trim();
  const segment = cleaned === "" ? "Unknown" : cleaned;
  return /^[A-Za-z0-9]/.test(segment) ? segment : `A${segment}`;
}

/**
 * Ledger account for a bank account: `Assets:Bank:<sourceId>:<accountExternalId>`.
 * Built from stable ids, not display names, so renaming a source never reads
 * as a correction of every imported transaction.
 */
export function bankAccountPath(sourceId: string, accountExternalId: string): string {
  return `Assets:Bank:${accountSegment(sourceId)}:${accountSegment(accountExternalId)}`;
}

export function draftTransactionId(bankTransactionId: string): string {
  return `ledger_tx:${bankTransactionId}`;
}

export function draftIdempotencyKey(bankTransactionId: string): string {
  return `draft_posting:${bankTransactionId}`;
}

function describe(transaction: DraftPostingSource): string {
  const parts = [transaction.counterpartyName, transaction.remittanceInfo].filter(
    (part): part is string => part !== undefined && part.trim() !== "",
  );
  const text = parts.length === 0 ? "Bank transaction" : parts.join(" — ");
  return text.length > MAX_DESCRIPTION_LENGTH
    ? `${text.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…`
    : text;
}

type DesiredDraft = CreateLedgerTransactionInput & { idempotencyKey: string };

function desiredDraft(input: DraftPostingInput, bookedOn: string): DesiredDraft {
  const { transaction } = input;
  return {
    id: draftTransactionId(transaction.bankTransactionId),
    bookedOn,
    description: describe(transaction),
    postings: [
      {
        account: input.bankAccountPath,
        amount: { amount: transaction.amount, commodity: transaction.currency },
      },
      {
        account: SUSPENSE_ACCOUNTS.unclassified,
        amount: { amount: negateDecimal(transaction.amount), commodity: transaction.currency },
        memo: "awaiting classification",
      },
    ],
    reviewState: "draft",
    createdAt: input.now,
    idempotencyKey: draftIdempotencyKey(transaction.bankTransactionId),
  };
}

function sameContent(
  existing: PersistedLedgerTransaction,
  desired: CreateLedgerTransactionInput,
): boolean {
  if (existing.bookedOn !== desired.bookedOn || existing.description !== desired.description) {
    return false;
  }
  if (existing.postings.length !== desired.postings.length) {
    return false;
  }
  return existing.postings.every((posting, index) => {
    const want = desired.postings[index];
    return (
      want !== undefined &&
      posting.account === want.account &&
      posting.amount.amount === want.amount.amount &&
      posting.amount.commodity === want.amount.commodity &&
      (posting.memo ?? undefined) === (want.memo ?? undefined)
    );
  });
}

/**
 * Creates or reconciles the draft ledger transaction for one bank transaction.
 * Call inside the job's database transaction so a failure rolls back every
 * draft of the run together.
 */
export async function ensureDraftPosting(
  deps: DraftPostingDependencies,
  input: DraftPostingInput,
): Promise<DraftPostingResult> {
  const { context, transaction } = input;
  const workspaceId = context.workspaceId;

  if (transaction.status !== undefined && !BOOKED_STATUSES.has(transaction.status)) {
    return { state: "skipped", transaction: undefined, reason: `status ${transaction.status}` };
  }
  const bookedOn = transaction.bookedOn ?? transaction.valueDate;
  if (bookedOn === undefined) {
    return { state: "skipped", transaction: undefined, reason: "no booking or value date" };
  }
  if (isZeroDecimal(transaction.amount)) {
    return { state: "skipped", transaction: undefined, reason: "zero amount" };
  }

  await deps.ledger.ensureAccount(workspaceId, {
    id: deps.ids(),
    path: input.bankAccountPath,
    kind: "asset",
    createdAt: input.now,
  });

  const desired = desiredDraft(input, bookedOn);
  const original = await deps.ledger.getTransaction(workspaceId, desired.id);
  let outcome: DraftPostingResult;
  if (original === undefined) {
    const created = await deps.ledger.createTransaction(workspaceId, desired);
    outcome = {
      state: created.created ? "created" : "unchanged",
      transaction: created.transaction,
      reason: undefined,
    };
  } else {
    outcome = await reconcileCorrection(deps, input, original, desired);
  }

  if (outcome.transaction !== undefined) {
    for (const from of [
      { type: RECORD_TYPES.bankTransaction, id: transaction.bankTransactionId },
      { type: RECORD_TYPES.rawSourceRecord, id: transaction.rawRecordId },
    ]) {
      await deps.evidenceLinks.link({
        id: deps.ids(),
        workspaceId,
        fromType: from.type,
        fromId: from.id,
        toType: RECORD_TYPES.ledgerTransaction,
        toId: outcome.transaction.id,
        kind: "imported_as",
        createdAt: input.now,
      });
    }
  }
  return outcome;
}

/** The bank re-reported an imported transaction: compare against the chain head, never the original. */
async function reconcileCorrection(
  deps: DraftPostingDependencies,
  input: DraftPostingInput,
  original: PersistedLedgerTransaction,
  desired: DesiredDraft,
): Promise<DraftPostingResult> {
  const workspaceId = input.context.workspaceId;
  const chain = await supersessionChain(deps.ledger, original);
  const head = chain[chain.length - 1] ?? original;
  if (sameContent(head, desired)) {
    return { state: "unchanged", transaction: head, reason: undefined };
  }

  if (!WORKER_OWNED_STATES.has(head.reviewState)) {
    // A human has taken this transaction past draft: the worker must not
    // replace their work. Surface the discrepancy instead.
    const reviewItemId = bankCorrectionReviewItemId(head.id, desired);
    const reason: JsonValue = {
      kind: "bank_correction",
      bankTransactionId: input.transaction.bankTransactionId,
      ledgerTransactionId: head.id,
      reviewState: head.reviewState,
      current: transactionSummary(head),
      reported: {
        bookedOn: desired.bookedOn,
        description: desired.description,
        amount: input.transaction.amount,
        currency: input.transaction.currency,
      },
    };
    await deps.reviewQueue.enqueue({
      id: reviewItemId,
      workspaceId,
      targetType: RECORD_TYPES.ledgerTransaction,
      targetId: head.id,
      state: "suggested",
      reason,
      createdAt: input.now,
      updatedAt: input.now,
    });
    return {
      state: "needs_review",
      transaction: head,
      reason: `ledger transaction ${head.id} is ${head.reviewState}; correction queued for review`,
    };
  }

  // Replacement ids are sequenced along the chain, so a value that flips back
  // and forth still gets a fresh transaction each time.
  const revision = chain.length;
  const { replacement, created } = await deps.ledger.supersedeTransaction(workspaceId, {
    supersedesTransactionId: head.id,
    replacement: {
      ...desired,
      id: `${desired.id}:r${revision}`,
      idempotencyKey: `${desired.idempotencyKey}:r${revision}`,
    },
    actor: BANK_CORRECTION_ACTOR,
    supersededAt: input.now,
    notes: "bank transaction changed after import",
  });
  await carryOverEvidence(deps, workspaceId, head.id, replacement.id, input.now);
  return {
    state: created ? "superseded" : "unchanged",
    transaction: replacement,
    reason: undefined,
  };
}

/** Receipts that substantiated the superseded draft substantiate its replacement too. */
async function carryOverEvidence(
  deps: DraftPostingDependencies,
  workspaceId: string,
  fromTransactionId: string,
  toTransactionId: string,
  now: string,
): Promise<void> {
  const links = await deps.evidenceLinks.listForTransaction(workspaceId, fromTransactionId);
  for (const link of links) {
    if (link.kind !== "substantiates" || link.toId !== fromTransactionId) {
      continue;
    }
    await deps.evidenceLinks.link({
      id: deps.ids(),
      workspaceId,
      fromType: link.fromType,
      fromId: link.fromId,
      toType: RECORD_TYPES.ledgerTransaction,
      toId: toTransactionId,
      kind: "substantiates",
      notes: `carried over from superseded ${fromTransactionId}`,
      createdAt: now,
    });
  }
}

export function bankCorrectionReviewItemId(
  ledgerTransactionId: string,
  desired: CreateLedgerTransactionInput,
): string {
  const fingerprint = stableJsonHash(transactionSummary(desired)).slice(0, 16);
  return `review:bank_correction:${ledgerTransactionId}:${fingerprint}`;
}

/** The content a bank correction is judged on: date, description, and the posting legs. */
function transactionSummary(
  transaction: Pick<CreateLedgerTransactionInput, "bookedOn" | "description" | "postings">,
): JsonValue {
  return {
    bookedOn: transaction.bookedOn,
    description: transaction.description,
    postings: transaction.postings.map((posting) => ({
      account: posting.account,
      amount: posting.amount.amount,
      commodity: posting.amount.commodity,
    })),
  };
}

/** The supersession chain from `original` to its current head, oldest first. */
export async function supersessionChain(
  ledger: SqliteLedgerRepository,
  original: PersistedLedgerTransaction,
): Promise<PersistedLedgerTransaction[]> {
  const chain = [original];
  let current = original;
  while (current.supersededByTransactionId !== undefined) {
    const next = await ledger.getTransaction(
      current.workspaceId,
      current.supersededByTransactionId,
    );
    if (next === undefined) {
      throw new Error(
        `superseding ledger transaction ${current.supersededByTransactionId} not found`,
      );
    }
    chain.push(next);
    current = next;
  }
  return chain;
}

/** The current head of a transaction's supersession chain (itself when never superseded). */
export async function ledgerHead(
  ledger: SqliteLedgerRepository,
  workspaceId: string,
  transactionId: string,
): Promise<PersistedLedgerTransaction | undefined> {
  const original = await ledger.getTransaction(workspaceId, transactionId);
  if (original === undefined) {
    return undefined;
  }
  const chain = await supersessionChain(ledger, original);
  return chain[chain.length - 1];
}
