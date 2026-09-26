/**
 * `reconciliation`: scores a document's latest extraction against bank
 * transactions in a date window, persists the plausible candidates, and
 * applies the conservative auto-apply policy:
 *
 * - `auto_match` → a policy decision and a `substantiates` evidence link to the
 *   current head of the transaction's ledger supersession chain (falling back
 *   to the bank transaction when no draft exists yet); the ledger review state
 *   is untouched,
 * - `review` → a review item; nothing is linked until a human decides,
 * - `candidate` / `no_match` → not persisted (weak or blocked pairs).
 *
 * A document whose extraction is still awaiting review, a truncated candidate
 * search, and a transaction another document already substantiates all force
 * review. Candidates a human has decided on are never re-scored or overwritten.
 */
import type { JsonValue, WorkspaceContext } from "@sona/core";
import { SUSPENSE_ACCOUNTS } from "@sona/core";
import type { DbClient } from "@sona/db";
import {
  bankAccountId,
  type PersistedBankTransaction,
  type PersistedLedgerTransaction,
  RECORD_TYPES,
  type RecordRef,
  type SqliteAuditEventRepository,
  type SqliteBankRecordRepository,
  type SqliteDocumentExtractionRepository,
  type SqliteDocumentRepository,
  type SqliteEvidenceLinkRepository,
  type SqliteLedgerRepository,
  type SqliteMatchCandidateRepository,
  type SqliteReviewQueueRepository,
  type StoredDocumentExtraction,
  withTransactionAsync,
} from "@sona/db";
import {
  type AutoApplyPolicy,
  DEFAULT_AUTO_APPLY_POLICY,
  extractionToMatchableDocument,
  type MatchableTransaction,
  type MatchCandidate,
  type MatchOutcome,
  type MatchSetItem,
  reconcileMatchSet,
  scoreMatch,
} from "@sona/receipts";
import { ledgerHead } from "./draft-postings.js";
import { extractionReviewItemId } from "./extraction.js";
import { type JobHandler, NonRetryableJobError } from "./runner.js";

export interface ReconciliationDependencies {
  db: DbClient;
  documents: SqliteDocumentRepository;
  extractions: SqliteDocumentExtractionRepository;
  bankRecords: SqliteBankRecordRepository;
  matchCandidates: SqliteMatchCandidateRepository;
  reviewQueue: SqliteReviewQueueRepository;
  evidenceLinks: SqliteEvidenceLinkRepository;
  ledger: SqliteLedgerRepository;
  auditEvents: SqliteAuditEventRepository;
  policy?: AutoApplyPolicy;
  /** Days on either side of the document date to search for transactions. Default 60. */
  windowDays?: number;
  ids: () => string;
}

export const DEFAULT_RECONCILIATION_WINDOW_DAYS = 60;

/** Upper bound on transactions scored per document. */
const MAX_CANDIDATE_TRANSACTIONS = 1000;

/** How far back an undated document looks for its payment. */
const UNDATED_LOOKBACK_DAYS = 365;

export const SCORER_VERSION = "receipts-scoring@1" as const;

export const AUTO_APPLY_ACTOR = "policy:auto_apply@1" as const;

export interface ReconcileDocumentInput {
  context: WorkspaceContext;
  documentId: string;
  now: string;
}

export const RECONCILIATION_SKIP_REASONS = ["no_extraction", "no_total_amount"] as const;

export type ReconciliationSkipReason = (typeof RECONCILIATION_SKIP_REASONS)[number];

/** Outcomes that are persisted as candidates; weak and blocked pairs are not. */
export type PersistedMatchOutcome = Extract<MatchOutcome, "auto_match" | "review">;

export interface ReconcileDocumentResult {
  extractionId: string | undefined;
  skipped: ReconciliationSkipReason | undefined;
  /** Transactions in the search window that were scored. */
  scored: number;
  /** Persisted candidates by outcome. */
  candidates: Record<PersistedMatchOutcome, string[]>;
  reviewItemIds: string[];
  /** Match decision ids recorded by the auto-apply policy. */
  autoAppliedDecisionIds: string[];
}

