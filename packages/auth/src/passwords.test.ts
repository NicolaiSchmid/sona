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

  it("counts code points, not UTF-16 units", () => {
    expect(checkPasswordPolicy("😀".repeat(6)).violations).toContain("too_short");
    expect(checkPasswordPolicy("😀🙂😎😀🙂😎😀🙂😎😀🙂😎").ok).toBe(true);
  });
});
