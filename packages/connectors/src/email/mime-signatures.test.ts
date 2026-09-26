import { describe, expect, it } from "vitest";
import { INVOICE_PDF, RECEIPT_PHOTO, SIGNATURE_LOGO } from "./fixtures.js";
import { matchesDeclaredMimeType } from "./mime-signatures.js";

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("matchesDeclaredMimeType", () => {
  it("accepts fixtures under their declared types", () => {
    expect(matchesDeclaredMimeType(INVOICE_PDF, "application/pdf")).toBe(true);
    expect(matchesDeclaredMimeType(RECEIPT_PHOTO, "image/jpeg")).toBe(true);
    expect(matchesDeclaredMimeType(SIGNATURE_LOGO, "image/png")).toBe(true);
  });

  it("rejects bytes that do not carry the declared signature", () => {
    expect(matchesDeclaredMimeType(text("<html>not a pdf</html>"), "application/pdf")).toBe(false);
    expect(matchesDeclaredMimeType(INVOICE_PDF, "image/jpeg")).toBe(false);
    expect(matchesDeclaredMimeType(RECEIPT_PHOTO, "image/png")).toBe(false);
    expect(matchesDeclaredMimeType(new Uint8Array(0), "application/pdf")).toBe(false);
  });

  it("tolerates junk before the PDF header within the allowed window", () => {
    const padded = new Uint8Array(1024 + INVOICE_PDF.byteLength);
    padded.set(INVOICE_PDF, 1024);
    expect(matchesDeclaredMimeType(padded, "application/pdf")).toBe(true);
    const tooFar = new Uint8Array(2048 + INVOICE_PDF.byteLength);
    tooFar.set(INVOICE_PDF, 2048);
    expect(matchesDeclaredMimeType(tooFar, "application/pdf")).toBe(false);
  });

  it("knows TIFF, WebP, and HEIC containers", () => {
    expect(matchesDeclaredMimeType(bytes(0x49, 0x49, 0x2a, 0x00, 1), "image/tiff")).toBe(true);
    expect(matchesDeclaredMimeType(bytes(0x4d, 0x4d, 0x00, 0x2a, 1), "image/tiff")).toBe(true);
    expect(matchesDeclaredMimeType(text("RIFF\0\0\0\0WEBPVP8 "), "image/webp")).toBe(true);
    expect(matchesDeclaredMimeType(text("RIFF\0\0\0\0WAVEfmt "), "image/webp")).toBe(false);
    expect(matchesDeclaredMimeType(text("\0\0\0\x18ftypheic"), "image/heic")).toBe(true);
    expect(matchesDeclaredMimeType(text("\0\0\0\x18moovheic"), "image/heic")).toBe(false);
  });

  it("treats image/heif like HEIC and rejects inputs shorter than the signature", () => {
    expect(matchesDeclaredMimeType(text("\0\0\0\x18ftypmif1"), "image/heif")).toBe(true);
    expect(matchesDeclaredMimeType(text("\0\0\0\x18moovmif1"), "image/heif")).toBe(false);
    // Any ISO-BMFF file has `ftyp`; MP4/MOV brands must not pass as HEIC.
    expect(matchesDeclaredMimeType(text("\0\0\0\x18ftypisom"), "image/heic")).toBe(false);
    expect(matchesDeclaredMimeType(text("\0\0\0\x18ftypqt  "), "image/heic")).toBe(false);
    expect(matchesDeclaredMimeType(text("\0\0\0"), "image/heic")).toBe(false);
    expect(matchesDeclaredMimeType(bytes(0x49, 0x49), "image/tiff")).toBe(false);
    expect(matchesDeclaredMimeType(bytes(0x89, 0x50, 0x4e), "image/png")).toBe(false);
    expect(matchesDeclaredMimeType(text("RIFF"), "image/webp")).toBe(false);
    expect(matchesDeclaredMimeType(new Uint8Array(0), "image/jpeg")).toBe(false);
  });

  it("is case-insensitive on the declared type and permissive for unknown types", () => {
    expect(matchesDeclaredMimeType(INVOICE_PDF, "Application/PDF")).toBe(true);
    expect(matchesDeclaredMimeType(text("anything"), "application/x-custom")).toBe(true);
  });
});