export function candidateId(documentId: string, bankTransactionId: string): string {
  return `match:${documentId}:${bankTransactionId}`;
}

export function matchReviewItemId(candidate: string): string {
  return `review:${candidate}`;
}

export function autoApplyDecisionId(candidate: string): string {
  return `decision:${candidate}:auto`;
}

function emptyResult(): ReconcileDocumentResult {
  return {
    extractionId: undefined,
    skipped: undefined,
    scored: 0,
    candidates: { auto_match: [], review: [] },
    reviewItemIds: [],
    autoAppliedDecisionIds: [],
  };
}

function shiftIsoDate(date: string, days: number): string {
  const time = Date.parse(`${date}T00:00:00Z`);
  return new Date(time + days * 86_400_000).toISOString().slice(0, 10);
}

interface MatchEntry {
  item: MatchSetItem;
  transaction: PersistedBankTransaction;
  /** What a `substantiates` link points at: the head ledger transaction, else the bank transaction. */
  target: RecordRef;
}

function toMatchable(transaction: PersistedBankTransaction): MatchableTransaction {
  return {
    id: transaction.id,
    amount: transaction.amount,
    currency: transaction.currency,
    bookedOn: transaction.bookedOn,
    valueDate: transaction.valueDate,
    counterpartyName: transaction.counterpartyName,
    remittanceInfo: transaction.remittanceInfo,
    account: undefined,
    sourceReliability: undefined,
  };
}

/** The current head of the ledger transaction a bank transaction was imported as, if any. */
async function ledgerHeadForBankTransaction(
  deps: Pick<ReconciliationDependencies, "evidenceLinks" | "ledger">,
  workspaceId: string,
  bankTransactionId: string,
): Promise<PersistedLedgerTransaction | undefined> {
  const links = await deps.evidenceLinks.listForRecord(workspaceId, {
    type: RECORD_TYPES.bankTransaction,
    id: bankTransactionId,
  });
  const imported = links.find(
    (link) =>
      link.kind === "imported_as" &&
      link.fromId === bankTransactionId &&
      link.toType === RECORD_TYPES.ledgerTransaction,
  );
  return imported === undefined ? undefined : ledgerHead(deps.ledger, workspaceId, imported.toId);
}

/** The first non-asset leg of a transaction: the account a receipt would substantiate. */
function counterAccount(transaction: PersistedLedgerTransaction | undefined): string | undefined {
  return transaction?.postings.find((posting) => !posting.account.startsWith("Assets:"))?.account;
}

async function latestExtraction(
  extractions: SqliteDocumentExtractionRepository,
  workspaceId: string,
  documentId: string,
): Promise<StoredDocumentExtraction | undefined> {
  const all = await extractions.listForDocument(workspaceId, documentId);
  return all[all.length - 1];
}

