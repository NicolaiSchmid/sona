import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  hotp,
  normalizeRecoveryCode,
  totp,
  totpProvisioningUri,
  totpStep,
  verifyTotp,
} from "./totp.js";

/** RFC 6238 Appendix B secret ("12345678901234567890") in base32. */
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("totp", () => {
  it("matches the RFC 6238 SHA-1 test vectors (last 6 digits)", () => {
    const vectors: Array<[number, string]> = [
      [59, "287082"],
      [1111111109, "081804"],
      [1111111111, "050471"],
      [1234567890, "005924"],
      [2000000000, "279037"],
      [20000000000, "353130"],
    ];
    for (const [seconds, expected] of vectors) {
      expect(totp(RFC_SECRET, new Date(seconds * 1000))).toBe(expected);
    }
  });

  it("matches the RFC 4226 HOTP vector for counter 0", () => {
    expect(hotp(RFC_SECRET, 0)).toBe("755224");
  });

  it("accepts codes within the window and rejects those outside it", () => {
    const now = new Date(1111111111 * 1000);
    const step = totpStep(now);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step), now)).toEqual({ ok: true, step });
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 1), now)).toEqual({
      ok: true,
      step: step - 1,
    });
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + 1), now)).toEqual({
      ok: true,
      step: step + 1,
    });
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 2), now)).toEqual({ ok: false });
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + 2), now)).toEqual({ ok: false });
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 2), now, { window: 2 }).ok).toBe(true);
  });

  it("rejects replays at or below the last used step, even inside the window", () => {
    const now = new Date(1111111111 * 1000);
    const step = totpStep(now);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step), now, { afterStep: step })).toEqual({
      ok: false,
    });
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 1), now, { afterStep: step })).toEqual({
      ok: false,
    });
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + 1), now, { afterStep: step })).toEqual({
      ok: true,
      step: step + 1,
    });
  });

  it("tolerates whitespace in the entered code and rejects non-6-digit input", () => {
    const now = new Date(59 * 1000);
    expect(verifyTotp(RFC_SECRET, "287 082", now).ok).toBe(true);
    expect(verifyTotp(RFC_SECRET, "28708", now).ok).toBe(false);
    expect(verifyTotp(RFC_SECRET, "2870823", now).ok).toBe(false);
    expect(verifyTotp(RFC_SECRET, "abcdef", now).ok).toBe(false);
  });

  it("generates 160-bit base32 secrets that round-trip", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x01]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(base32Decode(RFC_SECRET).toString("ascii")).toBe("12345678901234567890");
    expect(() => base32Decode("not!base32")).toThrow(/base32/);
  });

  it("decodes lower-case and padded base32 the same as canonical input", () => {
    expect(base32Decode(RFC_SECRET.toLowerCase())).toEqual(base32Decode(RFC_SECRET));
    expect(base32Decode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq")).toEqual(
      base32Decode(RFC_SECRET),
    );
    // RFC 4648 padded forms round-trip to the unpadded encoding.
    expect(base32Encode(Buffer.from("f"))).toBe("MY");
    expect(base32Decode("MY======").toString("ascii")).toBe("f");
    expect(base32Decode("MZXW6YTB").toString("ascii")).toBe("fooba");
    expect(base32Decode("MZXW6YQ=").toString("ascii")).toBe("foob");
    expect(base32Decode("my======").toString("ascii")).toBe("f");
    expect(base32Decode("")).toHaveLength(0);
    // Padding in the middle is not tolerated.
    expect(() => base32Decode("MY==MY")).toThrow(/base32/);
    // Authenticator apps accept lower-case secrets, so codes must agree.
    expect(hotp(RFC_SECRET.toLowerCase(), 0)).toBe("755224");
  });

  it("handles counters above 32 bits without truncating the high word", () => {
    // RFC 4226 vectors for the low counters we can cross-check directly.
    expect(hotp(RFC_SECRET, 1)).toBe("287082");
    expect(hotp(RFC_SECRET, 9)).toBe("520489");
    const high = hotp(RFC_SECRET, 2 ** 32);
    expect(high).toMatch(/^\d{6}$/);
    expect(high).not.toBe(hotp(RFC_SECRET, 0));
    const huge = hotp(RFC_SECRET, Number.MAX_SAFE_INTEGER);
    expect(huge).toMatch(/^\d{6}$/);
    expect(huge).not.toBe(hotp(RFC_SECRET, Number.MAX_SAFE_INTEGER - 2 ** 32));
    expect(hotp(RFC_SECRET, 2 ** 32)).toBe(hotp(RFC_SECRET, 2 ** 32));
    // Codes below 100000 keep their leading zeros.
    expect(totp(RFC_SECRET, new Date(1234567890 * 1000))).toBe("005924");
  });

  it("accepts only the current step when the window is zero", () => {
    const now = new Date(1111111111 * 1000);
    const step = totpStep(now);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step), now, { window: 0 })).toEqual({
      ok: true,
      step,
    });
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 1), now, { window: 0 })).toEqual({
      ok: false,
    });
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + 1), now, { window: 0 })).toEqual({
      ok: false,
    });
    // A replay floor still applies with no skew allowance.
    expect(
      verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step), now, { window: 0, afterStep: step }),
    ).toEqual({ ok: false });
  });

  it("reports the earliest unused matching step when several candidates match", () => {
    // The first step strictly above afterStep wins, so the replay floor
    // advances by the smallest amount that admits the code.
    const now = new Date(1111111111 * 1000);
    const step = totpStep(now);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + 1), now, { afterStep: step })).toEqual({
      ok: true,
      step: step + 1,
    });
    expect(totpStep(new Date(0))).toBe(0);
    expect(totpStep(new Date(29_999))).toBe(0);
    expect(totpStep(new Date(30_000))).toBe(1);
    expect(totpStep(new Date(60_000), 60)).toBe(1);
  });

  it("builds an otpauth provisioning URI", () => {
    const uri = totpProvisioningUri({
      secretBase32: RFC_SECRET,
      accountName: "alice@sona.test",
      issuer: "Sona Dev",
    });
    expect(uri).toBe(
      `otpauth://totp/Sona%20Dev:alice%40sona.test?secret=${RFC_SECRET}&issuer=Sona+Dev&algorithm=SHA1&digits=6&period=30`,
    );
  });
});

describe("recovery codes", () => {
  it("generates distinct human-friendly codes", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    for (const code of codes) {
      expect(code).toMatch(/^[a-hj-km-np-z2-9]{5}-[a-hj-km-np-z2-9]{5}$/);
    }
  });

  it("normalizes user input before hashing", () => {
    expect(normalizeRecoveryCode(" ABCDE-fghjk ")).toBe("abcdefghjk");
    expect(normalizeRecoveryCode("abcde fghjk")).toBe("abcdefghjk");
  });
});
