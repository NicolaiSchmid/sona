import {
  DEFAULT_AUTO_APPLY_POLICY,
  FakeExtractionProvider,
  hashDocumentContent,
} from "@sona/receipts";
import { describe, expect, it } from "vitest";
import {
  countRows,
  createTestHarness,
  SESSION_1,
  SRC_1,
  SYNTHETIC_TRANSACTIONS,
  stageUpload,
  syntheticAccount,
  type TestHarness,
  type TestHarnessOptions,
  WS_1,
} from "../test-support.js";
import { documentIdForHash } from "./document-ingest.js";
import { AUTO_APPLY_ACTOR, candidateId, matchReviewItemId } from "./reconciliation.js";

const RECEIPT_BYTES = new TextEncoder().encode("%PDF-1.4 synthetic handwerk invoice");
const HANDWERK_TX = "bank_transaction:src_1:idhash_synth_1:txn_synth_handwerk";

/** A receipt that matches the synthetic Handwerk transaction exactly. */
const MATCHING_RECEIPT = {
  vendorName: "Example Handwerk GmbH",
  documentDate: "2026-01-15",
  totalAmount: "84.23",
  currency: "EUR",
  invoiceNumber: "2026-0042",
} as const;

async function syncedHarness(options: TestHarnessOptions = {}): Promise<TestHarness> {
  const h = await createTestHarness(options);
  await h.worker.queue.enqueue(h.context, "source_sync", { sourceId: SRC_1 });
  await h.worker.runOnce({ kinds: ["source_sync"] });
  return h;
}

/** Ingests and extracts one receipt, leaving its reconciliation job queued. */
async function extractedReceipt(h: TestHarness): Promise<string> {
  await stageUpload(h, h.context, { id: "upload_1", bytes: RECEIPT_BYTES });
  await h.worker.queue.enqueue(h.context, "document_ingest", { uploadId: "upload_1" });
  await h.worker.runOnce({ kinds: ["document_ingest"] });
  await h.worker.runOnce({ kinds: ["extraction"] });
  return documentIdForHash(WS_1, hashDocumentContent(RECEIPT_BYTES));
}