export async function reconcileDocument(
  deps: ReconciliationDependencies,
  input: ReconcileDocumentInput,
): Promise<ReconcileDocumentResult> {
  const { context, documentId } = input;
  const { workspaceId } = context;
  const policy = deps.policy ?? DEFAULT_AUTO_APPLY_POLICY;
  const windowDays = deps.windowDays ?? DEFAULT_RECONCILIATION_WINDOW_DAYS;

  const document = await deps.documents.getById(workspaceId, documentId);
  if (document === undefined) {
    throw new NonRetryableJobError(`document ${documentId} not found in workspace`);
  }
  const extraction = await latestExtraction(deps.extractions, workspaceId, documentId);
  if (extraction === undefined) {
    return { ...emptyResult(), skipped: "no_extraction" };
  }
  if (extraction.totalAmount === undefined) {
    return { ...emptyResult(), extractionId: extraction.id, skipped: "no_total_amount" };
  }

  const matchable = extractionToMatchableDocument(extraction);
  // Without a document date, search the recent past instead of the oldest
  // rows in the workspace: receipts almost always arrive after their payment.
  const today = input.now.slice(0, 10);
  const window =
    extraction.documentDate === undefined
      ? { from: shiftIsoDate(today, -UNDATED_LOOKBACK_DAYS), to: today }
      : {
          from: shiftIsoDate(extraction.documentDate, -windowDays),
          to: shiftIsoDate(extraction.documentDate, windowDays),
        };
  const transactions = await deps.bankRecords.listTransactions(workspaceId, {
    ...window,
    limit: MAX_CANDIDATE_TRANSACTIONS,
  });

  // Signals that hold every pair of this document for a human, whatever it scores.
  const documentWarnings: string[] = [];
  const pendingReview = await deps.reviewQueue.getById(
    workspaceId,
    extractionReviewItemId(extraction.id),
  );
  if (pendingReview?.state === "suggested") {
    documentWarnings.push("extraction pending review");
  }
  if (transactions.length >= MAX_CANDIDATE_TRANSACTIONS) {
    documentWarnings.push("candidate search truncated");
  }

  // Stage 1: every transaction in the window is scored, but only pairs that
  // clear the policy's candidate threshold enter the decision set. Without this
  // filter `decideMatch` would hold every warned pair (e.g. any inflow) for
  // review regardless of score and crowd out the real match as "contested".
  const entries: MatchEntry[] = [];
  for (const transaction of transactions) {
    const matchableTransaction = toMatchable(transaction);
    const score = scoreMatch(matchableTransaction, matchable);
    if (score.blockers.length > 0 || score.score < policy.candidateThreshold) {
      continue;
    }
    score.warnings.push(...documentWarnings);
    // The account the pair is judged against is the head ledger transaction's
    // counter-account (a human may have classified it), so review-required
    // account patterns apply; unclassified drafts fall back to suspense.
    const head = await ledgerHeadForBankTransaction(deps, workspaceId, transaction.id);
    const account = counterAccount(head) ?? SUSPENSE_ACCOUNTS.unclassified;
    entries.push({
      item: {
        transactionId: transaction.id,
        documentId,
        score,
        transaction: { ...matchableTransaction, account },
        account,
        policy,
      },
      transaction,
      target:
        head === undefined
          ? { type: RECORD_TYPES.bankTransaction, id: transaction.id }
          : { type: RECORD_TYPES.ledgerTransaction, id: head.id },
    });
  }
  const resolved = reconcileMatchSet(entries.map((entry) => entry.item));

  return withTransactionAsync(deps.db, async () => {
    const result: ReconcileDocumentResult = {
      ...emptyResult(),
      extractionId: extraction.id,
      scored: transactions.length,
    };
    for (const [index, scored] of resolved.entries()) {
      if (scored.outcome !== "auto_match" && scored.outcome !== "review") {
        continue;
      }
      const entry = entries[index];
      if (entry === undefined) {
        throw new Error("reconciled match set lost its transaction");
      }
      const { item, transaction, target } = entry;
      const id = candidateId(documentId, scored.transactionId);
      const decisionId = autoApplyDecisionId(id);
      const decided = await deps.matchCandidates.listDecisions(workspaceId, id);
      if (decided.some((decision) => decision.actor !== AUTO_APPLY_ACTOR)) {
        // A human already ruled on this pair; never re-open or overwrite it.
        continue;
      }
      if (decided.some((decision) => decision.id === decisionId)) {
        // Already auto-applied on an earlier run; the decision and link stand.
        continue;
      }
      // The in-memory one-to-one guard only sees this document's candidates. A
      // transaction that another document already substantiates is contested,
      // and contested matches are for humans.
      const contestedBy =
        scored.outcome === "auto_match"
          ? await substantiatedByOtherDocument(deps.evidenceLinks, workspaceId, target, documentId)
          : undefined;
      const outcome: PersistedMatchOutcome = contestedBy === undefined ? scored.outcome : "review";
      const reasons =
        contestedBy === undefined
          ? scored.reasons
          : [
              ...scored.reasons,
              `transaction already substantiated by document ${contestedBy}; needs review`,
            ];
      const candidate: MatchCandidate = {
        id,
        workspaceId,
        transactionId: transaction.externalId,
        transactionAccountId: bankAccountId(transaction.sourceId, transaction.accountExternalId),
        documentId,
        extractionId: extraction.id,
        scorerVersion: SCORER_VERSION,
        score: item.score.score,
        reasons,
        blockers: item.score.blockers,
        warnings: item.score.warnings,
        outcome,
        createdAt: input.now,
      };
      await deps.matchCandidates.save(candidate);
      result.candidates[outcome].push(id);

      if (outcome === "review") {
        const reviewItemId = matchReviewItemId(id);
        const reason: JsonValue = {
          kind: "receipt_match",
          candidateId: id,
          documentId,
          bankTransactionId: transaction.id,
          score: item.score.score,
          reasons,
        };
        await deps.reviewQueue.enqueue({
          id: reviewItemId,
          workspaceId,
          targetType: RECORD_TYPES.matchCandidate,
          targetId: id,
          state: "suggested",
          reason,
          createdAt: input.now,
          updatedAt: input.now,
        });
        result.reviewItemIds.push(reviewItemId);
        continue;
      }

      await deps.matchCandidates.recordDecision({
        id: decisionId,
        workspaceId,
        candidateId: id,
        decision: "approved",
        actor: AUTO_APPLY_ACTOR,
        notes: reasons.join("; "),
        createdAt: input.now,
      });
      await deps.auditEvents.append({
        id: `audit:${decisionId}`,
        workspaceId,
        action: "reconciliation.match.auto_applied",
        actor: AUTO_APPLY_ACTOR,
        targetType: RECORD_TYPES.matchCandidate,
        targetId: id,
        metadata: {
          documentId,
          bankTransactionId: transaction.id,
          score: item.score.score,
          reasons,
        },
        createdAt: input.now,
      });
      result.autoAppliedDecisionIds.push(decisionId);

      await deps.evidenceLinks.link({
        id: deps.ids(),
        workspaceId,
        fromType: RECORD_TYPES.document,
        fromId: documentId,
        toType: target.type,
        toId: target.id,
        kind: "substantiates",
        notes: `auto-applied by ${AUTO_APPLY_ACTOR}`,
        createdAt: input.now,
      });
    }
    return result;
  });
}

