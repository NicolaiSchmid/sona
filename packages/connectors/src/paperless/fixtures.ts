/**
 * Synthetic Paperless documents for tests. No real archive data.
 */
import type { FakePaperlessDocument } from "./fake-client.js";
import type { PaperlessNamedEntity } from "./types.js";

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

/** Minimal PDF signature so the byte-signature check passes. */
export const INVOICE_PDF = text("%PDF-1.7\n% synthetic broadband invoice\n%%EOF");
export const RECEIPT_PDF = text("%PDF-1.4\n% synthetic pharmacy receipt\n%%EOF");
/** PNG signature followed by filler. */
export const PHOTO_PNG = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  ...text("synthetic photo"),
]);

export const TAGS: PaperlessNamedEntity[] = [
  { id: 1, name: "Steuer" },
  { id: 2, name: "Rechnung" },
  { id: 3, name: "Privat" },
];

export const CORRESPONDENTS: PaperlessNamedEntity[] = [
  { id: 10, name: "Example Telecom" },
  { id: 11, name: "Example Pharmacy" },
];

export const DOCUMENT_TYPES: PaperlessNamedEntity[] = [
  { id: 20, name: "Invoice" },
  { id: 21, name: "Receipt" },
];

export const INVOICE_DOCUMENT: FakePaperlessDocument = {
  id: 101,
  title: "Broadband invoice March",
  created: "2026-03-01T00:00:00+01:00",
  modified: "2026-03-02T09:00:00Z",
  added: "2026-03-01T18:00:00Z",
  correspondentId: 10,
  documentTypeId: 20,
  tagIds: [1, 2],
  archiveSerialNumber: 7,
  originalFileName: "invoice-2026-03.pdf",
  mimeType: "application/pdf",
  bytes: INVOICE_PDF,
  contentType: "application/pdf",
};

export const RECEIPT_DOCUMENT: FakePaperlessDocument = {
  id: 102,
  title: "Pharmacy receipt",
  created: "2026-03-05T00:00:00+01:00",
  modified: "2026-03-05T12:00:00Z",
  added: "2026-03-05T12:00:00Z",
  correspondentId: 11,
  documentTypeId: 21,
  tagIds: [1],
  archiveSerialNumber: undefined,
  originalFileName: undefined,
  mimeType: "application/pdf",
  bytes: RECEIPT_PDF,
  contentType: "application/pdf",
};

/** Tagged only "Privat": excluded by a tag allowlist of "Steuer". */
export const PRIVATE_PHOTO_DOCUMENT: FakePaperlessDocument = {
  id: 103,
  title: "Holiday photo",
  created: "2026-03-06T00:00:00+01:00",
  modified: "2026-03-06T08:00:00Z",
  added: "2026-03-06T08:00:00Z",
  correspondentId: undefined,
  documentTypeId: undefined,
  tagIds: [3],
  archiveSerialNumber: undefined,
  originalFileName: "photo.png",
  mimeType: "image/png",
  bytes: PHOTO_PNG,
  contentType: "image/png",
};

/** Same bytes as {@link INVOICE_DOCUMENT} under a second Paperless id (a re-upload). */
export const DUPLICATE_INVOICE_DOCUMENT: FakePaperlessDocument = {
  ...INVOICE_DOCUMENT,
  id: 104,
  title: "Broadband invoice March (copy)",
  modified: "2026-03-07T10:00:00Z",
  archiveSerialNumber: undefined,
};

/** Declared as PDF but the bytes are HTML: must be refused. */
export const MISLABELLED_DOCUMENT: FakePaperlessDocument = {
  id: 105,
  title: "Not really a PDF",
  created: "2026-03-08T00:00:00+01:00",
  modified: "2026-03-08T10:00:00Z",
  added: "2026-03-08T10:00:00Z",
  correspondentId: undefined,
  documentTypeId: undefined,
  tagIds: [1],
  archiveSerialNumber: undefined,
  originalFileName: "page.pdf",
  mimeType: "application/pdf",
  bytes: text("<html><body>not a pdf</body></html>"),
  contentType: "application/pdf",
};

export const ARCHIVE_FIXTURE: FakePaperlessDocument[] = [
  INVOICE_DOCUMENT,
  RECEIPT_DOCUMENT,
  PRIVATE_PHOTO_DOCUMENT,
];
