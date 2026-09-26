import { describe, expect, it } from "vitest";
import { clearSessionCookie, readCookie, serializeCookie, sessionCookie } from "./cookies.js";

describe("session cookies", () => {
  const expires = new Date("2026-07-10T12:00:00Z");

  it("defaults to HttpOnly, Secure, SameSite=Lax on the root path", () => {
    const header = serializeCookie(sessionCookie("sona_sess_abc", expires));
    expect(header).toBe(
      "sona_session=sona_sess_abc; Path=/; Expires=Fri, 10 Jul 2026 12:00:00 GMT; HttpOnly; Secure; SameSite=Lax",
    );
  });

  it("supports Strict mode, a custom name, and a domain", () => {
    const header = serializeCookie(
      sessionCookie("tok", expires, {
        name: "sid",
        sameSite: "Strict",
        domain: "app.sona.test",
        path: "/app",
      }),
    );
    expect(header).toContain("sid=tok");
    expect(header).toContain("Domain=app.sona.test");
    expect(header).toContain("Path=/app");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Secure");
  });

  it("only drops Secure when explicitly asked (plain-http localhost dev)", () => {
    const header = serializeCookie(sessionCookie("tok", expires, { secure: false }));
    expect(header).not.toContain("Secure");
    expect(header).toContain("HttpOnly");
  });

  it("clears with an empty value, epoch expiry, and Max-Age=0", () => {
    const header = serializeCookie(clearSessionCookie());
    expect(header).toContain("sona_session=;");
    expect(header).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    expect(header).toContain("Max-Age=0");
    expect(header).toContain("HttpOnly");
  });

  it("refuses names or values that could inject attributes", () => {
    expect(() => serializeCookie(sessionCookie("a; Domain=evil", expires))).toThrow(/value/);
    expect(() => serializeCookie(sessionCookie("ok", expires, { name: "bad name" }))).toThrow(
      /name/,
    );
  });

  it("reads a cookie out of a request header", () => {
    expect(readCookie("theme=dark; sona_session=sona_sess_x; other=1", "sona_session")).toBe(
      "sona_sess_x",
    );
    expect(readCookie("theme=dark", "sona_session")).toBeUndefined();
    expect(readCookie(undefined, "sona_session")).toBeUndefined();
  });
});
