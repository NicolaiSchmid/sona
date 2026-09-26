import { createRawSourceRecord, type JsonValue, type ReviewState } from "@sona/core";
import type {
  DocumentExtraction,
  MatchCandidate,
  MatchDecision,
  StoredDocument,
} from "@sona/receipts";
import { describe, expect, it } from "vitest";
import { createWorkspaceBankRecordStore, SqliteBankRecordRepository } from "./bank-records.js";
import { SqliteDocumentExtractionRepository, SqliteDocumentRepository } from "./documents.js";
import { SqliteMatchCandidateRepository } from "./matches.js";
import { SqlitePortalTaskRunRepository } from "./portal-task-runs.js";
import { SqliteRawRecordRepository } from "./raw-records.js";
import { SqliteReviewQueueRepository } from "./review-queue.js";
import { createWorkspaceSyncRunStore, SqliteSyncRunRepository } from "./sync-runs.js";
import { createTestDatabase } from "./test-support.js";
import type {
  NormalizedAccount,
  NormalizedBalance,
  NormalizedTransaction,
  TaskRunProvenance,
} from "./types.js";

function rawRecord(input: {
  id: string;
  workspaceId?: string;
  sourceId?: string;
  externalId?: string;
  payload?: JsonValue;
}) {
  return createRawSourceRecord({
    id: input.id,
    workspaceId: input.workspaceId ?? "ws_1",
    sourceId: input.sourceId ?? "src_1",
    externalId: input.externalId ?? input.id,
    recordType: "bank_transaction",
    payloadJson: input.payload ?? { id: input.id },
    observedAt: "2026-02-01T00:00:00Z",
    createdAt: "2026-02-01T00:00:00Z",
  });
}

function document(input: Partial<StoredDocument> = {}): StoredDocument {
  return {
    id: input.id ?? "doc_1",
    workspaceId: input.workspaceId ?? "ws_1",
    contentHash: input.contentHash ?? "hash_doc_1",
    mimeType: "application/pdf",
    originalFilename: "synthetic-receipt.pdf",
    storageUri: "object://synthetic/doc_1",
    sourceKind: "upload",
    sourceMetadata: input.sourceMetadata ?? { uploadedBy: "test" },
    retentionState: "active",
    createdAt: "2026-02-01T00:00:00Z",
  };
}

function extraction(documentId = "doc_1"): DocumentExtraction {
  return {
    documentId,
    vendorName: "Synthetic Vendor",
    documentDate: "2026-01-31",
    dueDate: undefined,
    totalAmount: "42.50",
    taxAmount: "6.79",
    currency: "EUR",
    invoiceNumber: "INV-001",
    paymentReference: "REF-001",
    extractedText: "Synthetic receipt text",
    confidence: 0.92,
    extractorVersion: "test-extractor@1",
  };
}

function candidate(input: Partial<MatchCandidate> = {}): MatchCandidate {
  return {
    id: input.id ?? "cand_1",
    workspaceId: input.workspaceId ?? "ws_1",
    transactionId: input.transactionId ?? "txn_1",
    transactionAccountId: input.transactionAccountId ?? "acct_1",
    documentId: input.documentId ?? "doc_1",
    extractionId: input.extractionId,
    scorerVersion: "receipt-scorer@1",
    score: 0.88,
    reasons: ["amount", "date"],
    blockers: [],
    warnings: ["review required"],
    outcome: "review",
    createdAt: "2026-02-01T00:00:00Z",
  };
}

