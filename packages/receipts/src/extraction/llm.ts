import type { ExtractionProvider, ExtractionProviderInput } from "./provider.js";
import { assertProviderExtractionResult, validateProviderExtractionResult } from "./provider.js";
import type { DocumentExtraction } from "./types.js";

export interface LlmFetchInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

export interface LlmFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type LlmFetch = (url: string, init: LlmFetchInit) => Promise<LlmFetchResponse>;

export interface LlmStructuringProviderConfig {
  enabled?: boolean;
  endpoint?: string;
  authorizationHeader?: string;
  providerName?: string;
  providerVersion?: string;
  model?: string;
  fetch?: LlmFetch;
  allowRawBytes?: boolean;
}

export class LlmStructuringProvider implements ExtractionProvider {
  readonly name: string;
  readonly version: string;
  readonly #endpoint: string;
  readonly #authorizationHeader: string;
  readonly #model: string;
  readonly #fetch: LlmFetch;
  readonly #allowRawBytes: boolean;

  constructor(config: LlmStructuringProviderConfig = {}) {
    if (config.enabled !== true) {
      throw new Error("LLM extraction must be explicitly enabled in config");
    }
    if (config.endpoint === undefined || config.endpoint.trim() === "") {
      throw new Error("LLM extraction endpoint is required");
    }
    if (config.authorizationHeader === undefined || config.authorizationHeader.trim() === "") {
      throw new Error("LLM extraction credentials are required");
    }
    if (config.model === undefined || config.model.trim() === "") {
      throw new Error("LLM extraction model is required");
    }

    this.name = config.providerName ?? "llm-structuring";
    this.version = config.providerVersion ?? "1";
    this.#endpoint = config.endpoint;
    this.#authorizationHeader = config.authorizationHeader;
    this.#model = config.model;
    this.#fetch = config.fetch ?? defaultFetch;
    this.#allowRawBytes = config.allowRawBytes ?? false;
  }

  async extract(input: ExtractionProviderInput): Promise<DocumentExtraction> {
    const text = input.text ?? textFromPlainDocument(input);
    if (text === undefined && !this.#allowRawBytes) {
      return this.needsReview(input, ["document text required before llm structuring"]);
    }

    const payload = {
      model: this.#model,
      document: {
        documentId: input.metadata.documentId,
        mimeType: input.metadata.mimeType,
        originalFilename: input.metadata.originalFilename,
        text,
        rawBytesBase64: this.#allowRawBytes
          ? Buffer.from(input.bytes).toString("base64")
          : undefined,
      },
      instruction:
        "Extract invoice fields. Return only the configured JSON extraction contract with field evidence snippets.",
    };

    let responseText: string;
    try {
      const response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          authorization: this.#authorizationHeader,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        return this.needsReview(input, [
          `llm extraction request failed with status ${response.status}`,
        ]);
      }
      responseText = await response.text();
    } catch {
      return this.needsReview(input, ["llm extraction request failed"]);
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(responseText);
    } catch {
      return this.needsReview(input, ["invalid llm extraction output"]);
    }

    const candidate = unwrapExtraction(decoded);
    const validated = validateProviderExtractionResult(candidate);
    if (!validated.success) {
      return this.needsReview(input, ["invalid llm extraction output"]);
    }

    return assertProviderExtractionResult({
      ...validated.data,
      documentId: input.metadata.documentId,
      extractorVersion: `${this.name}@${this.version}`,
      providerName: this.name,
      providerVersion: this.version,
      model: this.#model,
    });
  }

  private needsReview(input: ExtractionProviderInput, warnings: string[]): DocumentExtraction {
    return assertProviderExtractionResult({
      documentId: input.metadata.documentId,
      vendorName: undefined,
      documentDate: undefined,
      dueDate: undefined,
      totalAmount: undefined,
      taxAmount: undefined,
      currency: undefined,
      invoiceNumber: undefined,
      paymentReference: undefined,
      extractedText: input.text,
      confidence: 0,
      extractorVersion: `${this.name}@${this.version}`,
      status: "needs_review",
      providerName: this.name,
      providerVersion: this.version,
      model: this.#model,
      warnings,
    });
  }
}

const defaultFetch: LlmFetch = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
  });
  return {
    ok: response.ok,
    status: response.status,
    text: () => response.text(),
  };
};

function textFromPlainDocument(input: ExtractionProviderInput): string | undefined {
  if (!input.metadata.mimeType.startsWith("text/")) {
    return undefined;
  }
  return new TextDecoder().decode(input.bytes);
}

function unwrapExtraction(value: unknown): unknown {
  if (isRecord(value) && "extraction" in value) {
    return value["extraction"];
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
