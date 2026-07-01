/**
 * Structured fields extracted from a document (OCR/text + parsing). Extraction
 * is a separate step from storage; the raw document is preserved regardless.
 * Amounts are decimal strings, never floats.
 */
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
}
