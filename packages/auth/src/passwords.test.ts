import { describe, expect, it } from "vitest";
import {
  checkPasswordPolicy,
  DEFAULT_SCRYPT_PARAMS,
  hashPassword,
  passwordHashNeedsRehash,
  type ScryptParams,
  verifyPassword,
} from "./passwords.js";

const FAST: ScryptParams = { logN: 10, blockSize: 8, parallelization: 1 };

describe("password hashing", () => {
  it("produces a PHC-style scrypt string with a fresh salt per call", async () => {
    const first = await hashPassword("correct horse battery staple 42", FAST);
    const second = await hashPassword("correct horse battery staple 42", FAST);
    expect(first).toMatch(/^\$scrypt\$ln=10,r=8,p=1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(first).not.toEqual(second);
    expect(first).not.toContain("correct horse");
  });

  it("verifies the right password and rejects the wrong one", async () => {
    const hash = await hashPassword("a strong and long password", FAST);
    await expect(verifyPassword("a strong and long password", hash)).resolves.toBe(true);
    await expect(verifyPassword("a strong and long passworD", hash)).resolves.toBe(false);
    await expect(verifyPassword("", hash)).resolves.toBe(false);
  });

  it("treats malformed or foreign hashes as non-matching instead of throwing", async () => {
    await expect(verifyPassword("anything", "")).resolves.toBe(false);
    await expect(verifyPassword("anything", "$argon2id$v=19$m=65536$abc$def")).resolves.toBe(false);
    await expect(verifyPassword("anything", "$scrypt$ln=99,r=8,p=1$abc$def")).resolves.toBe(false);
  });

  it("reports when a hash was made with weaker parameters", async () => {
    const weak = await hashPassword("a strong and long password", FAST);
    expect(passwordHashNeedsRehash(weak, DEFAULT_SCRYPT_PARAMS)).toBe(true);
    expect(passwordHashNeedsRehash(weak, FAST)).toBe(false);
    expect(passwordHashNeedsRehash("garbage")).toBe(true);
  });

  it("rejects out-of-range parameters", async () => {
    await expect(hashPassword("x", { logN: 9, blockSize: 8, parallelization: 1 })).rejects.toThrow(
      /logN/,
    );
    await expect(hashPassword("x", { logN: 12, blockSize: 0, parallelization: 1 })).rejects.toThrow(
      /blockSize/,
    );
    await expect(
      hashPassword("x", { logN: 12, blockSize: 8, parallelization: 17 }),
    ).rejects.toThrow(/parallelization/);
    await expect(
      hashPassword("x", { logN: 12.5, blockSize: 8, parallelization: 1 }),
    ).rejects.toThrow(/logN/);
  });

  it("accepts stored hashes at the parameter boundaries and rejects those just outside", () => {
    // Parsing only: ln=20 would cost 1 GiB to actually derive.
    const phc = (logN: number, blockSize = 8, parallelization = 2) =>
      `$scrypt$ln=${logN},r=${blockSize},p=${parallelization}$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g`;
    expect(passwordHashNeedsRehash(phc(20), DEFAULT_SCRYPT_PARAMS)).toBe(false);
    expect(passwordHashNeedsRehash(phc(10), DEFAULT_SCRYPT_PARAMS)).toBe(true);
    expect(passwordHashNeedsRehash(phc(10), FAST)).toBe(false);
    // Out of range parses as malformed, which always needs a rehash.
    expect(passwordHashNeedsRehash(phc(21), DEFAULT_SCRYPT_PARAMS)).toBe(true);
    expect(passwordHashNeedsRehash(phc(9), FAST)).toBe(true);
    expect(passwordHashNeedsRehash(phc(16, 32, 16), DEFAULT_SCRYPT_PARAMS)).toBe(false);
    expect(passwordHashNeedsRehash(phc(16, 33, 2), DEFAULT_SCRYPT_PARAMS)).toBe(true);
    expect(passwordHashNeedsRehash(phc(16, 8, 17), DEFAULT_SCRYPT_PARAMS)).toBe(true);
    // Any single weaker dimension triggers a rehash even when the others are stronger.
    expect(passwordHashNeedsRehash(phc(20, 8, 1), DEFAULT_SCRYPT_PARAMS)).toBe(true);
  });

  it("verifies as false for hashes with out-of-range or malformed parameters", async () => {
    await expect(verifyPassword("anything", "$scrypt$ln=21,r=8,p=1$c2FsdA$aGFzaA")).resolves.toBe(
      false,
    );
    await expect(verifyPassword("anything", "$scrypt$ln=9,r=8,p=1$c2FsdA$aGFzaA")).resolves.toBe(
      false,
    );
    // Non-base64url characters or a missing segment do not parse.
    await expect(verifyPassword("anything", "$scrypt$ln=10,r=8,p=1$c2F+sdA$aGFzaA")).resolves.toBe(
      false,
    );
    await expect(verifyPassword("anything", "$scrypt$ln=10,r=8,p=1$c2FsdA")).resolves.toBe(false);
  });
});

describe("password policy", () => {
  it("accepts a long passphrase", () => {
    expect(checkPasswordPolicy("tax backoffice evidence ledger 2026")).toEqual({
      ok: true,
      violations: [],
    });
  });

  it("rejects short, overly long, repetitive, and common passwords", () => {
    expect(checkPasswordPolicy("short").violations).toContain("too_short");
    expect(checkPasswordPolicy("a".repeat(129)).violations).toContain("too_long");
    expect(checkPasswordPolicy("aaaaaaaaaaaaaa").violations).toContain("too_repetitive");
    expect(checkPasswordPolicy("abababababab").violations).toContain("too_repetitive");
    expect(checkPasswordPolicy("Password12345").violations).toContain("common_password");
  });

  it("rejects passwords containing the user's email or its local part", () => {
    const result = checkPasswordPolicy("my Alice.Example password", {
      email: "alice.example@sona.test",
    });
    expect(result.violations).toEqual(["contains_email"]);
    expect(checkPasswordPolicy("something unrelated here", { email: "bob@sona.test" }).ok).toBe(
      true,
    );
  });

  it("treats the maximum length as inclusive", () => {
    const varied = (length: number) =>
      Array.from({ length }, (_, index) => String.fromCharCode(97 + (index % 26))).join("");
    expect(checkPasswordPolicy(varied(128))).toEqual({ ok: true, violations: [] });
    expect(checkPasswordPolicy(varied(129))).toEqual({ ok: false, violations: ["too_long"] });
    expect(checkPasswordPolicy(varied(12)).ok).toBe(true);
    expect(checkPasswordPolicy(varied(11)).violations).toEqual(["too_short"]);
    // Custom policy bounds are honoured the same way.
    const policy = { minLength: 8, maxLength: 16 };
    expect(checkPasswordPolicy(varied(16), {}, policy).ok).toBe(true);
    expect(checkPasswordPolicy(varied(17), {}, policy).violations).toEqual(["too_long"]);
  });

  it("matches the full email address even when the local part is too short to match alone", () => {
    const email = "ab@sona.test";
    expect(checkPasswordPolicy("ledger for AB@Sona.Test 2026", { email }).violations).toEqual([
      "contains_email",
    ]);
    // Two-letter local parts on their own are too common to reject.
    expect(checkPasswordPolicy("absolutely fabulous ledger", { email }).ok).toBe(true);
    // Untrimmed, mixed-case context addresses are normalized before matching.
    expect(
      checkPasswordPolicy("my ab@sona.test passphrase", { email: "  AB@SONA.TEST " }).violations,
    ).toEqual(["contains_email"]);
  });

  it("does not reject passwords containing a local part shorter than four characters", () => {
    expect(checkPasswordPolicy("bobsled team riding 2026", { email: "bob@sona.test" }).ok).toBe(
      true,
    );
    expect(checkPasswordPolicy("bobby tables ledger 2026", { email: "bobb@sona.test" }).ok).toBe(
      false,
    );
    // No email context: nothing to match.
    expect(checkPasswordPolicy("alice.example rides again").ok).toBe(true);
  });

  it("counts code points, not UTF-16 units", () => {
    expect(checkPasswordPolicy("😀".repeat(6)).violations).toContain("too_short");
    expect(checkPasswordPolicy("😀🙂😎😀🙂😎😀🙂😎😀🙂😎").ok).toBe(true);
  });
});
