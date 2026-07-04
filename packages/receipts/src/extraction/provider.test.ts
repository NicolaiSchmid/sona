import { describe, expect, it } from "vitest";
import { decideMatch } from "../reconciliation/policies.js";
import { scoreMatch } from "../reconciliation/scoring.js";
import { FakeExtractionProvider } from "./fake.js";
import type { ExtractionProviderInput } from "./provider.js";
import {
  documentExtractionSchema,
  extractionToMatchableDocument,
  validateProviderExtractionResult,
} from "./provider.js";

const input = {
  bytes: new TextEncoder().encode("synthetic document text"),
  metadata: {
    documentId: "doc_1",
    mimeType: "application/pdf",
    originalFilename: "synthetic-invoice.pdf",
  },
} satisfies ExtractionProviderInput;

describe("ExtractionProvider", () => {
  it("keeps the fake provider deterministic and schema-valid", async () => {
    const provider = new FakeExtractionProvider();

    const first = await provider.extract(input);
    const second = await provider.extract(input);

    expect(second).toEqual(first);
    expect(validateProviderExtractionResult(first).success).toBe(true);
    expect(first.providerName).toBe("fake");
    expect(first.fieldEvidence?.totalAmount?.evidence.snippet).toContain("42.50");
  });

  it("validates confidence ranges at the extraction boundary", () => {
    const result = documentExtractionSchema.safeParse({
      documentId: "doc_1",
      vendorName: undefined,
      documentDate: undefined,
      dueDate: undefined,
      totalAmount: undefined,
      taxAmount: undefined,
      currency: undefined,
      invoiceNumber: undefined,
      paymentReference: undefined,
      extractedText: undefined,
      confidence: 1.2,
      extractorVersion: "test@1",
    });

    expect(result.success).toBe(false);
  });

  it("routes low-confidence extractions to review and excludes them from auto-match", async () => {
    const provider = new FakeExtractionProvider({
      confidence: 0.4,
      fieldConfidence: 0.4,
    });
    const extraction = await provider.extract(input);

    const score = scoreMatch(
      {
        id: "tx_1",
        amount: "-42.50",
        currency: "EUR",
        bookedOn: "2026-01-31",
        valueDate: "2026-01-31",
        counterpartyName: "Synthetic Vendor",
        remittanceInfo: "Invoice INV-FAKE-001",
        account: "Expenses:WorkRelated",
        sourceReliability: 0.9,
      },
      extractionToMatchableDocument(extraction, { sourceReliability: 0.9 }),
    );

    const decision = decideMatch({
      score,
      transaction: {
        id: "tx_1",
        amount: "-42.50",
        currency: "EUR",
        bookedOn: "2026-01-31",
        valueDate: "2026-01-31",
        counterpartyName: "Synthetic Vendor",
        remittanceInfo: "Invoice INV-FAKE-001",
        account: "Expenses:WorkRelated",
        sourceReliability: 0.9,
      },
    });

    expect(score.warnings).toContain("low extraction confidence");
    expect(decision.outcome).toBe("review");
  });

  it("allows high-confidence extractions to flow into auto-match scoring", async () => {
    const provider = new FakeExtractionProvider({ confidence: 0.98 });
    const extraction = await provider.extract(input);
    const transaction = {
      id: "tx_1",
      amount: "-42.50",
      currency: "EUR",
      bookedOn: "2026-01-31",
      valueDate: "2026-01-31",
      counterpartyName: "Synthetic Vendor",
      remittanceInfo: "Invoice INV-FAKE-001",
      account: "Expenses:WorkRelated",
      sourceReliability: 0.9,
    };

    const score = scoreMatch(
      transaction,
      extractionToMatchableDocument(extraction, { sourceReliability: 0.9 }),
    );
    const decision = decideMatch({ score, transaction });

    expect(score.warnings).toEqual([]);
    expect(decision.outcome).toBe("auto_match");
  });
});
