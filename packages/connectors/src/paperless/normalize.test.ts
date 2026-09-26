import { describe, expect, it } from "vitest";
import { INVOICE_DOCUMENT, PRIVATE_PHOTO_DOCUMENT, TAGS } from "./fixtures.js";
import {
  compareDocumentOrder,
  isTagAllowed,
  mediaType,
  nameLookup,
  paperlessErrorMessage,
  paperlessPolicyFingerprint,
  recordedStoredDocument,
  resolvePaperlessSourcePolicy,
  tagNames,
} from "./normalize.js";

const tags = nameLookup(TAGS);

describe("resolvePaperlessSourcePolicy", () => {
  it("applies conservative defaults and normalizes tag names", () => {
    const policy = resolvePaperlessSourcePolicy({ requiredTagNames: [" Steuer ", "", "RECHNUNG"] });
    expect([...policy.requiredTagNames]).toEqual(["steuer", "rechnung"]);
    expect(policy.allowedMimeTypes.has("application/pdf")).toBe(true);
    expect(policy.allowedMimeTypes.has("text/html")).toBe(false);
    expect(policy.maxDocumentBytes).toBe(50 * 1024 * 1024);
  });

  it("rejects invalid bounds", () => {
    expect(() => resolvePaperlessSourcePolicy({ initialModifiedSince: "yesterday" })).toThrow(
      /ISO-8601/,
    );
    expect(() => resolvePaperlessSourcePolicy({ maxDocumentBytes: 0 })).toThrow(/positive integer/);
  });

  it("fingerprints only the fields that decide imports", () => {
    const a = paperlessPolicyFingerprint(
      resolvePaperlessSourcePolicy({ requiredTagNames: ["a", "b"] }),
    );
    const b = paperlessPolicyFingerprint(
      resolvePaperlessSourcePolicy({ requiredTagNames: ["B", "a"] }),
    );
    const c = paperlessPolicyFingerprint(resolvePaperlessSourcePolicy({ requiredTagNames: ["a"] }));
    const d = paperlessPolicyFingerprint(
      resolvePaperlessSourcePolicy({
        requiredTagNames: ["a", "b"],
        initialModifiedSince: "2026-01-01T00:00:00Z",
      }),
    );
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toBe(d);
  });
});

describe("tag filtering", () => {
  it("resolves names and keeps unknown ids visible", () => {
    expect(tagNames(INVOICE_DOCUMENT, tags)).toEqual(["Steuer", "Rechnung"]);
    expect(tagNames({ ...INVOICE_DOCUMENT, tagIds: [99] }, tags)).toEqual(["#99"]);
  });

  it("requires at least one required tag, case-insensitively, unless none are required", () => {
    const steuer = resolvePaperlessSourcePolicy({ requiredTagNames: ["STEUER"] });
    expect(isTagAllowed(INVOICE_DOCUMENT, tags, steuer)).toBe(true);
    expect(isTagAllowed(PRIVATE_PHOTO_DOCUMENT, tags, steuer)).toBe(false);
    expect(isTagAllowed(PRIVATE_PHOTO_DOCUMENT, tags, resolvePaperlessSourcePolicy())).toBe(true);
  });
});

describe("compareDocumentOrder", () => {
  it("orders by modified instant, then id, independent of offset rendering", () => {
    const earlier = { modified: "2026-03-01T10:00:00Z", id: 9 };
    const sameInstant = { modified: "2026-03-01T11:00:00+01:00", id: 3 };
    const later = { modified: "2026-03-01T10:00:01Z", id: 1 };
    expect(compareDocumentOrder(earlier, later)).toBeLessThan(0);
    expect(compareDocumentOrder(sameInstant, earlier)).toBeLessThan(0);
    expect(compareDocumentOrder(earlier, earlier)).toBe(0);
  });
});

describe("recordedStoredDocument", () => {
  it("reads a well-formed entry and ignores malformed payloads", () => {
    expect(
      recordedStoredDocument({
        document: { contentHash: "h", byteLength: 3, mimeType: "application/pdf" },
      }),
    ).toEqual({ contentHash: "h", byteLength: 3, mimeType: "application/pdf" });
    expect(recordedStoredDocument({ document: { contentHash: 1 } })).toBeUndefined();
    expect(recordedStoredDocument([])).toBeUndefined();
    expect(recordedStoredDocument(null)).toBeUndefined();
  });
});

describe("mediaType and redaction", () => {
  it("strips parameters and lower-cases", () => {
    expect(mediaType("Application/PDF; charset=binary")).toBe("application/pdf");
    expect(mediaType(null)).toBeUndefined();
    expect(mediaType("  ")).toBeUndefined();
  });

  it("redacts secrets, addresses, and query strings", () => {
    const message = paperlessErrorMessage(
      new Error(
        "GET https://dms.example.net/api/documents/?token=abc failed for user@example.net with tok3n",
      ),
      ["tok3n"],
    );
    expect(message).toBe(
      "GET https://dms.example.net/api/documents/?[redacted] failed for [email] with [redacted]",
    );
  });
});
