import { describe, expect, it } from "vitest";
import { EVIDENCE_LINK_KINDS, evidenceLinkSchema, isEvidenceLinkKind } from "./types";

const baseLink = {
  id: "el_1",
  workspaceId: "ws_1",
  fromType: "receipt_document",
  fromId: "doc_1",
  toType: "ledger_transaction",
  toId: "tx_1",
  kind: "substantiates" as const,
  createdAt: "2026-01-01T00:00:00Z",
};

describe("evidence link kinds", () => {
  it("recognizes the allowed kinds", () => {
    for (const kind of EVIDENCE_LINK_KINDS) {
      expect(isEvidenceLinkKind(kind)).toBe(true);
    }
    expect(isEvidenceLinkKind("approved")).toBe(false);
  });

  it("accepts a well-formed link", () => {
    const parsed = evidenceLinkSchema.parse(baseLink);
    expect(parsed.kind).toBe("substantiates");
  });

  it("rejects an unknown kind", () => {
    const result = evidenceLinkSchema.safeParse({ ...baseLink, kind: "made_up" });
    expect(result.success).toBe(false);
  });

  it("rejects missing endpoints", () => {
    const result = evidenceLinkSchema.safeParse({ ...baseLink, fromId: "" });
    expect(result.success).toBe(false);
  });
});
