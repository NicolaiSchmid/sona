import { describe, expect, it } from "vitest";
import { decodedPathAndQuery, redactUrl, redactUrlsInText, resolveUrl } from "./url.js";

describe("redactUrl", () => {
  it("strips the query string and fragment but keeps a non-default port", () => {
    expect(redactUrl("https://portal.test:8443/a/b?session=abc#frag")).toBe(
      "https://portal.test:8443/a/b",
    );
  });

  it("drops embedded userinfo so credentials never reach provenance", () => {
    expect(redactUrl("https://user:pw@portal.test/invoices")).toBe("https://portal.test/invoices");
  });

  it("normalizes the host and default port", () => {
    expect(redactUrl("HTTPS://Portal.TEST:443/Invoices")).toBe("https://portal.test/Invoices");
    expect(redactUrl("https://portal.test")).toBe("https://portal.test/");
  });

  it("returns undefined for input that is not a URL", () => {
    expect(redactUrl("not a url")).toBeUndefined();
    expect(redactUrl("")).toBeUndefined();
    expect(redactUrl("/relative/path?x=1")).toBeUndefined();
  });
});

describe("resolveUrl", () => {
  it("resolves relative hrefs against the current page URL", () => {
    expect(resolveUrl("2026-01.pdf", "https://portal.test/invoices/")).toBe(
      "https://portal.test/invoices/2026-01.pdf",
    );
    expect(resolveUrl("../files/2026-01.pdf", "https://portal.test/invoices/2026/")).toBe(
      "https://portal.test/invoices/files/2026-01.pdf",
    );
    expect(resolveUrl("/download?id=1", "https://portal.test/invoices/list")).toBe(
      "https://portal.test/download?id=1",
    );
  });

  it("keeps absolute hrefs and inherits the scheme for protocol-relative ones", () => {
    expect(resolveUrl("https://cdn.portal.test/x.pdf", "https://portal.test/")).toBe(
      "https://cdn.portal.test/x.pdf",
    );
    expect(resolveUrl("//evil.test/x.pdf", "https://portal.test/")).toBe("https://evil.test/x.pdf");
  });

  it("passes through non-http schemes so the network guard sees and blocks them", () => {
    expect(resolveUrl("javascript:alert(1)", "https://portal.test/")).toBe("javascript:alert(1)");
    expect(resolveUrl("mailto:billing@portal.test", "https://portal.test/")).toBe(
      "mailto:billing@portal.test",
    );
  });

  it("throws on an unparseable base URL", () => {
    expect(() => resolveUrl("x.pdf", "not a url")).toThrow();
  });
});

describe("redactUrlsInText", () => {
  it("strips query strings and fragments from every URL in a message", () => {
    expect(
      redactUrlsInText(
        "page.goto: net::ERR_FAILED at https://portal.test/login?session=abc#top (ws://localhost:3000/live?t=1)",
      ),
    ).toBe("page.goto: net::ERR_FAILED at https://portal.test/login (ws://localhost:3000/live)");
  });

  it("leaves text without URLs untouched", () => {
    expect(redactUrlsInText("Timeout 15000ms exceeded")).toBe("Timeout 15000ms exceeded");
  });
});

describe("redactUrl path segments", () => {
  it("replaces e-mail-like, long token, and long numeric segments", () => {
    expect(
      redactUrl(
        "https://portal.test/u/user%40example.test/acct/12345678/dl/AbCdEfGhIjKlMnOpQrStUvWxYz0123/inv.pdf?sig=x",
      ),
    ).toBe(
      "https://portal.test/u/[REDACTED_SEGMENT]/acct/[REDACTED_SEGMENT]/dl/[REDACTED_SEGMENT]/inv.pdf",
    );
  });

  it("keeps short human-readable segments and file names with few digits", () => {
    expect(redactUrl("https://portal.test/invoices/2026/INV-26-123.pdf")).toBe(
      "https://portal.test/invoices/2026/INV-26-123.pdf",
    );
    expect(redactUrl("https://portal.test/rechnung-januar-2026.pdf")).toBe(
      "https://portal.test/rechnung-januar-2026.pdf",
    );
  });

  it("redacts IBAN-like, order-number-like, and JWT-like segments", () => {
    expect(
      redactUrl(
        "https://portal.test/acct/DE89370400440532013000/orders/302-1234567-1234567/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c/x.pdf",
      ),
    ).toBe(
      "https://portal.test/acct/[REDACTED_SEGMENT]/orders/[REDACTED_SEGMENT]/[REDACTED_SEGMENT]/x.pdf",
    );
  });
});

describe("decodedPathAndQuery", () => {
  it("decodes percent escapes in path and query and drops the fragment", () => {
    expect(decodedPathAndQuery("https://portal.test/a%2Fb/%64elete?op=%63ancel#x")).toBe(
      "/a/b/delete?op=cancel",
    );
  });

  it("returns malformed input decoded as far as possible", () => {
    expect(decodedPathAndQuery("not a url %41")).toBe("not a url A");
  });

  it("returns undefined for input that is not a URL", () => {
    expect(redactUrl("not a url")).toBeUndefined();
  });
});

describe("redactUrl thresholds", () => {
  it("keeps a segment with seven digits and redacts one with eight, even when interleaved", () => {
    expect(redactUrl("https://portal.test/inv-1234567.pdf")).toBe(
      "https://portal.test/inv-1234567.pdf",
    );
    expect(redactUrl("https://portal.test/inv-12345678.pdf")).toBe(
      "https://portal.test/[REDACTED_SEGMENT]",
    );
    expect(redactUrl("https://portal.test/a1b2c3d4e5f6g7h8")).toBe(
      "https://portal.test/[REDACTED_SEGMENT]",
    );
  });

  it("keeps a 19-character token-shaped segment and redacts one of 20", () => {
    expect(redactUrl("https://portal.test/abcdefghijklmnopqrs")).toBe(
      "https://portal.test/abcdefghijklmnopqrs",
    );
    expect(redactUrl("https://portal.test/abcdefghijklmnopqrst")).toBe(
      "https://portal.test/[REDACTED_SEGMENT]",
    );
  });

  it("keeps a long segment that carries a file extension", () => {
    expect(redactUrl("https://portal.test/rechnung-februar-zwanzigsechsundzwanzig.pdf")).toBe(
      "https://portal.test/rechnung-februar-zwanzigsechsundzwanzig.pdf",
    );
  });

  it("redacts e-mail-like segments whether the @ is raw or percent-encoded", () => {
    expect(redactUrl("https://portal.test/u/a@b.test/x")).toBe(
      "https://portal.test/u/[REDACTED_SEGMENT]/x",
    );
    expect(redactUrl("https://portal.test/u/a%40b.test/x")).toBe(
      "https://portal.test/u/[REDACTED_SEGMENT]/x",
    );
  });
});

describe("redactUrlsInText with several URLs", () => {
  it("redacts each URL independently and keeps punctuation that follows a query-less URL", () => {
    expect(redactUrlsInText("see https://a.test/x, then https://b.test/y.")).toBe(
      "see https://a.test/x, then https://b.test/y.",
    );
  });

  it("drops the query of every URL, taking trailing punctuation that was glued to it", () => {
    const redacted = redactUrlsInText("failed: https://a.test/x?s=1, retry https://b.test/y?t=2.");

    expect(redacted).toBe("failed: https://a.test/x retry https://b.test/y");
    expect(redacted).not.toContain("s=1");
    expect(redacted).not.toContain("t=2");
  });
});
