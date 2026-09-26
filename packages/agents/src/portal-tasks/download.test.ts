import { describe, expect, it } from "vitest";
import {
  DownloadTooLargeError,
  documentBytesProblem,
  isExpectedMimeType,
  isSuccessfulStatus,
} from "./download.js";

describe("isExpectedMimeType", () => {
  it("compares media types ignoring parameters, case, and whitespace", () => {
    expect(isExpectedMimeType("application/PDF; charset=binary", "application/pdf")).toBe(true);
    expect(isExpectedMimeType("  application/pdf ", "application/pdf")).toBe(true);
  });

  it("rejects different media types and empty content types", () => {
    expect(isExpectedMimeType("text/html", "application/pdf")).toBe(false);
    expect(isExpectedMimeType("", "application/pdf")).toBe(false);
  });
});

describe("isSuccessfulStatus", () => {
  it("treats only 2xx as success", () => {
    expect(isSuccessfulStatus(199)).toBe(false);
    expect(isSuccessfulStatus(200)).toBe(true);
    expect(isSuccessfulStatus(299)).toBe(true);
    expect(isSuccessfulStatus(300)).toBe(false);
  });
});

describe("documentBytesProblem", () => {
  const pdf = new TextEncoder().encode("%PDF-1.7 body");

  it("accepts PDF bytes that start with the PDF signature", () => {
    expect(documentBytesProblem(pdf, "application/pdf; charset=binary")).toBeUndefined();
  });

  it("rejects empty payloads and PDFs without a signature", () => {
    expect(documentBytesProblem(new Uint8Array(0), "application/pdf")).toBe(
      "download payload is empty",
    );
    expect(
      documentBytesProblem(new TextEncoder().encode("<html>expired</html>"), "application/pdf"),
    ).toBe("download payload does not carry a PDF signature");
    expect(documentBytesProblem(new TextEncoder().encode("%PDF"), "application/pdf")).toBe(
      "download payload does not carry a PDF signature",
    );
  });

  it("only requires non-empty bytes for other media types", () => {
    expect(documentBytesProblem(new TextEncoder().encode("id,amount"), "text/csv")).toBeUndefined();
  });
});

describe("DownloadTooLargeError", () => {
  it("carries the cap and a stable name", () => {
    const error = new DownloadTooLargeError(1024);

    expect(error.name).toBe("DownloadTooLargeError");
    expect(error.maxBytes).toBe(1024);
    expect(error.message).toBe("download exceeds 1024 byte limit");
  });
});
