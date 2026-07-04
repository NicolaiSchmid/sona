import { z } from "zod";
import type { DocumentSourceKind } from "../documents/types.js";
import type { MatchableDocument } from "../reconciliation/matches.js";
import type {
  DocumentExtraction,
  ExtractionEvidence,
  ExtractionFieldEvidence,
  ExtractionFieldName,
} from "./types.js";

export interface ExtractionDocumentMetadata {
  documentId: string;
  mimeType: string;
  originalFilename: string | undefined;
  contentHash?: string;
  sourceKind?: DocumentSourceKind;
}

export interface ExtractionProviderInput {
  bytes: Uint8Array;
  /** Optional text layer from an upstream local extractor. */
  text?: string;
  metadata: ExtractionDocumentMetadata;
}

export interface ExtractionProvider {
  readonly name: string;
  readonly version: string;
  extract(input: ExtractionProviderInput): Promise<DocumentExtraction>;
}

const extractionStatusSchema = z.union([
  z.literal("succeeded"),
  z.literal("needs_ocr"),
  z.literal("needs_review"),
  z.literal("failed"),
]);

const evidenceSchema = z
  .object({
    snippet: z.string().min(1),
    pageIndex: z.number().int().nonnegative().optional(),
    startOffset: z.number().int().nonnegative().optional(),
    endOffset: z.number().int().nonnegative().optional(),
  })
  .strict();

const extractedFieldSchema = z
  .object({
    value: z.string().min(1),
    confidence: z.number().min(0).max(1),
    evidence: evidenceSchema,
  })
  .strict();

const fieldEvidenceSchema = z
  .object({
    vendorName: extractedFieldSchema.optional(),
    documentDate: extractedFieldSchema.optional(),
    dueDate: extractedFieldSchema.optional(),
    totalAmount: extractedFieldSchema.optional(),
    taxAmount: extractedFieldSchema.optional(),
    currency: extractedFieldSchema.optional(),
    invoiceNumber: extractedFieldSchema.optional(),
    paymentReference: extractedFieldSchema.optional(),
  })
  .strict();

export const documentExtractionSchema = z
  .object({
    documentId: z.string().min(1),
    vendorName: z.string().optional(),
    documentDate: z.string().optional(),
    dueDate: z.string().optional(),
    totalAmount: z.string().optional(),
    taxAmount: z.string().optional(),
    currency: z.string().optional(),
    invoiceNumber: z.string().optional(),
    paymentReference: z.string().optional(),
    extractedText: z.string().optional(),
    confidence: z.number().min(0).max(1),
    extractorVersion: z.string().min(1),
    status: extractionStatusSchema.optional(),
    providerName: z.string().min(1).optional(),
    providerVersion: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    fieldEvidence: fieldEvidenceSchema.optional(),
    warnings: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type DocumentExtractionSchemaResult = z.infer<typeof documentExtractionSchema>;

export type ProviderExtractionValidationResult =
  | { success: true; data: DocumentExtraction }
  | { success: false; errors: string[] };

const extractionFieldNames = [
  "vendorName",
  "documentDate",
  "dueDate",
  "totalAmount",
  "taxAmount",
  "currency",
  "invoiceNumber",
  "paymentReference",
] as const satisfies readonly ExtractionFieldName[];

export function validateProviderExtractionResult(
  extraction: unknown,
): ProviderExtractionValidationResult {
  const parsed = documentExtractionSchema.safeParse(extraction);
  if (!parsed.success) {
    return { success: false, errors: parsed.error.issues.map((issue) => issue.message) };
  }
  const result = normalizeDocumentExtraction(parsed.data);
  const errors: string[] = [];

  if (result.status === undefined) {
    errors.push("provider extraction status is required");
  }
  if (result.providerName === undefined) {
    errors.push("providerName is required");
  }
  if (result.providerVersion === undefined) {
    errors.push("providerVersion is required");
  }

  for (const fieldName of extractionFieldNames) {
    const value = result[fieldName];
    if (value !== undefined) {
      const evidence = result.fieldEvidence?.[fieldName];
      if (evidence === undefined) {
        errors.push(`${fieldName} is missing field evidence`);
      } else if (evidence.value !== value) {
        errors.push(`${fieldName} evidence value does not match extracted value`);
      }
    }
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }
  return { success: true, data: result };
}

export function assertProviderExtractionResult(extraction: unknown): DocumentExtraction {
  const validated = validateProviderExtractionResult(extraction);
  if (!validated.success) {
    throw new Error(`Invalid provider extraction result: ${validated.errors.join("; ")}`);
  }
  return validated.data;
}

function normalizeDocumentExtraction(input: DocumentExtractionSchemaResult): DocumentExtraction {
  return {
    documentId: input.documentId,
    vendorName: input.vendorName,
    documentDate: input.documentDate,
    dueDate: input.dueDate,
    totalAmount: input.totalAmount,
    taxAmount: input.taxAmount,
    currency: input.currency,
    invoiceNumber: input.invoiceNumber,
    paymentReference: input.paymentReference,
    extractedText: input.extractedText,
    confidence: input.confidence,
    extractorVersion: input.extractorVersion,
    status: input.status,
    providerName: input.providerName,
    providerVersion: input.providerVersion,
    model: input.model,
    fieldEvidence: input.fieldEvidence,
    warnings: input.warnings,
  };
}

export function makeEvidence(
  text: string,
  snippet: string,
  options: { pageIndex?: number } = {},
): ExtractionEvidence {
  const startOffset = text.indexOf(snippet);
  return {
    snippet,
    pageIndex: options.pageIndex,
    startOffset: startOffset >= 0 ? startOffset : undefined,
    endOffset: startOffset >= 0 ? startOffset + snippet.length : undefined,
  };
}

export function field(
  text: string,
  value: string,
  confidence: number,
  snippet: string,
): { value: string; confidence: number; evidence: ExtractionEvidence } {
  return {
    value,
    confidence,
    evidence: makeEvidence(text, snippet),
  };
}

export function compactFieldEvidence(
  fields: ExtractionFieldEvidence,
): ExtractionFieldEvidence | undefined {
  for (const fieldName of extractionFieldNames) {
    if (fields[fieldName] !== undefined) {
      return fields;
    }
  }
  return undefined;
}

export function extractionToMatchableDocument(
  extraction: DocumentExtraction,
  options: { sourceReliability?: number } = {},
): MatchableDocument {
  return {
    id: extraction.documentId,
    totalAmount: extraction.totalAmount,
    currency: extraction.currency,
    documentDate: extraction.documentDate,
    dueDate: extraction.dueDate,
    vendorName: extraction.vendorName,
    invoiceNumber: extraction.invoiceNumber,
    paymentReference: extraction.paymentReference,
    confidence: extraction.confidence,
    sourceReliability: options.sourceReliability,
  };
}
