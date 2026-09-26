import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  constantTimeEqual,
  createAesGcmSecretCipher,
  generateToken,
  hashToken,
  TOKEN_PREFIXES,
} from "./crypto.js";

describe("tokens", () => {
  it("generates prefixed, high-entropy, unique tokens", () => {
    const first = generateToken("session");
    const second = generateToken("session");
    expect(first.startsWith(TOKEN_PREFIXES.session)).toBe(true);
    expect(first.length - TOKEN_PREFIXES.session.length).toBeGreaterThanOrEqual(43);
    expect(first).not.toEqual(second);
    expect(generateToken("api_token").startsWith("sona_tok_")).toBe(true);
    expect(generateToken("invite").startsWith("sona_inv_")).toBe(true);
  });

  it("hashes deterministically and does not reveal the token", () => {
    const token = generateToken("api_token");
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).not.toContain(token.slice(9, 20));
  });

  it("compares strings of different lengths without throwing", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("aes-gcm secret cipher", () => {
  const key = randomBytes(32);

  it("round-trips and randomizes the nonce", () => {
    const cipher = createAesGcmSecretCipher(key);
    const first = cipher.encrypt("JBSWY3DPEHPK3PXP");
    const second = cipher.encrypt("JBSWY3DPEHPK3PXP");
    expect(first).not.toEqual(second);
    expect(first).not.toContain("JBSWY3DPEHPK3PXP");
    expect(cipher.decrypt(first)).toBe("JBSWY3DPEHPK3PXP");
    expect(cipher.decrypt(second)).toBe("JBSWY3DPEHPK3PXP");
  });

  it("rejects tampering, the wrong key, and malformed input", () => {
    const cipher = createAesGcmSecretCipher(key);
    const ciphertext = cipher.encrypt("secret");
    const [version, body] = ciphertext.split(".");
    const bytes = Buffer.from(body ?? "", "base64url");
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0x01;
    expect(() => cipher.decrypt(`${version}.${bytes.toString("base64url")}`)).toThrow();
    expect(() => createAesGcmSecretCipher(randomBytes(32)).decrypt(ciphertext)).toThrow();
    expect(() => cipher.decrypt("v0.abc")).toThrow(/format/);
    expect(() => cipher.decrypt("v1.abc")).toThrow(/truncated/);
  });

  it("requires a 32-byte key", () => {
    expect(() => createAesGcmSecretCipher(randomBytes(16))).toThrow(/32 bytes/);
  });
});
