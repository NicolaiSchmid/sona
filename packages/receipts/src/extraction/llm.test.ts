import { describe, expect, it } from "vitest";
import type { LlmFetch } from "./llm.js";
import { LlmStructuringProvider } from "./llm.js";
import type { ExtractionProviderInput } from "./provider.js";

const input = {
  bytes: new TextEncoder().encode("RAW-PDF-BYTES"),
  text: "Sona Testbedarf GmbH\nRechnungsdatum: 15.01.2026\nGesamtbetrag: 84,23 EUR",
  metadata: {
    documentId: "doc_llm_1",
    mimeType: "application/pdf",
    originalFilename: "synthetic-invoice.pdf",
  },
} satisfies ExtractionProviderInput;

describe("LlmStructuringProvider", () => {
  it("is disabled by default and makes no network call", () => {
    let called = false;
    const fetch: LlmFetch = async () => {
      called = true;
      throw new Error("network should not be called");
    };

    expect(() => new LlmStructuringProvider({ fetch })).toThrow(/explicitly enabled/);
    expect(called).toBe(false);
  });

  it("sends document text instead of raw bytes when explicitly enabled", async () => {
    let body = "";
    const fetch: LlmFetch = async (_url, init) => {
      body = init.body;
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            documentId: "doc_llm_1",
            vendorName: "Sona Testbedarf GmbH",
            documentDate: "2026-01-15",
            dueDate: undefined,
            totalAmount: "84.23",
            taxAmount: undefined,
            currency: "EUR",
            invoiceNumber: "RE-2026-0042",
            paymentReference: undefined,
            extractedText: input.text,
            confidence: 0.86,
            extractorVersion: "llm-structuring@1",
            status: "succeeded",
            providerName: "test-llm",
            providerVersion: "1",
            model: "structured-test",
            fieldEvidence: {
              vendorName: {
                value: "Sona Testbedarf GmbH",
                confidence: 0.9,
                evidence: { snippet: "Sona Testbedarf GmbH" },
              },
              documentDate: {
                value: "2026-01-15",
                confidence: 0.9,
                evidence: { snippet: "Rechnungsdatum: 15.01.2026" },
              },
              totalAmount: {
                value: "84.23",
                confidence: 0.8,
                evidence: { snippet: "Gesamtbetrag: 84,23 EUR" },
              },
              currency: {
                value: "EUR",
                confidence: 0.9,
                evidence: { snippet: "Gesamtbetrag: 84,23 EUR" },
              },
              invoiceNumber: {
                value: "RE-2026-0042",
                confidence: 0.7,
                evidence: { snippet: "RE-2026-0042" },
              },
            },
          });
        },
      };
    };

    const provider = new LlmStructuringProvider({
      enabled: true,
      endpoint: "https://llm.invalid/extract",
      authorizationHeader: "Bearer synthetic-test-secret",
      model: "structured-test",
      providerName: "test-llm",
      fetch,
    });

    const result = await provider.extract(input);

    expect(result.status).toBe("succeeded");
    expect(result.totalAmount).toBe("84.23");
    expect(JSON.parse(body)).toMatchObject({
      document: {
        text: input.text,
      },
    });
    expect(body).not.toContain("RAW-PDF-BYTES");
  });

  it("degrades invalid model output to needs_review without fabricated fields", async () => {
    const fetch: LlmFetch = async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          vendorName: "Missing evidence and required contract fields",
          confidence: 0.9,
        });
      },
    });
    const provider = new LlmStructuringProvider({
      enabled: true,
      endpoint: "https://llm.invalid/extract",
      authorizationHeader: "Bearer synthetic-test-secret",
      model: "structured-test",
      providerName: "test-llm",
      fetch,
    });

    const result = await provider.extract(input);

    expect(result.status).toBe("needs_review");
    expect(result.vendorName).toBeUndefined();
    expect(result.totalAmount).toBeUndefined();
    expect(result.warnings).toContain("invalid llm extraction output");
  });
});
