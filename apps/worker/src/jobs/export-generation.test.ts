import { SUSPENSE_ACCOUNTS } from "@sona/core";
import { RECORD_TYPES } from "@sona/db";
import { PACKAGE_FILES, PRIVATE_DE_TEMPLATE, type TaxExportPackage } from "@sona/tax-de";
import { describe, expect, it } from "vitest";
import { createTestHarness, SRC_1, type TestHarness, WS_1 } from "../test-support.js";
import { exportStorageId } from "./export-generation.js";

interface StoredBundle {
  generatedAt: string;
  workspaceId: string;
  package: TaxExportPackage;
}

async function readBundle(h: TestHarness, storageId: string): Promise<StoredBundle> {
  const { bytes } = await h.storage.get({ context: h.context, id: storageId });
  return JSON.parse(new TextDecoder().decode(bytes)) as StoredBundle;
}

function csvRows(pkg: TaxExportPackage, path: string): string[] {
  const file = pkg.files.find((f) => f.path === path);
  return (file?.content ?? "")
    .split("\n")
    .slice(1)
    .filter((line) => line !== "");
}

/** Syncs the bank, then classifies one draft by superseding it with a reviewed transaction. */
async function seedLedger(h: TestHarness): Promise<{ reviewedId: string; documentId: string }> {
  await h.worker.queue.enqueue(h.context, "source_sync", { sourceId: SRC_1 });
  await h.worker.runOnce({ kinds: ["source_sync"] });
  const ledger = h.worker.repositories.ledger;
  const draft = (await ledger.listTransactions(WS_1)).find((t) =>
    t.description.startsWith("Example Handwerk"),
  );
  if (draft === undefined) {
    throw new Error("expected the Handwerk draft");
  }
  const bankLeg = draft.postings.find((p) => p.account !== SUSPENSE_ACCOUNTS.unclassified);
  if (bankLeg === undefined) {
    throw new Error("expected a bank leg");
  }
  const { replacement } = await ledger.supersedeTransaction(WS_1, {
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
  await ledger.transitionReviewState(WS_1, {
    id: replacement.id,
    toState: "user_reviewed",
    actor: "user_1",
    at: h.clock.now(),
  });
  // A stored document substantiates the reviewed transaction.
  await h.worker.repositories.documents.save({
    id: "doc_receipt",
    workspaceId: WS_1,
    contentHash: "a".repeat(64),
    mimeType: "application/pdf",
    originalFilename: "r.pdf",
    storageUri: "sona-document://ws_1/doc_receipt",
    sourceKind: "upload",
    sourceMetadata: undefined,
    retentionState: "active",
    createdAt: h.clock.now(),
  });
  await h.worker.repositories.evidenceLinks.link({
    id: h.ids(),
    workspaceId: WS_1,
    fromType: "document",
    fromId: "doc_receipt",
    toType: "ledger_transaction",
    toId: replacement.id,
    kind: "substantiates",
    createdAt: h.clock.now(),
  });
  return { reviewedId: replacement.id, documentId: "doc_receipt" };
}

describe("export_generation job", () => {
  it("exports reviewed postings with their evidence and excludes drafts and superseded ones", async () => {
    const h = await createTestHarness();
    try {
      const { reviewedId, documentId } = await seedLedger(h);
      const { job } = await h.worker.queue.enqueue(h.context, "export_generation", {
        year: 2026,
        mode: "final",
      });
      const [outcome] = await h.worker.runOnce({ kinds: ["export_generation"] });
      expect(outcome?.state).toBe("succeeded");
      const storageId = exportStorageId({
        year: 2026,
        mode: "final",
        templateId: PRIVATE_DE_TEMPLATE.id,
        revision: job.id,
      });
      expect(outcome?.produced).toEqual([{ type: RECORD_TYPES.taxExportPackage, id: storageId }]);

      const bundle = await readBundle(h, storageId);
      expect(bundle.workspaceId).toBe(WS_1);
      expect(bundle.package).toMatchObject({ year: 2026, mode: "final", templateId: "private-de" });
      const lines = csvRows(bundle.package, "tax-categories.csv");
      // Both legs of the reviewed transaction; nothing from the draft rent transaction
      // or the superseded original.
      expect(lines).toHaveLength(2);
      expect(lines.every((line) => line.includes(reviewedId))).toBe(true);
      expect(lines.some((line) => line.includes("Expenses:RealEstate:Maintenance"))).toBe(true);
      expect(lines.some((line) => line.includes(documentId))).toBe(true);
      expect(lines.some((line) => line.includes("Tenant Mietzahlung"))).toBe(false);
      expect(csvRows(bundle.package, "missing-evidence.csv")).toEqual([]);

      const runs = await h.worker.queue.listRuns(h.context, job.id);
      expect(runs[0]?.result).toMatchObject({
        storageId,
        year: 2026,
        mode: "final",
        lineCount: 2,
        files: [...PACKAGE_FILES],
      });
    } finally {
      h.close();
    }
  });

  it("draft mode includes suggested lines but still never draft postings", async () => {
    const h = await createTestHarness();
    try {
      const { reviewedId } = await seedLedger(h);
      await h.worker.repositories.ledger.createTransaction(WS_1, {
        id: "tx_suggested",
        bookedOn: "2026-03-01",
        description: "Suggested classification",
        postings: [
          { account: "Assets:Bank", amount: { amount: "-10.00", commodity: "EUR" } },
          { account: "Expenses:Donations", amount: { amount: "10.00", commodity: "EUR" } },
        ],
        reviewState: "suggested",
        createdAt: h.clock.now(),
      });
      const { job } = await h.worker.queue.enqueue(h.context, "export_generation", { year: 2026 });
      await h.worker.runOnce({ kinds: ["export_generation"] });
      const bundle = await readBundle(
        h,
        exportStorageId({
          year: 2026,
          mode: "draft",
          templateId: PRIVATE_DE_TEMPLATE.id,
          revision: job.id,
        }),
      );
      const lines = csvRows(bundle.package, "tax-categories.csv");
      expect(lines.filter((l) => l.includes(reviewedId))).toHaveLength(2);
      expect(lines.filter((l) => l.includes("tx_suggested"))).toHaveLength(2);
      expect(lines.some((l) => l.includes(SUSPENSE_ACCOUNTS.unclassified))).toBe(false);
      // The donation has no receipt: it shows up in the missing-evidence report.
      expect(csvRows(bundle.package, "missing-evidence.csv")).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("stores the bundle as JSON with export metadata and a sanitized storage id", async () => {
    const h = await createTestHarness();
    try {
      await seedLedger(h);
      h.clock.set("2026-04-01T09:30:00.000Z");
      const { job } = await h.worker.queue.enqueue(h.context, "export_generation", {
        year: 2026,
        mode: "final",
      });
      await h.worker.runOnce({ kinds: ["export_generation"] });
      const storageId = exportStorageId({
        year: 2026,
        mode: "final",
        templateId: PRIVATE_DE_TEMPLATE.id,
        revision: job.id,
      });
      const stored = await h.storage.get({ context: h.context, id: storageId });
      expect(stored.document).toMatchObject({
        contentType: "application/json",
        originalFilename: `${storageId}.json`,
        metadata: {
          kind: RECORD_TYPES.taxExportPackage,
          year: "2026",
          mode: "final",
          templateId: PRIVATE_DE_TEMPLATE.id,
        },
      });
      const bundle = JSON.parse(new TextDecoder().decode(stored.bytes)) as StoredBundle;
      expect(bundle.generatedAt).toBe("2026-04-01T09:30:00.000Z");
      expect(bundle.workspaceId).toBe(WS_1);
      // The bundle is scoped to its workspace's storage.
      await expect(h.storage.get({ context: h.otherContext, id: storageId })).rejects.toThrow();

      expect(
        exportStorageId({
          year: 2026,
          mode: "draft",
          templateId: "private/de v2",
          revision: "job:1/x",
        }),
      ).toBe("tax-export-2026-draft-private_de_v2-job_1_x");
    } finally {
      h.close();
    }
  });

  it("only exports postings booked in the requested year", async () => {
    const h = await createTestHarness();
    try {
      const { reviewedId } = await seedLedger(h);
      const ledger = h.worker.repositories.ledger;
      for (const [id, bookedOn] of [
        ["tx_prev_year", "2025-12-31"],
        ["tx_next_year", "2027-01-01"],
        ["tx_first_day", "2026-01-01"],
      ] as const) {
        await ledger.createTransaction(WS_1, {
          id,
          bookedOn,
          description: `Reviewed ${id}`,
          postings: [
            { account: "Assets:Bank", amount: { amount: "-5.00", commodity: "EUR" } },
            { account: "Expenses:Donations", amount: { amount: "5.00", commodity: "EUR" } },
          ],
          reviewState: "suggested",
          createdAt: h.clock.now(),
        });
        await ledger.transitionReviewState(WS_1, {
          id,
          toState: "user_reviewed",
          actor: "user_1",
          at: h.clock.now(),
        });
      }
      const { job } = await h.worker.queue.enqueue(h.context, "export_generation", {
        year: 2026,
        mode: "final",
      });
      await h.worker.runOnce({ kinds: ["export_generation"] });
      const bundle = await readBundle(
        h,
        exportStorageId({
          year: 2026,
          mode: "final",
          templateId: PRIVATE_DE_TEMPLATE.id,
          revision: job.id,
        }),
      );
      const lines = csvRows(bundle.package, "tax-categories.csv");
      expect(lines.filter((l) => l.includes(reviewedId))).toHaveLength(2);
      expect(lines.filter((l) => l.includes("tx_first_day"))).toHaveLength(2);
      expect(lines.some((l) => l.includes("tx_prev_year"))).toBe(false);
      expect(lines.some((l) => l.includes("tx_next_year"))).toBe(false);
      expect((await h.worker.queue.listRuns(h.context, job.id))[0]?.result).toMatchObject({
        // Only the 2026 transactions are fed to the template (2 reviewed + 2 drafts, 2 legs each).
        postingCount: 8,
        lineCount: 4,
      });
    } finally {
      h.close();
    }
  });

  it("final mode leaves suggested postings out of the export", async () => {
    const h = await createTestHarness();
    try {
      const { reviewedId } = await seedLedger(h);
      await h.worker.repositories.ledger.createTransaction(WS_1, {
        id: "tx_suggested",
        bookedOn: "2026-03-01",
        description: "Suggested classification",
        postings: [
          { account: "Assets:Bank", amount: { amount: "-10.00", commodity: "EUR" } },
          { account: "Expenses:Donations", amount: { amount: "10.00", commodity: "EUR" } },
        ],
        reviewState: "suggested",
        createdAt: h.clock.now(),
      });
      const { job } = await h.worker.queue.enqueue(h.context, "export_generation", {
        year: 2026,
        mode: "final",
      });
      const [outcome] = await h.worker.runOnce({ kinds: ["export_generation"] });
      expect(outcome?.state).toBe("succeeded");
      const bundle = await readBundle(
        h,
        exportStorageId({
          year: 2026,
          mode: "final",
          templateId: PRIVATE_DE_TEMPLATE.id,
          revision: job.id,
        }),
      );
      const lines = csvRows(bundle.package, "tax-categories.csv");
      expect(lines.filter((l) => l.includes(reviewedId))).toHaveLength(2);
      expect(lines.some((l) => l.includes("tx_suggested"))).toBe(false);
      // Draft and final bundles of the same year are distinct jobs and files.
      const draft = await h.worker.queue.enqueue(h.context, "export_generation", { year: 2026 });
      expect(draft.created).toBe(true);
      expect(draft.job.id).not.toBe(job.id);
    } finally {
      h.close();
    }
  });

  it("is idempotent per year/mode/template and dead-letters unknown templates", async () => {
    const h = await createTestHarness();
    try {
      const first = await h.worker.queue.enqueue(h.context, "export_generation", { year: 2026 });
      const dup = await h.worker.queue.enqueue(h.context, "export_generation", { year: 2026 });
      expect(dup.created).toBe(false);
      expect(dup.job.id).toBe(first.job.id);
      await h.worker.queue.enqueue(h.context, "export_generation", {
        year: 2026,
        templateId: "nope",
      });
      const outcomes = await h.worker.runOnce({ kinds: ["export_generation"] });
      expect(outcomes.map((o) => o.state)).toEqual(["succeeded", "dead"]);
      expect(outcomes[1]?.error).toMatch(/unknown tax template nope/);
    } finally {
      h.close();
    }
  });
});
