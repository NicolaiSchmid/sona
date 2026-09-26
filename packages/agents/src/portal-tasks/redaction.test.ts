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
});
