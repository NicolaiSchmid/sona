import { describe, expect, it } from "vitest";
import { INVOICE_MESSAGE, PHOTO_MESSAGE } from "./fixtures.js";
import {
  DEFAULT_ALLOWED_MIME_TYPES,
  DEFAULT_FOLDER,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  DEFAULT_MIN_IMAGE_BYTES,
  errorMessageRedacted,
  isSenderAllowed,
  messageExternalId,
  normalizeMessageId,
  policyFingerprint,
  rawEmailPayloadJson,
  redactSensitiveText,
  resolveEmailSourcePolicy,
  selectAttachments,
  toRawEmailPayload,
} from "./normalize.js";
import type { EmailAttachmentPart } from "./types.js";

const part = (overrides: Partial<EmailAttachmentPart>): EmailAttachmentPart => ({
  partId: "2",
  filename: "file.pdf",
  mimeType: "application/pdf",
  size: 100_000,
  disposition: "attachment",
  contentId: undefined,
  ...overrides,
});

describe("isSenderAllowed", () => {
  const from = { name: undefined, address: "billing@vendor.example" };

  it("accepts every sender when the allowlist is empty", () => {
    expect(isSenderAllowed(from, [])).toBe(true);
    expect(isSenderAllowed(undefined, [])).toBe(true);
  });

  it("matches exact addresses case-insensitively", () => {
    expect(isSenderAllowed(from, ["Billing@Vendor.Example"])).toBe(true);
    expect(isSenderAllowed(from, ["support@vendor.example"])).toBe(false);
  });

  it("matches domains and sub-domains, with or without a leading @", () => {
    const sub = { name: undefined, address: "kasse@shop.vendor.example" };
    expect(isSenderAllowed(from, ["vendor.example"])).toBe(true);
    expect(isSenderAllowed(sub, ["@vendor.example"])).toBe(true);
    expect(isSenderAllowed(from, ["notvendor.example"])).toBe(false);
    // "vendor.example" must not match "evilvendor.example".
    expect(
      isSenderAllowed({ name: undefined, address: "x@evilvendor.example" }, ["vendor.example"]),
    ).toBe(false);
  });

  it("matches mixed-case addresses against @-prefixed and sub-domain entries", () => {
    const upper = { name: undefined, address: "Kasse@Shop.Vendor.EXAMPLE" };
    expect(isSenderAllowed(upper, ["@vendor.example"])).toBe(true);
    expect(isSenderAllowed(upper, ["@VENDOR.EXAMPLE"])).toBe(true);
    expect(isSenderAllowed(upper, ["@shop.vendor.example"])).toBe(true);
    expect(isSenderAllowed(upper, ["kasse@shop.vendor.example"])).toBe(true);
    // A sub-domain entry never widens to the parent domain, and an exact
    // address entry never matches a different mailbox on the same domain.
    expect(isSenderAllowed(from, ["@shop.vendor.example"])).toBe(false);
    expect(isSenderAllowed(upper, ["billing@vendor.example"])).toBe(false);
  });

  it("rejects messages without a sender when an allowlist is configured", () => {
    expect(isSenderAllowed(undefined, ["vendor.example"])).toBe(false);
  });

  it("ignores blank allowlist entries instead of matching everything", () => {
    expect(isSenderAllowed(from, ["   "])).toBe(false);
    expect(
      resolveEmailSourcePolicy({ allowedSenders: [" ", "Vendor.Example "] }).allowedSenders,
    ).toEqual(["vendor.example"]);
  });
});

describe("resolveEmailSourcePolicy validation", () => {
  it("rejects an unparseable initialSinceDate instead of scanning the whole mailbox", () => {
    expect(() => resolveEmailSourcePolicy({ initialSinceDate: "01.01.2026" })).toThrow(
      /initialSinceDate/,
    );
    expect(resolveEmailSourcePolicy({ initialSinceDate: "2026-01-01" }).initialSinceDate).toBe(
      "2026-01-01",
    );
  });
});

