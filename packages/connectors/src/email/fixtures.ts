/**
 * Synthetic mailbox fixtures for tests. Addresses use reserved `.test`/`.example`
 * domains and the attachment bytes are obviously fake — no real invoices,
 * senders, or credentials.
 */
import type { FakeFolder, FakeMessage } from "./fake-imap-client.js";
import type { EmailAttachmentPart } from "./types.js";

const encoder = new TextEncoder();

export function syntheticPdf(label: string): Uint8Array {
  return encoder.encode(`%PDF-1.4\n% synthetic sona test document: ${label}\n%%EOF\n`);
}

const IMAGE_SIGNATURES = {
  jpeg: [0xff, 0xd8, 0xff, 0xe0],
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
} as const;

/** Fake image bytes with a real signature, padded to `byteLength` so size thresholds can be tested. */
export function syntheticImage(
  label: string,
  byteLength: number,
  kind: keyof typeof IMAGE_SIGNATURES,
): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  const signature = IMAGE_SIGNATURES[kind];
  bytes.set(signature);
  bytes.set(
    encoder.encode(` synthetic ${label}`).subarray(0, byteLength - signature.length),
    signature.length,
  );
  return bytes;
}

export const INVOICE_PDF = syntheticPdf("invoice 2026-0042");
export const SECOND_INVOICE_PDF = syntheticPdf("invoice 2026-0043");
export const RECEIPT_PHOTO = syntheticImage("receipt photo", 64 * 1024, "jpeg");
export const SIGNATURE_LOGO = syntheticImage("signature logo", 4 * 1024, "png");

const pdfPart = (partId: string, filename: string, size: number): EmailAttachmentPart => ({
  partId,
  filename,
  mimeType: "application/pdf",
  size,
  disposition: "attachment",
  contentId: undefined,
});

export const UID_VALIDITY = "1710000000";

/** Vendor invoice with one PDF attachment: the happy path. */
export const INVOICE_MESSAGE: FakeMessage = {
  folder: "INBOX",
  uid: 101,
  uidValidity: UID_VALIDITY,
  messageId: "<invoice-2026-0042@billing.vendor.example>",
  subject: "Ihre Rechnung 2026-0042",
  date: "2026-01-15T09:30:00.000Z",
  internalDate: "2026-01-15T09:31:02.000Z",
  from: { name: "Vendor Billing", address: "billing@vendor.example" },
  attachments: [pdfPart("2", "Rechnung-2026-0042.pdf", INVOICE_PDF.byteLength)],
  parts: { "2": INVOICE_PDF },
};

/** Newsletter from a non-allowlisted sender that also carries a PDF. */
export const NEWSLETTER_MESSAGE: FakeMessage = {
  folder: "INBOX",
  uid: 102,
  uidValidity: UID_VALIDITY,
  messageId: "<newsletter-77@promo.other.test>",
  subject: "Weekly deals",
  date: "2026-01-16T06:00:00.000Z",
  internalDate: "2026-01-16T06:00:10.000Z",
  from: { name: "Promo", address: "news@promo.other.test" },
  attachments: [pdfPart("2", "catalog.pdf", 900)],
  parts: { "2": syntheticPdf("catalog") },
};

/**
 * Message with an embedded signature logo (skipped), a large receipt photo
 * (stored), and a plain-text part (not an attachment candidate).
 */
export const PHOTO_MESSAGE: FakeMessage = {
  folder: "INBOX",
  uid: 103,
  uidValidity: UID_VALIDITY,
  messageId: "<photo-1@shop.vendor.example>",
  subject: "Quittung",
  date: "2026-01-17T12:00:00.000Z",
  internalDate: "2026-01-17T12:00:05.000Z",
  from: { name: undefined, address: "kasse@shop.vendor.example" },
  attachments: [
    {
      partId: "1.2",
      filename: "logo.png",
      mimeType: "image/png",
      size: SIGNATURE_LOGO.byteLength,
      disposition: "inline",
      contentId: "logo@shop.vendor.example",
    },
    {
      partId: "2",
      filename: "IMG_0042.jpeg",
      mimeType: "image/jpeg",
      size: RECEIPT_PHOTO.byteLength,
      disposition: "attachment",
      contentId: undefined,
    },
    {
      partId: "3",
      filename: "terms.txt",
      mimeType: "text/plain",
      size: 200,
      disposition: "attachment",
      contentId: undefined,
    },
  ],
  parts: { "1.2": SIGNATURE_LOGO, "2": RECEIPT_PHOTO, "3": encoder.encode("terms") },
};

/** The same invoice PDF forwarded again: new Message-ID, identical bytes. */
export const FORWARDED_INVOICE_MESSAGE: FakeMessage = {
  folder: "INBOX",
  uid: 104,
  uidValidity: UID_VALIDITY,
  messageId: "<fwd-1@vendor.example>",
  subject: "Fwd: Ihre Rechnung 2026-0042",
  date: "2026-01-18T08:00:00.000Z",
  internalDate: "2026-01-18T08:00:01.000Z",
  from: { name: "Vendor Support", address: "support@vendor.example" },
  attachments: [pdfPart("2", "Rechnung-2026-0042.pdf", INVOICE_PDF.byteLength)],
  parts: { "2": INVOICE_PDF },
};

/** A message without a Message-ID header (some scanners/printers omit it). */
export const NO_MESSAGE_ID_MESSAGE: FakeMessage = {
  folder: "INBOX",
  uid: 105,
  uidValidity: UID_VALIDITY,
  messageId: undefined,
  subject: "Scan",
  date: undefined,
  internalDate: "2026-01-19T08:00:01.000Z",
  from: { name: undefined, address: "scanner@vendor.example" },
  attachments: [pdfPart("2", "scan.pdf", SECOND_INVOICE_PDF.byteLength)],
  parts: { "2": SECOND_INVOICE_PDF },
};

export const INBOX_FIXTURE: FakeFolder = {
  uidValidity: UID_VALIDITY,
  specialUse: "\\Inbox",
  messages: [
    INVOICE_MESSAGE,
    NEWSLETTER_MESSAGE,
    PHOTO_MESSAGE,
    FORWARDED_INVOICE_MESSAGE,
    NO_MESSAGE_ID_MESSAGE,
  ],
};

export const VENDOR_ALLOWLIST = ["vendor.example"] as const;
