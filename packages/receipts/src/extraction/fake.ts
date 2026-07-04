import type { ExtractionProvider, ExtractionProviderInput } from "./provider.js";
import { assertProviderExtractionResult, compactFieldEvidence, field } from "./provider.js";
import type { DocumentExtraction } from "./types.js";

export interface FakeExtractionProviderOptions {
  confidence?: number;
  fieldConfidence?: number;
  vendorName?: string;
  documentDate?: string;
  totalAmount?: string;
  currency?: string;
  invoiceNumber?: string;
}

export class FakeExtractionProvider implements ExtractionProvider {
  readonly name = "fake";
  readonly version = "1";
  readonly #options: FakeExtractionProviderOptions;

  constructor(options: FakeExtractionProviderOptions = {}) {
    this.#options = options;
  }

  async extract(input: ExtractionProviderInput): Promise<DocumentExtraction> {
    const text = [
      this.#options.vendorName ?? "Synthetic Vendor",
      `Invoice ${this.#options.invoiceNumber ?? "INV-FAKE-001"}`,
      `Date ${this.#options.documentDate ?? "2026-01-31"}`,
      `Total ${this.#options.totalAmount ?? "42.50"} ${this.#options.currency ?? "EUR"}`,
    ].join("\n");
    const fieldConfidence = this.#options.fieldConfidence ?? this.#options.confidence ?? 0.98;
    const vendorName = this.#options.vendorName ?? "Synthetic Vendor";
    const documentDate = this.#options.documentDate ?? "2026-01-31";
    const totalAmount = this.#options.totalAmount ?? "42.50";
    const currency = this.#options.currency ?? "EUR";
    const invoiceNumber = this.#options.invoiceNumber ?? "INV-FAKE-001";
    const result: DocumentExtraction = {
      documentId: input.metadata.documentId,
      vendorName,
      documentDate,
      dueDate: undefined,
      totalAmount,
      taxAmount: undefined,
      currency,
      invoiceNumber,
      paymentReference: undefined,
      extractedText: text,
      confidence: this.#options.confidence ?? 0.98,
      extractorVersion: `${this.name}@${this.version}`,
      status: "succeeded",
      providerName: this.name,
      providerVersion: this.version,
      fieldEvidence: compactFieldEvidence({
        vendorName: field(text, vendorName, fieldConfidence, vendorName),
        documentDate: field(text, documentDate, fieldConfidence, documentDate),
        totalAmount: field(text, totalAmount, fieldConfidence, totalAmount),
        currency: field(text, currency, fieldConfidence, currency),
        invoiceNumber: field(text, invoiceNumber, fieldConfidence, invoiceNumber),
      }),
    };

    return assertProviderExtractionResult(result);
  }
}
