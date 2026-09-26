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

  it("tolerates irregular whitespace and matches the cookie name exactly", () => {
    expect(readCookie("  sona_session =  sona_sess_x  ;theme=dark", "sona_session")).toBe(
      "sona_sess_x",
    );
    expect(readCookie("sona_session=sona_sess_x", "sona_session")).toBe("sona_sess_x");
    // Prefix, suffix, and case variants are different cookies.
    expect(readCookie("sona_session2=x; xsona_session=y", "sona_session")).toBeUndefined();
    expect(readCookie("SONA_SESSION=x", "sona_session")).toBeUndefined();
    // Empty and malformed pairs are skipped rather than matched.
    expect(readCookie("; ; sona_session; other=1", "sona_session")).toBeUndefined();
    expect(readCookie("", "sona_session")).toBeUndefined();
  });

  it("returns the first value when a name repeats and keeps '=' inside values", () => {
    expect(readCookie("sona_session=first; sona_session=second", "sona_session")).toBe("first");
    expect(readCookie("sona_session=a=b=c", "sona_session")).toBe("a=b=c");
    expect(readCookie("sona_session=", "sona_session")).toBe("");
    // Quoted values are returned verbatim; the prefix check downstream rejects them.
    expect(readCookie('sona_session="sona_sess_x"', "sona_session")).toBe('"sona_sess_x"');
  });

  it("serializes Max-Age without Expires when only a lifetime is given", () => {
    const header = serializeCookie({
      ...sessionCookie("tok", expires),
      expires: undefined,
      maxAge: 3600,
    });
    expect(header).toBe("sona_session=tok; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax");
    expect(header).not.toContain("Expires=");
  });

  it("rejects the separator and whitespace characters cookies cannot carry", () => {
    for (const value of ["a b", 'say"hi"', "a,b", "back\\slash", "tab\there"]) {
      expect(() => serializeCookie(sessionCookie(value, expires))).toThrow(/value/);
    }
    // The empty value used for clearing is fine; so is the full base64url alphabet.
    expect(() => serializeCookie(sessionCookie("", expires))).not.toThrow();
    expect(() =>
      serializeCookie(sessionCookie("sona_sess_AZaz09-_~!#$%&'()*+./:<>?@[]^`{|}", expires)),
    ).not.toThrow();
    for (const name of ["sid;x", "sid=x", "sid,x", "(sid)", ""]) {
      expect(() => serializeCookie(sessionCookie("v", expires, { name }))).toThrow(/name/);
    }
  });

  it("keeps the clearing cookie's name, path, and domain aligned with the live cookie", () => {
    const options = { name: "sid", path: "/app", domain: "app.sona.test", secure: false };
    const live = serializeCookie(sessionCookie("tok", expires, options));
    const clear = serializeCookie(clearSessionCookie(options));
    expect(clear.startsWith("sid=;")).toBe(true);
    expect(clear).toContain("Path=/app");
    expect(clear).toContain("Domain=app.sona.test");
    expect(clear).not.toContain("Secure");
    expect(live).not.toContain("Max-Age");
  });

  it("rejects paths and domains that would inject attributes or split the header", () => {
    for (const path of ["", "app", "/app; Domain=evil", "/app\r\nSet-Cookie: x=y", "/a;b"]) {
      expect(() => serializeCookie(sessionCookie("v", expires, { path }))).toThrow(/path/);
    }
    for (const domain of [
      "evil; Path=/",
      "app.sona.test:443",
      "https://app.sona.test",
      "-bad.example",
      "a b",
      "",
    ]) {
      expect(() => serializeCookie(sessionCookie("v", expires, { domain }))).toThrow(/domain/);
    }
    expect(() =>
      serializeCookie(sessionCookie("v", expires, { path: "/app/v1?x=1", domain: ".sona.test" })),
    ).not.toThrow();
    expect(() =>
      serializeCookie(sessionCookie("v", expires, { domain: "app-1.sona.test" })),
    ).not.toThrow();
  });
});
