import { describe, expect, it } from "vitest";
import { resolveUrl, sanitizeUrl } from "./url.js";

describe("sanitizeUrl", () => {
  it("strips the query string and fragment but keeps a non-default port", () => {
    expect(sanitizeUrl("https://portal.test:8443/a/b?session=abc#frag")).toBe(
      "https://portal.test:8443/a/b",
    );
  });

  it("drops embedded userinfo so credentials never reach provenance", () => {
    expect(sanitizeUrl("https://user:pw@portal.test/invoices")).toBe(
      "https://portal.test/invoices",
    );
  });

  it("normalizes the host and default port", () => {
    expect(sanitizeUrl("HTTPS://Portal.TEST:443/Invoices")).toBe("https://portal.test/Invoices");
    expect(sanitizeUrl("https://portal.test")).toBe("https://portal.test/");
  });

  it("returns undefined for input that is not a URL", () => {
    expect(sanitizeUrl("not a url")).toBeUndefined();
    expect(sanitizeUrl("")).toBeUndefined();
    expect(sanitizeUrl("/relative/path?x=1")).toBeUndefined();
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
