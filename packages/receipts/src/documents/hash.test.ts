import { describe, expect, it } from "vitest";
import { findDuplicateByContent, hashDocumentContent, isDuplicateContent } from "./hash.js";

describe("hashDocumentContent", () => {
  it("hashes identical bytes to the same hash and differs for different bytes", () => {
    expect(hashDocumentContent("invoice-a")).toBe(hashDocumentContent("invoice-a"));
    expect(hashDocumentContent("invoice-a")).not.toBe(hashDocumentContent("invoice-b"));
  });

  it("hashes strings and equivalent byte buffers identically", () => {
    expect(hashDocumentContent("héllo")).toBe(
      hashDocumentContent(new TextEncoder().encode("héllo")),
    );
  });
});

describe("deduplication", () => {
  const existing = [
    { id: "doc_1", contentHash: hashDocumentContent("a") },
    { id: "doc_2", contentHash: hashDocumentContent("b") },
  ];

  it("finds an existing document by content hash", () => {
    expect(findDuplicateByContent(hashDocumentContent("b"), existing)).toBe("doc_2");
    expect(isDuplicateContent(hashDocumentContent("b"), existing)).toBe(true);
  });

  it("returns undefined for new content", () => {
    expect(findDuplicateByContent(hashDocumentContent("c"), existing)).toBeUndefined();
    expect(isDuplicateContent(hashDocumentContent("c"), existing)).toBe(false);
  });
});