describe("reconciliation job", () => {
  it("auto-applies an exact, timely, low-value match under the default policy", async () => {
    const h = await syncedHarness();
    try {
      h.provider.current = new FakeExtractionProvider(MATCHING_RECEIPT);
      const documentId = await extractedReceipt(h);
      const [outcome] = await h.worker.runOnce({ kinds: ["reconciliation"] });
      expect(outcome?.state).toBe("succeeded");

      const id = candidateId(documentId, HANDWERK_TX);
      const candidate = await h.worker.repositories.matchCandidates.getById(WS_1, id);
      expect(candidate).toMatchObject({
        outcome: "auto_match",
        transactionId: "txn_synth_handwerk",
        transactionAccountId: "bank_account:src_1:idhash_synth_1",
        documentId,
      });
      expect(candidate?.score).toBeGreaterThanOrEqual(DEFAULT_AUTO_APPLY_POLICY.minScore);
      // The other (inflow) transaction is not a plausible counterpart.
      expect(
        await h.worker.repositories.matchCandidates.listForDocument(WS_1, documentId),
      ).toHaveLength(1);

      const decisions = await h.worker.repositories.matchCandidates.listDecisions(WS_1, id);
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({ decision: "approved", actor: AUTO_APPLY_ACTOR });

      // Evidence: the document substantiates the draft ledger transaction, whose state is untouched.
      const links = await h.worker.repositories.evidenceLinks.listForDocument(WS_1, documentId);
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({ kind: "substantiates", toType: "ledger_transaction" });
      const draft = await h.worker.repositories.ledger.getTransaction(WS_1, links[0]?.toId ?? "");
      expect(draft?.reviewState).toBe("draft");
      expect(draft?.description).toMatch(/Example Handwerk/);

      expect(await h.worker.repositories.reviewQueue.listByState(WS_1, "suggested")).toEqual([]);
      const audit = await h.worker.repositories.auditEvents.list(WS_1);
      expect(audit.events.map((e) => e.action)).toContain("reconciliation.match.auto_applied");
      expect(outcome?.produced).toEqual(
        expect.arrayContaining([
          { type: "match_candidate", id },
          { type: "match_decision", id: `decision:${id}:auto` },
        ]),
      );
    } finally {
      h.close();
    }
  });

  it("never bypasses the review gate: high-value, warned, or policy-disabled matches are queued", async () => {
    const cases: Array<{
      name: string;
      options: TestHarnessOptions;
      receipt: ConstructorParameters<typeof FakeExtractionProvider>[0];
      transactionId: string;
      reason: RegExp;
    }> = [
      {
        name: "amount above policy threshold",
        options: {
          bankSessions: {
            [SESSION_1]: {
              status: "AUTHORIZED",
              accounts: [
                syntheticAccount({
                  transactions: [
                    {
                      ...SYNTHETIC_TRANSACTIONS.handwerk,
                      entry_reference: "txn_big",
                      transaction_amount: { amount: "1500.00", currency: "EUR" },
                    },
                  ],
                }),
              ],
            },
          },
        },
        receipt: { ...MATCHING_RECEIPT, totalAmount: "1500.00" },
        transactionId: "bank_transaction:src_1:idhash_synth_1:txn_big",
        reason: /exceeds 1000/,
      },
      {
        name: "low extraction confidence",
        options: {},
        receipt: { ...MATCHING_RECEIPT, confidence: 0.5 },
        transactionId: HANDWERK_TX,
        reason: /low extraction confidence/,
      },
      {
        name: "auto-apply disabled",
        options: {
          worker: { reconciliation: { policy: { ...DEFAULT_AUTO_APPLY_POLICY, enabled: false } } },
        },
        receipt: MATCHING_RECEIPT,
        transactionId: HANDWERK_TX,
        reason: /needs review/,
      },
    ];
    for (const testCase of cases) {
      const h = await syncedHarness(testCase.options);
      try {
        h.provider.current = new FakeExtractionProvider(testCase.receipt);
        const documentId = await extractedReceipt(h);
        const [outcome] = await h.worker.runOnce({ kinds: ["reconciliation"] });
        expect(outcome?.state, testCase.name).toBe("succeeded");

        const id = candidateId(documentId, testCase.transactionId);
        const candidate = await h.worker.repositories.matchCandidates.getById(WS_1, id);
        expect(candidate?.outcome, testCase.name).toBe("review");
        expect(
          await h.worker.repositories.matchCandidates.listDecisions(WS_1, id),
          testCase.name,
        ).toEqual([]);
        expect(
          await h.worker.repositories.evidenceLinks.listForDocument(WS_1, documentId),
          testCase.name,
        ).toEqual([]);

        const items = await h.worker.repositories.reviewQueue.listByState(WS_1, "suggested");
        const matchItems = items.filter((item) => item.targetType === "match_candidate");
        expect(matchItems, testCase.name).toHaveLength(1);
        expect(matchItems[0]?.id).toBe(matchReviewItemId(id));
        const reason = matchItems[0]?.reason as { reasons: string[] };
        expect(reason.reasons.join(" "), testCase.name).toMatch(testCase.reason);
        expect(outcome?.produced, testCase.name).toContainEqual({
          type: "review_item",
          id: matchReviewItemId(id),
        });
      } finally {
        h.close();
      }
    }
  });

  it("holds a strong match for review when two receipts compete for one transaction", async () => {
    const h = await syncedHarness();
    try {
      h.provider.current = new FakeExtractionProvider(MATCHING_RECEIPT);
      const first = await extractedReceipt(h);
      const secondBytes = new TextEncoder().encode("%PDF-1.4 second copy of the same invoice");
      await stageUpload(h, h.context, { id: "upload_2", bytes: secondBytes });
      await h.worker.queue.enqueue(h.context, "document_ingest", { uploadId: "upload_2" });
      await h.worker.runOnce({ kinds: ["document_ingest"] });
      await h.worker.runOnce({ kinds: ["extraction"] });
      const second = documentIdForHash(WS_1, hashDocumentContent(secondBytes));

      // The first receipt reconciles alone and auto-applies; the second sees the competition.
      await h.worker.runOnce({ kinds: ["reconciliation"] });
      const firstCandidate = await h.worker.repositories.matchCandidates.getById(
        WS_1,
        candidateId(first, HANDWERK_TX),
      );
      const secondCandidate = await h.worker.repositories.matchCandidates.getById(
        WS_1,
        candidateId(second, HANDWERK_TX),
      );
      // The second receipt scores as well as the first, but the transaction is
      // already substantiated: the persisted evidence forces human review.
      expect(firstCandidate?.outcome).toBe("auto_match");
      expect(secondCandidate?.outcome).toBe("review");
      expect(secondCandidate?.reasons).toContainEqual(
        expect.stringMatching(/already substantiated/),
      );
      expect(await h.worker.repositories.evidenceLinks.listForDocument(WS_1, second)).toEqual([]);
      expect(
        await h.worker.repositories.matchCandidates.listDecisions(
          WS_1,
          candidateId(second, HANDWERK_TX),
        ),
      ).toEqual([]);
      const items = await h.worker.repositories.reviewQueue.listByState(WS_1, "suggested");
      expect(items.map((item) => item.id)).toEqual([
        matchReviewItemId(candidateId(second, HANDWERK_TX)),
      ]);
    } finally {
      h.close();
    }
  });

  it("re-running reconciliation is idempotent and preserves human decisions", async () => {
    const h = await syncedHarness();
    try {
      h.provider.current = new FakeExtractionProvider({ ...MATCHING_RECEIPT, confidence: 0.5 });
      const documentId = await extractedReceipt(h);
      await h.worker.runOnce({ kinds: ["reconciliation"] });
      const id = candidateId(documentId, HANDWERK_TX);
      const reviewId = matchReviewItemId(id);

      // A human rejects the suggested match.
      await h.worker.repositories.reviewQueue.transition(WS_1, {
        id: reviewId,
        toState: "user_reviewed",
        actor: "user_1",
        at: h.clock.now(),
        notes: "wrong invoice",
      });
      await h.worker.repositories.matchCandidates.recordDecision({
        id: "decision:human",
        workspaceId: WS_1,
        candidateId: id,
        decision: "rejected",
        actor: "user_1",
        notes: undefined,
        createdAt: h.clock.now(),
      });
      const before = {
        candidates: countRows(h.db, "match_candidates", WS_1),
        reviewItems: countRows(h.db, "review_items", WS_1),
        decisions: countRows(h.db, "match_decisions", WS_1),
        links: countRows(h.db, "evidence_links", WS_1),
      };

      h.clock.advance(60_000);
      await h.worker.queue.enqueue(
        h.context,
        "reconciliation",
        { documentId },
        { idempotencyKey: "reconciliation:rerun" },
      );
      const [outcome] = await h.worker.runOnce({ kinds: ["reconciliation"] });
      expect(outcome?.state).toBe("succeeded");
      expect({
        candidates: countRows(h.db, "match_candidates", WS_1),
        reviewItems: countRows(h.db, "review_items", WS_1),
        decisions: countRows(h.db, "match_decisions", WS_1),
        links: countRows(h.db, "evidence_links", WS_1),
      }).toEqual(before);
      expect((await h.worker.repositories.reviewQueue.getById(WS_1, reviewId))?.state).toBe(
        "user_reviewed",
      );
      expect(outcome?.produced).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("treats a currency mismatch as a blocker: the pair is scored but never becomes a candidate", async () => {
    const h = await syncedHarness();
    try {
      h.provider.current = new FakeExtractionProvider({ ...MATCHING_RECEIPT, currency: "USD" });
      const documentId = await extractedReceipt(h);
      const [outcome] = await h.worker.runOnce({ kinds: ["reconciliation"] });
      expect(outcome).toMatchObject({ state: "succeeded", produced: [] });
      const run = (await h.worker.queue.listRuns(h.context, outcome?.jobId ?? ""))[0];
      expect(run?.result).toMatchObject({ scored: 2, autoMatched: 0, queuedForReview: 0 });
      expect(await h.worker.repositories.matchCandidates.listForDocument(WS_1, documentId)).toEqual(
        [],
      );
      expect(await h.worker.repositories.evidenceLinks.listForDocument(WS_1, documentId)).toEqual(
        [],
      );
      expect(await h.worker.repositories.reviewQueue.listByState(WS_1, "suggested")).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("searches only the configured window around the document date, or the whole workspace without one", async () => {
    const h = await syncedHarness({ worker: { reconciliation: { windowDays: 3 } } });
    try {
      // Dated five days after the Handwerk booking: outside a 3-day window.
      h.provider.current = new FakeExtractionProvider({
        ...MATCHING_RECEIPT,
        documentDate: "2026-01-20",
      });
      const dated = await extractedReceipt(h);
      const [datedOutcome] = await h.worker.runOnce({ kinds: ["reconciliation"] });
      expect(
        (await h.worker.queue.listRuns(h.context, datedOutcome?.jobId ?? ""))[0]?.result,
      ).toMatchObject({ scored: 0, autoMatched: 0 });
      expect(await h.worker.repositories.matchCandidates.listForDocument(WS_1, dated)).toEqual([]);

      // No document date at all: every transaction in the workspace is a candidate.
      const undatedBytes = new TextEncoder().encode("%PDF-1.4 receipt without a date");
      h.provider.current = {
        name: "undated",
        version: "1",
        extract: async (input) => ({
          ...(await new FakeExtractionProvider(MATCHING_RECEIPT).extract(input)),
          documentDate: undefined,
        }),
      };
      await stageUpload(h, h.context, { id: "upload_2", bytes: undatedBytes });
      await h.worker.queue.enqueue(h.context, "document_ingest", { uploadId: "upload_2" });
      await h.worker.runOnce({ kinds: ["document_ingest"] });
      await h.worker.runOnce({ kinds: ["extraction"] });
      const [undatedOutcome] = await h.worker.runOnce({ kinds: ["reconciliation"] });
      expect(
        (await h.worker.queue.listRuns(h.context, undatedOutcome?.jobId ?? ""))[0]?.result,
      ).toMatchObject({ scored: 2 });
    } finally {
      h.close();
    }
  });

  it("holds an exact-amount inflow for review instead of attaching purchase evidence", async () => {
    const h = await syncedHarness();
    try {
      h.provider.current = new FakeExtractionProvider({
        vendorName: "Tenant Mietzahlung",
        documentDate: "2026-01-28",
        totalAmount: "2500.00",
        currency: "EUR",
        invoiceNumber: "Miete Februar",
      });
      const documentId = await extractedReceipt(h);
      const [outcome] = await h.worker.runOnce({ kinds: ["reconciliation"] });
      expect(outcome?.state).toBe("succeeded");

      const id = candidateId(documentId, "bank_transaction:src_1:idhash_synth_1:txn_synth_rent");
      const candidate = await h.worker.repositories.matchCandidates.getById(WS_1, id);
      expect(candidate?.outcome).toBe("review");
      expect(candidate?.warnings).toContain("transaction is an inflow/refund");
      expect(await h.worker.repositories.matchCandidates.listDecisions(WS_1, id)).toEqual([]);
      expect(await h.worker.repositories.evidenceLinks.listForDocument(WS_1, documentId)).toEqual(
        [],
      );
      const item = await h.worker.repositories.reviewQueue.getById(WS_1, matchReviewItemId(id));
      expect(item?.state).toBe("suggested");
      expect((item?.reason as { reasons: string[] }).reasons.join(" ")).toMatch(/inflow\/refund/);
    } finally {
      h.close();
    }
  });

  it("links evidence to the current head after a bank correction, never the superseded draft", async () => {
    const h = await syncedHarness();
    try {
      // The bank corrects the amount; the draft is superseded before any receipt arrives.
      const session = h.bank.sessions.get(SESSION_1) ?? fail("missing session");
      session.accounts = [
        syntheticAccount({
          transactions: [
            {
              ...SYNTHETIC_TRANSACTIONS.handwerk,
              transaction_amount: { amount: "84.50", currency: "EUR" },
            },
            SYNTHETIC_TRANSACTIONS.rent,
          ],
        }),
      ];
      h.clock.advance(60_000);
      await h.worker.queue.enqueue(h.context, "source_sync", { sourceId: SRC_1, window: "w2" });
      await h.worker.runOnce({ kinds: ["source_sync"] });
      const chain = (await h.worker.repositories.ledger.listTransactions(WS_1)).filter((t) =>
        t.description.startsWith("Example Handwerk"),
      );
      const superseded = chain.find((t) => t.reviewState === "superseded") ?? fail("no original");
      const head = chain.find((t) => t.reviewState === "draft") ?? fail("no head");

      h.provider.current = new FakeExtractionProvider({
        ...MATCHING_RECEIPT,
        totalAmount: "84.50",
      });
      const documentId = await extractedReceipt(h);
      await h.worker.runOnce({ kinds: ["reconciliation"] });

      const links = await h.worker.repositories.evidenceLinks.listForDocument(WS_1, documentId);
      expect(links.map((l) => [l.kind, l.toId])).toEqual([["substantiates", head.id]]);
      expect(links.some((l) => l.toId === superseded.id)).toBe(false);
    } finally {
      h.close();
    }
  });

  it("holds every match for review while the extraction itself awaits review", async () => {
    const h = await syncedHarness();
    try {
      // Confident fields, but the provider flagged the result: the extraction
      // review item is open, so nothing about this document may auto-apply.
      h.provider.current = {
        name: "flagged",
        version: "1",
        extract: async (input) => ({
          ...(await new FakeExtractionProvider(MATCHING_RECEIPT).extract(input)),
          status: "needs_review",
        }),
      };
      const documentId = await extractedReceipt(h);
      const [outcome] = await h.worker.runOnce({ kinds: ["reconciliation"] });
      expect(outcome?.state).toBe("succeeded");
      const id = candidateId(documentId, HANDWERK_TX);
      const candidate = await h.worker.repositories.matchCandidates.getById(WS_1, id);
      expect(candidate?.outcome).toBe("review");
      expect(candidate?.reasons).toContainEqual("extraction pending review");
      expect(await h.worker.repositories.matchCandidates.listDecisions(WS_1, id)).toEqual([]);
      expect(await h.worker.repositories.evidenceLinks.listForDocument(WS_1, documentId)).toEqual(
        [],
      );
    } finally {
      h.close();
    }
  });

  it("applies review-required account patterns to a human-classified head", async () => {
    const h = await syncedHarness();
    try {
      const ledger = h.worker.repositories.ledger;
      const draft =
        (await ledger.listTransactions(WS_1)).find((t) =>
          t.description.startsWith("Example Handwerk"),
        ) ?? fail("no draft");
      const bankLeg = draft.postings.find((p) => p.account.startsWith("Assets:")) ?? fail("leg");
      await ledger.supersedeTransaction(WS_1, {
        supersedesTransactionId: draft.id,
        replacement: {
          id: "tx_classified",
          bookedOn: draft.bookedOn,
          description: draft.description,
          postings: [
            { account: bankLeg.account, amount: bankLeg.amount },
            {
              account: "Expenses:RealEstate:Maintenance",
              amount: { amount: "84.23", commodity: "EUR" },
            },
          ],
          reviewState: "suggested",
          createdAt: h.clock.now(),
        },
        actor: "user_1",
        supersededAt: h.clock.now(),
      });

      h.provider.current = new FakeExtractionProvider(MATCHING_RECEIPT);
      const documentId = await extractedReceipt(h);
      await h.worker.runOnce({ kinds: ["reconciliation"] });
      const candidate = await h.worker.repositories.matchCandidates.getById(
        WS_1,
        candidateId(documentId, HANDWERK_TX),
      );
      expect(candidate?.outcome).toBe("review");
      expect(candidate?.reasons).toContainEqual(
        expect.stringMatching(/Expenses:RealEstate:Maintenance requires review/),
      );
    } finally {
      h.close();
    }
  });

  it("leaves an auto-applied candidate settled when a later run sees a competitor", async () => {
    const h = await syncedHarness();
    try {
      h.provider.current = new FakeExtractionProvider(MATCHING_RECEIPT);
      const documentId = await extractedReceipt(h);
      await h.worker.runOnce({ kinds: ["reconciliation"] });
      const id = candidateId(documentId, HANDWERK_TX);
      expect((await h.worker.repositories.matchCandidates.getById(WS_1, id))?.outcome).toBe(
        "auto_match",
      );

      // A second, equally plausible transaction appears; on re-run the settled
      // auto match is not re-scored into `review`, and no duplicate decision lands.
      const session = h.bank.sessions.get(SESSION_1) ?? fail("missing session");
      session.accounts = [
        syntheticAccount({
          transactions: [
            SYNTHETIC_TRANSACTIONS.handwerk,
            { ...SYNTHETIC_TRANSACTIONS.handwerk, entry_reference: "txn_twin" },
          ],
        }),
      ];
      h.clock.advance(60_000);
      await h.worker.queue.enqueue(h.context, "source_sync", { sourceId: SRC_1, window: "w2" });
      await h.worker.runOnce({ kinds: ["source_sync"] });
      await h.worker.queue.enqueue(
        h.context,
        "reconciliation",
        { documentId },
        { idempotencyKey: "reconciliation:rerun" },
      );
      const [outcome] = await h.worker.runOnce({ kinds: ["reconciliation"] });
      expect(outcome?.state).toBe("succeeded");
      expect((await h.worker.repositories.matchCandidates.getById(WS_1, id))?.outcome).toBe(
        "auto_match",
      );
      expect(await h.worker.repositories.matchCandidates.listDecisions(WS_1, id)).toHaveLength(1);
      // The twin is contested by the already-substantiated original: review.
      const twin = await h.worker.repositories.matchCandidates.getById(
        WS_1,
        candidateId(documentId, "bank_transaction:src_1:idhash_synth_1:txn_twin"),
      );
      expect(twin?.outcome).toBe("review");
    } finally {
      h.close();
    }
  });

  it("skips documents without an extraction or total amount", async () => {
    const h = await syncedHarness();
    try {
      await stageUpload(h, h.context, { id: "upload_1", bytes: RECEIPT_BYTES });
      await h.worker.queue.enqueue(h.context, "document_ingest", { uploadId: "upload_1" });
      await h.worker.runOnce({ kinds: ["document_ingest"] });
      const documentId = documentIdForHash(WS_1, hashDocumentContent(RECEIPT_BYTES));
      const { job } = await h.worker.queue.enqueue(h.context, "reconciliation", { documentId });
      await h.worker.runOnce({ kinds: ["reconciliation"] });
      expect((await h.worker.queue.listRuns(h.context, job.id))[0]?.result).toMatchObject({
        skipped: "no_extraction",
        scored: 0,
      });
      expect(countRows(h.db, "match_candidates", WS_1)).toBe(0);
    } finally {
      h.close();
    }
  });
});

function fail(message: string): never {
  throw new Error(message);
}