describe("SQLite sync repositories", () => {
  it("persists sync run start, errors, and finish by workspace", async () => {
    const t = createTestDatabase();
    try {
      const repo = new SqliteSyncRunRepository(t.db);
      await repo.start({
        workspaceId: "ws_1",
        runId: "run_1",
        sourceId: "src_1",
        startedAt: "2026-02-01T00:00:00Z",
      });
      await repo.recordError("ws_1", {
        runId: "run_1",
        accountUid: "acct_1",
        message: "temporary provider failure",
        at: "2026-02-01T00:01:00Z",
      });
      await repo.finish("ws_1", {
        runId: "run_1",
        status: "completed_with_errors",
        finishedAt: "2026-02-01T00:02:00Z",
        summary: {
          runId: "run_1",
          accountsSynced: 1,
          balancesSynced: 1,
          transactionsSynced: 2,
          errors: [{ accountUid: "acct_1", message: "temporary provider failure" }],
        },
      });

      expect(await repo.get("ws_2", "run_1")).toBeUndefined();
      expect(await repo.get("ws_1", "run_1")).toMatchObject({
        runId: "run_1",
        workspaceId: "ws_1",
        sourceId: "src_1",
        status: "completed_with_errors",
        errors: [
          {
            accountUid: "acct_1",
            message: "temporary provider failure",
            at: "2026-02-01T00:01:00Z",
          },
        ],
      });
    } finally {
      t.close();
    }
  });

  it("exposes a workspace-bound adapter for the connector SyncRunStore", async () => {
    const t = createTestDatabase();
    try {
      const repo = new SqliteSyncRunRepository(t.db);
      const store = createWorkspaceSyncRunStore(repo, "ws_1");
      await store.start({
        workspaceId: "ws_1",
        runId: "run_adapter",
        sourceId: "src_1",
        startedAt: "2026-02-01T00:00:00Z",
      });
      await store.recordError({
        runId: "run_adapter",
        accountUid: "acct_1",
        message: "synthetic error",
        at: "2026-02-01T00:01:00Z",
      });
      await store.finish({
        runId: "run_adapter",
        status: "completed_with_errors",
        finishedAt: "2026-02-01T00:02:00Z",
        summary: {
          runId: "run_adapter",
          accountsSynced: 0,
          balancesSynced: 0,
          transactionsSynced: 0,
          errors: [{ accountUid: "acct_1", message: "synthetic error" }],
        },
      });

      expect(await repo.get("ws_1", "run_adapter")).toMatchObject({
        status: "completed_with_errors",
      });
    } finally {
      t.close();
    }
  });
});

describe("SQLite raw and bank record repositories", () => {
  it("appends raw records idempotently and exposes no update or delete path", async () => {
    const t = createTestDatabase();
    try {
      const repo = new SqliteRawRecordRepository(t.db);
      const record = rawRecord({ id: "raw_1", payload: { same: true } });

      await repo.append(record);
      await repo.append(rawRecord({ id: "raw_duplicate_id", payload: { same: true } }));

      expect(await repo.listForSource("ws_1", "src_1")).toHaveLength(1);
      expect(await repo.getById("ws_2", "raw_1")).toBeUndefined();
      expect("update" in repo).toBe(false);
      expect("delete" in repo).toBe(false);
    } finally {
      t.close();
    }
  });

  it("upserts bank records by natural keys and isolates workspaces", async () => {
    const t = createTestDatabase();
    try {
      const rawRepo = new SqliteRawRecordRepository(t.db);
      const bankRepo = new SqliteBankRecordRepository(t.db);
      const store = createWorkspaceBankRecordStore(bankRepo, "ws_1");
      await rawRepo.append(rawRecord({ id: "raw_bank_1", payload: { page: 1 } }));

      const account: NormalizedAccount = {
        externalId: "acct_ext_1",
        name: "Synthetic Checking",
        iban: undefined,
        currency: "EUR",
        product: "checking",
        raw: { kind: "account" },
      };
      const balance: NormalizedBalance = {
        accountExternalId: "acct_ext_1",
        type: "interimBooked",
        amount: "120.00",
        currency: "EUR",
        referenceDate: "2026-02-01",
        raw: { kind: "balance" },
      };
      const tx: NormalizedTransaction = {
        accountExternalId: "acct_ext_1",
        externalId: "txn_ext_1",
        bookedOn: "2026-02-01",
        valueDate: "2026-02-01",
        amount: "-42.50",
        currency: "EUR",
        status: "BOOK",
        counterpartyName: "Synthetic Vendor",
        remittanceInfo: "Synthetic invoice",
        raw: { kind: "transaction" },
      };

      await store.saveAccount(account, { rawRecordId: "raw_bank_1" });
      await store.saveBalance(balance, { rawRecordId: "raw_bank_1" });
      await store.saveTransaction(tx, { rawRecordId: "raw_bank_1" });
      await store.saveTransaction(
        { ...tx, remittanceInfo: "Updated text" },
        { rawRecordId: "raw_bank_1" },
      );

      expect(await bankRepo.getAccount("ws_1", "src_1", "acct_ext_1")).toMatchObject({
        name: "Synthetic Checking",
      });
      expect(
        await bankRepo.getBalance(
          "ws_1",
          "src_1",
          "acct_ext_1",
          "interimBooked",
          "EUR",
          "2026-02-01",
        ),
      ).toMatchObject({
        amount: "120.00",
      });
      expect(
        await bankRepo.getTransaction("ws_1", "src_1", "acct_ext_1", "txn_ext_1"),
      ).toMatchObject({
        remittanceInfo: "Updated text",
      });
      expect(await bankRepo.listTransactionsForAccount("ws_1", "src_1", "acct_ext_1")).toHaveLength(
        1,
      );
      expect(
        await bankRepo.getTransaction("ws_2", "src_1", "acct_ext_1", "txn_ext_1"),
      ).toBeUndefined();
    } finally {
      t.close();
    }
  });
});