describe("selectAttachments", () => {
  const policy = resolveEmailSourcePolicy();

  it("keeps PDFs and large images, skipping text parts by MIME type", () => {
    const selection = selectAttachments(PHOTO_MESSAGE.attachments, policy);
    expect(selection.selected.map((p) => p.partId)).toEqual(["2"]);
    expect(selection.skipped).toEqual([
      { partId: "1.2", reason: "embedded_image" },
      { partId: "3", reason: "mime_type_not_allowed" },
    ]);
  });

  it("skips small images (signatures) but not small PDFs", () => {
    const small = DEFAULT_MIN_IMAGE_BYTES - 1;
    const selection = selectAttachments(
      [
        part({ partId: "a", mimeType: "image/jpeg", filename: "sig.jpg", size: small }),
        part({ partId: "b", mimeType: "application/pdf", size: 900 }),
        part({ partId: "c", mimeType: "image/jpeg", size: DEFAULT_MIN_IMAGE_BYTES }),
      ],
      policy,
    );
    expect(selection.selected.map((p) => p.partId)).toEqual(["b", "c"]);
    expect(selection.skipped).toEqual([{ partId: "a", reason: "below_size_threshold" }]);
  });

  it("skips oversized attachments and reports the reason", () => {
    const selection = selectAttachments([part({ size: policy.maxAttachmentBytes + 1 })], policy);
    expect(selection.selected).toEqual([]);
    expect(selection.skipped).toEqual([{ partId: "2", reason: "above_size_limit" }]);
  });

  it("passes the size checks when the server does not report a part size", () => {
    const selection = selectAttachments(
      [
        part({ partId: "a", size: undefined }),
        part({ partId: "b", mimeType: "image/jpeg", filename: "photo.jpg", size: undefined }),
        part({
          partId: "c",
          mimeType: "image/png",
          size: undefined,
          disposition: "inline",
          contentId: "logo@vendor.example",
        }),
      ],
      policy,
    );
    expect(selection.selected.map((p) => p.partId)).toEqual(["a", "b"]);
    expect(selection.skipped).toEqual([{ partId: "c", reason: "embedded_image" }]);
  });

  it("applies configured size thresholds, checking the hard cap before the image rules", () => {
    const custom = resolveEmailSourcePolicy({ minImageBytes: 10, maxAttachmentBytes: 1000 });
    const selection = selectAttachments(
      [
        part({ partId: "a", mimeType: "image/jpeg", size: 9 }),
        part({ partId: "b", mimeType: "image/jpeg", size: 10 }),
        part({ partId: "c", size: 1000 }),
        part({ partId: "d", size: 1001 }),
        part({
          partId: "e",
          mimeType: "image/png",
          size: 5000,
          disposition: "inline",
          contentId: "big@vendor.example",
        }),
      ],
      custom,
    );
    expect(selection.selected.map((p) => p.partId)).toEqual(["b", "c"]);
    expect(selection.skipped).toEqual([
      { partId: "a", reason: "below_size_threshold" },
      { partId: "d", reason: "above_size_limit" },
      { partId: "e", reason: "above_size_limit" },
    ]);
  });

  it("keeps inline images that are real attachments (no Content-ID)", () => {
    const selection = selectAttachments(
      [part({ mimeType: "image/png", disposition: "inline", contentId: undefined })],
      policy,
    );
    expect(selection.selected).toHaveLength(1);
  });

  it("honours a custom MIME allowlist case-insensitively", () => {
    const custom = resolveEmailSourcePolicy({ allowedMimeTypes: ["APPLICATION/PDF"] });
    const selection = selectAttachments(
      [part({ mimeType: "Application/PDF" }), part({ partId: "3", mimeType: "image/png" })],
      custom,
    );
    expect(selection.selected.map((p) => p.partId)).toEqual(["2"]);
  });
});