/** Id of another document that already substantiates `target`, if any. */
async function substantiatedByOtherDocument(
  evidenceLinks: SqliteEvidenceLinkRepository,
  workspaceId: string,
  target: RecordRef,
  documentId: string,
): Promise<string | undefined> {
  const links = await evidenceLinks.listForRecord(workspaceId, target);
  return links.find(
    (link) =>
      link.kind === "substantiates" &&
      link.fromType === RECORD_TYPES.document &&
      link.toType === target.type &&
      link.toId === target.id &&
      link.fromId !== documentId,
  )?.fromId;
}

export function createReconciliationHandler(
  deps: ReconciliationDependencies,
): JobHandler<"reconciliation"> {
  return async ({ job, context, now, produced }) => {
    const result = await reconcileDocument(deps, {
      context,
      documentId: job.payload.documentId,
      now,
    });
    for (const id of [...result.candidates.auto_match, ...result.candidates.review]) {
      produced({ type: RECORD_TYPES.matchCandidate, id });
    }
    for (const id of result.reviewItemIds) {
      produced({ type: RECORD_TYPES.reviewItem, id });
    }
    for (const id of result.autoAppliedDecisionIds) {
      produced({ type: RECORD_TYPES.matchDecision, id });
    }
    return {
      extractionId: result.extractionId ?? null,
      skipped: result.skipped ?? null,
      scored: result.scored,
      autoMatched: result.candidates.auto_match.length,
      queuedForReview: result.reviewItemIds.length,
    };
  };
}
