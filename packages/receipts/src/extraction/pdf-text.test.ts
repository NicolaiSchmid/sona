import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PdfTextExtractionProvider } from "./pdf-text.js";
import type { ExtractionProviderInput } from "./provider.js";

async function fixture(name: string): Promise<Uint8Array> {
  return readFile(new URL(`../../fixtures/pdfs/${name}`, import.meta.url));
}

function input(bytes: Uint8Array, documentId = "doc_pdf_1"): ExtractionProviderInput {
  return {
    bytes,
    metadata: {
      documentId,
      mimeType: "application/pdf",
      originalFilename: `${documentId}.pdf`,
    },
  };
}

describe("PdfTextExtractionProvider", () => {
  it("extracts structured fields from a synthetic German invoice text layer", async () => {
    const provider = new PdfTextExtractionProvider();

    const result = await provider.extract(input(await fixture("synthetic-german-invoice.pdf")));

    expect(result.status).toBe("succeeded");
    expect(result.vendorName).toBe("Sona Testbedarf GmbH");
    expect(result.documentDate).toBe("2026-01-15");
    expect(result.totalAmount).toBe("84.23");
    expect(result.currency).toBe("EUR");
    expect(result.invoiceNumber).toBe("RE-2026-0042");
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    expect(result.fieldEvidence?.totalAmount?.confidence).toBeGreaterThanOrEqual(0.8);
    expect(result.fieldEvidence?.totalAmount?.evidence.snippet).toContain("84,23 EUR");
  });

  it("lowers confidence and requires review for ambiguous totals", async () => {
    const provider = new PdfTextExtractionProvider();

    const result = await provider.extract(input(await fixture("ambiguous-german-invoice.pdf")));

    expect(result.status).toBe("needs_review");
    expect(result.totalAmount).toBe("84.23");
    expect(result.confidence).toBeLessThan(0.6);
    expect(result.fieldEvidence?.totalAmount?.confidence).toBeLessThan(0.6);
    expect(result.warnings).toContain("multiple conflicting total amounts");
  });

  it("returns needs_ocr for PDFs without a text layer", async () => {
    const provider = new PdfTextExtractionProvider();

    const result = await provider.extract(input(await fixture("scanned-image-only.pdf")));

    expect(result.status).toBe("needs_ocr");
    expect(result.extractedText).toBeUndefined();
    expect(result.totalAmount).toBeUndefined();
    expect(result.confidence).toBe(0);
  });
});