describe("SQLite receipt repositories", () => {
  it("deduplicates documents by content hash within a workspace", async () => {
    const t = createTestDatabase();
    try {
      const repo = new SqliteDocumentRepository(t.db);
      const first = await repo.save(document({ id: "doc_1", contentHash: "hash_same" }));
      const second = await repo.save(document({ id: "doc_2", contentHash: "hash_same" }));
      const otherWorkspace = await repo.save(
        document({ id: "doc_3", workspaceId: "ws_2", contentHash: "hash_same" }),
      );

      expect(second.id).toBe(first.id);
      expect(otherWorkspace.id).toBe("doc_3");
      expect(await repo.findByContentHash("ws_2", "hash_same")).toMatchObject({ id: "doc_3" });
      expect(await repo.getById("ws_2", "doc_1")).toBeUndefined();
    } finally {
      t.close();
    }
  });

  it("roundtrips extractions, match candidates, decisions, and review transitions", async () => {
    const t = createTestDatabase();
    try {
      const documents = new SqliteDocumentRepository(t.db);
      const extractions = new SqliteDocumentExtractionRepository(t.db);
      const matches = new SqliteMatchCandidateRepository(t.db);
      const reviewQueue = new SqliteReviewQueueRepository(t.db);

      await documents.save(document());
      const savedExtraction = await extractions.save("ws_1", {
        id: "ext_1",
        extraction: extraction(),
        createdAt: "2026-02-01T00:03:00Z",
      });
      await matches.save(candidate({ extractionId: savedExtraction.id }));
      const decision: MatchDecision = {
        id: "dec_1",
        workspaceId: "ws_1",
        candidateId: "cand_1",
        decision: "approved",
        actor: "user:test",
        notes: "Synthetic approval",
        createdAt: "2026-02-01T00:04:00Z",
      };
      await matches.recordDecision(decision);
      await reviewQueue.enqueue({
        id: "review_1",
        workspaceId: "ws_1",
        targetType: "match_candidate",
        targetId: "cand_1",
        state: "suggested",
        reason: { source: "receipt_match", candidateId: "cand_1" },
        createdAt: "2026-02-01T00:05:00Z",
        updatedAt: "2026-02-01T00:05:00Z",
      });
      await reviewQueue.transition("ws_1", {
        id: "review_1",
        toState: "user_reviewed",
        actor: "user:test",
        at: "2026-02-01T00:06:00Z",
        notes: "Reviewed synthetic match",
      });

      expect(await extractions.getById("ws_1", "ext_1")).toMatchObject({
        vendorName: "Synthetic Vendor",
        confidence: 0.92,
      });
      expect(await extractions.getById("ws_2", "ext_1")).toBeUndefined();
      expect(await matches.getById("ws_1", "cand_1")).toMatchObject({
        extractionId: "ext_1",
        warnings: ["review required"],
      });
      expect(await matches.getById("ws_2", "cand_1")).toBeUndefined();
      expect(await matches.listDecisions("ws_1", "cand_1")).toEqual([decision]);
      expect(await matches.listDecisions("ws_2", "cand_1")).toEqual([]);
      expect(await reviewQueue.getById("ws_1", "review_1")).toMatchObject({
        state: "user_reviewed" satisfies ReviewState,
      });
      expect(await reviewQueue.getById("ws_2", "review_1")).toBeUndefined();
    } finally {
      t.close();
    }
  });
});

describe("SQLite portal task run repository", () => {
  it("persists append-only portal task provenance without credential fields", async () => {
    const t = createTestDatabase();
    try {
      const repo = new SqlitePortalTaskRunRepository(t.db);
      const run: TaskRunProvenance = {
        runId: "ptr_1",
        taskId: "portal.synthetic.invoices",
        taskVersion: 1,
        portalDomain: "portal.example",
        browserProvider: "fake",
        workspaceId: "ws_1",
        fetchedAt: "2026-02-01T00:00:00Z",
      };

      await repo.append(run);
      await expect(repo.append(run)).rejects.toThrow(/append-only/i);

      expect(await repo.getById("ws_1", "ptr_1")).toEqual(run);
      expect(await repo.getById("ws_2", "ptr_1")).toBeUndefined();
      expect("update" in repo).toBe(false);
      expect("delete" in repo).toBe(false);
      const columns = await repo.columnNames();
      expect(columns.some((column) => /credential|secret|password|token/i.test(column))).toBe(
        false,
      );
    } finally {
      t.close();
    }
  });
});
