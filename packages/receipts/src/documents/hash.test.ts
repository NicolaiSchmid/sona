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
    { id: "doc_1", workspaceId: "ws_1", contentHash: hashDocumentContent("a") },
    { id: "doc_2", workspaceId: "ws_1", contentHash: hashDocumentContent("b") },
    { id: "doc_3", workspaceId: "ws_2", contentHash: hashDocumentContent("a") },
  ];

  it("finds an existing document by content hash within the workspace", () => {
    expect(findDuplicateByContent("ws_1", hashDocumentContent("b"), existing)).toBe("doc_2");
    expect(isDuplicateContent("ws_1", hashDocumentContent("b"), existing)).toBe(true);
  });

  it("returns undefined for new content", () => {
    expect(findDuplicateByContent("ws_1", hashDocumentContent("c"), existing)).toBeUndefined();
    expect(isDuplicateContent("ws_1", hashDocumentContent("c"), existing)).toBe(false);
  });

  it("does not treat another workspace's identical bytes as a duplicate", () => {
    // "a" exists in ws_1 (doc_1) and ws_2 (doc_3); ws_3 must see it as new.
    expect(findDuplicateByContent("ws_3", hashDocumentContent("a"), existing)).toBeUndefined();
    // Within ws_2 the same bytes are its own doc_3, not ws_1's doc_1.
    expect(findDuplicateByContent("ws_2", hashDocumentContent("a"), existing)).toBe("doc_3");
  });
});