describe("resolveEmailSourcePolicy", () => {
  it("applies conservative defaults when no policy is configured", () => {
    const resolved = resolveEmailSourcePolicy();
    expect(resolved).toEqual({
      folder: "INBOX",
      allowedSenders: [],
      allowedMimeTypes: new Set([
        "application/pdf",
        "image/jpeg",
        "image/png",
        "image/heic",
        "image/tiff",
        "image/webp",
      ]),
      minImageBytes: 32 * 1024,
      maxAttachmentBytes: 25 * 1024 * 1024,
      initialSinceDate: undefined,
    });
    expect(DEFAULT_FOLDER).toBe("INBOX");
    expect([...DEFAULT_ALLOWED_MIME_TYPES]).toEqual([...resolved.allowedMimeTypes]);
    expect(DEFAULT_MIN_IMAGE_BYTES).toBe(resolved.minImageBytes);
    expect(DEFAULT_MAX_ATTACHMENT_BYTES).toBe(resolved.maxAttachmentBytes);
    expect(resolved.allowedMimeTypes.has("text/plain")).toBe(false);
    expect(resolveEmailSourcePolicy(undefined)).toEqual(resolved);
    expect(resolveEmailSourcePolicy({})).toEqual(resolved);
  });

  it("keeps explicit overrides, including zero thresholds and an empty MIME allowlist", () => {
    const resolved = resolveEmailSourcePolicy({
      folder: "Invoices",
      allowedMimeTypes: [],
      minImageBytes: 0,
      maxAttachmentBytes: 1,
      initialSinceDate: "2026-01-01T00:00:00.000Z",
    });
    expect(resolved.folder).toBe("Invoices");
    expect(resolved.allowedMimeTypes.size).toBe(0);
    expect(resolved.minImageBytes).toBe(0);
    expect(resolved.maxAttachmentBytes).toBe(1);
    expect(resolved.initialSinceDate).toBe("2026-01-01T00:00:00.000Z");
    // An empty MIME allowlist selects nothing rather than everything.
    expect(selectAttachments([part({})], resolved).selected).toEqual([]);
  });
});

describe("policyFingerprint", () => {
  const baseline = policyFingerprint(
    resolveEmailSourcePolicy({
      allowedSenders: ["vendor.example", "billing@other.test"],
      allowedMimeTypes: ["application/pdf", "image/jpeg"],
    }),
  );

  it("is stable and insensitive to allowlist order and casing", () => {
    expect(baseline).toMatch(/^[0-9a-f]{64}$/);
    expect(
      policyFingerprint(
        resolveEmailSourcePolicy({
          allowedSenders: [" Billing@Other.Test ", "VENDOR.example"],
          allowedMimeTypes: ["IMAGE/JPEG", "application/pdf"],
        }),
      ),
    ).toBe(baseline);
  });

  it("ignores the folder and initialSinceDate, which are not ingestion rules", () => {
    expect(
      policyFingerprint(
        resolveEmailSourcePolicy({
          folder: "Invoices",
          initialSinceDate: "2026-01-01T00:00:00.000Z",
          allowedSenders: ["vendor.example", "billing@other.test"],
          allowedMimeTypes: ["application/pdf", "image/jpeg"],
        }),
      ),
    ).toBe(baseline);
  });

  it("changes when any ingestion rule changes", () => {
    const variants = [
      { allowedSenders: ["vendor.example"] },
      { allowedSenders: [] },
      { allowedMimeTypes: ["application/pdf"] },
      { minImageBytes: DEFAULT_MIN_IMAGE_BYTES + 1 },
      { maxAttachmentBytes: DEFAULT_MAX_ATTACHMENT_BYTES - 1 },
    ].map((override) =>
      policyFingerprint(
        resolveEmailSourcePolicy({
          allowedSenders: ["vendor.example", "billing@other.test"],
          allowedMimeTypes: ["application/pdf", "image/jpeg"],
          ...override,
        }),
      ),
    );
    for (const variant of variants) {
      expect(variant).not.toBe(baseline);
    }
    expect(new Set(variants).size).toBe(variants.length);
    // Defaults hash the same whether spelled out or omitted.
    expect(policyFingerprint(resolveEmailSourcePolicy())).toBe(
      policyFingerprint(
        resolveEmailSourcePolicy({
          allowedMimeTypes: [...DEFAULT_ALLOWED_MIME_TYPES],
          minImageBytes: DEFAULT_MIN_IMAGE_BYTES,
          maxAttachmentBytes: DEFAULT_MAX_ATTACHMENT_BYTES,
        }),
      ),
    );
  });
});

