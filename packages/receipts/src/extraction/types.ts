/**
 * Structured fields extracted from a document (OCR/text + parsing). Extraction
 * is a separate step from storage; the raw document is preserved regardless.
 * Amounts are decimal strings, never floats.
 */
export type ExtractionStatus = "succeeded" | "needs_ocr" | "needs_review" | "failed";

export type ExtractionFieldName =
  | "vendorName"
  | "documentDate"
  | "dueDate"
  | "totalAmount"
  | "taxAmount"
  | "currency"
  | "invoiceNumber"
  | "paymentReference";

export interface ExtractionEvidence {
  /** Text shown to a reviewer to explain the extracted value. */
  snippet: string;
  /** Zero-based page index when known. */
  pageIndex?: number;
  /** Character offset in `extractedText` when known. */
  startOffset?: number;
  /** Exclusive character offset in `extractedText` when known. */
  endOffset?: number;
}

export interface ExtractedField {
  value: string;
  /** Field-level confidence in [0, 1]. */
  confidence: number;
  evidence: ExtractionEvidence;
}

export type ExtractionFieldEvidence = Partial<Record<ExtractionFieldName, ExtractedField>>;

export interface DocumentExtraction {
  documentId: string;
  vendorName: string | undefined;
  /** Invoice/receipt date, ISO YYYY-MM-DD. */
  documentDate: string | undefined;
  dueDate: string | undefined;
  /** Gross total as a decimal string. */
  totalAmount: string | undefined;
  /** Tax portion as a decimal string, if present. */
  taxAmount: string | undefined;
  currency: string | undefined;
  invoiceNumber: string | undefined;
  paymentReference: string | undefined;
  extractedText: string | undefined;
  /** Extractor confidence in [0, 1]. */
  confidence: number;
  /** Version of the extractor that produced this record. */
  extractorVersion: string;
  /** Provider execution status. Older persisted rows may not have this yet. */
  status?: ExtractionStatus;
  /** Stable provider id, e.g. `pdf-text` or `fake`. */
  providerName?: string;
  /** Provider implementation version. */
  providerVersion?: string;
  /** Model id for model-backed providers. */
  model?: string;
  /** Field-level confidence and evidence snippets for reviewer traceability. */
  fieldEvidence?: ExtractionFieldEvidence;
  /** Non-fatal extraction warnings that force or explain review. */
  warnings?: string[];
}
