import { describe, expect, it } from "vitest";
import { PortalSecretRedactor } from "./redaction.js";

describe("PortalSecretRedactor", () => {
  it("redacts longer secrets before shorter overlapping ones", () => {
    const redactor = new PortalSecretRedactor();
    redactor.addSecret("abc");
    redactor.addSecret("abc123");

    expect(redactor.redactText("login abc123 and abc")).toBe(
      "login [REDACTED_SECRET] and [REDACTED_SECRET]",
    );
  });

  it("ignores empty secrets and redacts metadata keys and values", () => {
    const redactor = new PortalSecretRedactor();
    redactor.addSecret("");
    redactor.addSecret("hunter2");

    expect(redactor.redactText("hunter2")).toBe("[REDACTED_SECRET]");
    expect(redactor.metadata({ "user-hunter2": "pw hunter2" })).toEqual({
      "user-[REDACTED_SECRET]": "pw [REDACTED_SECRET]",
    });
  });

  it("adding the same secret twice does not double-redact or duplicate markers", () => {
    const redactor = new PortalSecretRedactor();
    redactor.addSecret("hunter2");
    redactor.addSecret("hunter2");

    expect(redactor.redactText("hunter2 hunter2")).toBe("[REDACTED_SECRET] [REDACTED_SECRET]");
  });

  it("makes a single pass per secret even when a secret is a substring of the marker", () => {
    const redactor = new PortalSecretRedactor();
    redactor.addSecret("SECRET");
    redactor.addSecret("REDACTED_SECRET");

    // Longest-first ordering means the marker written by the shorter secret is
    // never re-scanned, so the output is finite and the marker stays intact.
    expect(redactor.redactText("pw SECRET")).toBe("pw [REDACTED_SECRET]");
  });

  it("never re-exposes a longer secret when a shorter one rewrites its marker", () => {
    const redactor = new PortalSecretRedactor();
    redactor.addSecret("hunter2");
    redactor.addSecret("SECRET");

    const output = redactor.redactText("pw hunter2");

    expect(output).not.toContain("hunter2");
    expect(output.startsWith("pw [REDACTED_")).toBe(true);
  });

  it("treats regex metacharacters in secrets literally", () => {
    const redactor = new PortalSecretRedactor();
    const secret = "p+ss(w0rd)*[1].$^|?";
    redactor.addSecret(secret);

    expect(redactor.redactText(`login ${secret} ok`)).toBe("login [REDACTED_SECRET] ok");
    expect(redactor.redactText("p ss w0rd 1")).toBe("p ss w0rd 1");
  });

  it("redacts secrets embedded in URLs and repeated across a text", () => {
    const redactor = new PortalSecretRedactor();
    redactor.addSecret("tok_abc");

    expect(
      redactor.redactText("GET https://portal.test/dl?token=tok_abc failed; retry tok_abc"),
    ).toBe("GET https://portal.test/dl?token=[REDACTED_SECRET] failed; retry [REDACTED_SECRET]");
  });

  it("returns frozen metadata and leaves the input object untouched", () => {
    const redactor = new PortalSecretRedactor();
    redactor.addSecret("hunter2");
    const input = { "portal.filename": "invoice-hunter2.pdf", hunter2: "value" };

    const output = redactor.metadata(input);

    expect(output).toEqual({
      "portal.filename": "invoice-[REDACTED_SECRET].pdf",
      "[REDACTED_SECRET]": "value",
    });
    expect(Object.isFrozen(output)).toBe(true);
    expect(input).toEqual({ "portal.filename": "invoice-hunter2.pdf", hunter2: "value" });
  });

  it("collapses metadata keys that become identical after redaction", () => {
    const redactor = new PortalSecretRedactor();
    redactor.addSecret("alpha");
    redactor.addSecret("bravo");

    const output = redactor.metadata({ alpha: "1", bravo: "2" });

    expect(Object.keys(output)).toEqual(["[REDACTED_SECRET]"]);
    expect(JSON.stringify(output)).not.toMatch(/alpha|bravo/);
  });
});