describe("message identity", () => {
  it("prefers the Message-ID without angle brackets", () => {
    expect(messageExternalId(INVOICE_MESSAGE)).toBe(
      "msgid:invoice-2026-0042@billing.vendor.example",
    );
    expect(normalizeMessageId(" <a@b> ")).toBe("a@b");
    expect(normalizeMessageId("<>")).toBeUndefined();
  });

  it("falls back to a folder + UIDVALIDITY + UID identity", () => {
    expect(messageExternalId({ ...INVOICE_MESSAGE, messageId: undefined })).toBe(
      "uid:INBOX:1710000000:101",
    );
  });
});

describe("toRawEmailPayload", () => {
  it("records redacted metadata only: no body, no recipients, no bytes", () => {
    const payload = toRawEmailPayload(INVOICE_MESSAGE, [
      {
        partId: "2",
        filename: "Rechnung-2026-0042.pdf",
        mimeType: "application/pdf",
        byteLength: 42,
        contentHash: "abc",
      },
    ]);
    expect(payload).toEqual({
      kind: "email_message",
      folder: "INBOX",
      uid: 101,
      uidValidity: "1710000000",
      messageId: "invoice-2026-0042@billing.vendor.example",
      subject: "Ihre Rechnung 2026-0042",
      date: "2026-01-15T09:30:00.000Z",
      fromAddress: "billing@vendor.example",
      fromName: "Vendor Billing",
      attachments: [
        {
          partId: "2",
          filename: "Rechnung-2026-0042.pdf",
          mimeType: "application/pdf",
          byteLength: 42,
          contentHash: "abc",
        },
      ],
    });
    const keys = Object.keys(payload);
    for (const forbidden of ["to", "cc", "bcc", "body", "text", "html", "headers", "bytes"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("drops undefined fields when converted to JSON", () => {
    const json = rawEmailPayloadJson(
      toRawEmailPayload({ ...INVOICE_MESSAGE, subject: undefined, from: undefined }, []),
    );
    expect(json).not.toHaveProperty("subject");
    expect(json).not.toHaveProperty("fromAddress");
  });
});

describe("redaction", () => {
  it("removes email addresses and supplied secrets from free text", () => {
    const text = "LOGIN failed for billing@vendor.example using pw hunter2-synthetic";
    expect(redactSensitiveText(text, ["hunter2-synthetic"])).toBe(
      "LOGIN failed for [email] using pw [redacted]",
    );
  });

  it("redacts every occurrence of several secrets, including secrets shaped like addresses", () => {
    const username = "mailbox-user@mailbox.test";
    const text = `LOGIN ${username} tok-1 retry tok-1 then tok-2; cc <other@mailbox.test>`;
    expect(redactSensitiveText(text, [username, "tok-1", "tok-2"])).toBe(
      "LOGIN [redacted] [redacted] retry [redacted] then [redacted]; cc <[email]>",
    );
    // Already-redacted placeholders are stable under a second pass.
    expect(redactSensitiveText("[redacted] [email]", ["x"])).toBe("[redacted] [email]");
  });

  it("handles non-Error throwables and empty secrets", () => {
    expect(errorMessageRedacted("plain <x@y.test>", [""])).toBe("plain <[email]>");
    expect(errorMessageRedacted(new Error("boom"))).toBe("boom");
  });
});
