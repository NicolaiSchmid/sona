import { createHmac, randomBytes, randomInt } from "node:crypto";
import { constantTimeEqual } from "./crypto.js";

/**
 * RFC 6238 TOTP over RFC 4226 HOTP, HMAC-SHA1, 30-second steps, 6 digits —
 * the parameters every mainstream authenticator app supports.
 */
export const TOTP_PARAMS = {
  algorithm: "sha1",
  digits: 6,
  stepSeconds: 30,
  secretBytes: 20,
} as const;

/** `step` is the time step whose code matched, to persist as the replay floor. */
export type TotpVerification = { ok: true; step: number } | { ok: false };

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(TOTP_PARAMS.secretBytes));
}

export function totpStep(at: Date, stepSeconds: number = TOTP_PARAMS.stepSeconds): number {
  return Math.floor(at.getTime() / 1000 / stepSeconds);
}

export function hotp(secretBase32: string, counter: number): string {
  const secret = base32Decode(secretBase32);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(TOTP_PARAMS.algorithm, secret).update(message).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);
  return String(binary % 10 ** TOTP_PARAMS.digits).padStart(TOTP_PARAMS.digits, "0");
}

export function totp(secretBase32: string, at: Date): string {
  return hotp(secretBase32, totpStep(at));
}

/**
 * Checks `code` against the current step and `window` steps on either side
 * (clock skew). Steps at or below `afterStep` are rejected so a code can be
 * used once even inside the window; the caller persists the returned step
 * through `TotpStore.advanceTotpStep`.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  at: Date,
  options: { window?: number; afterStep?: number } = {},
): TotpVerification {
  const window = options.window ?? 1;
  const afterStep = options.afterStep ?? -1;
  const normalized = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized)) {
    return { ok: false };
  }
  const current = totpStep(at);
  let matched: number | undefined;
  // Evaluate every candidate so timing does not reveal which step matched.
  for (let step = current - window; step <= current + window; step += 1) {
    const equal = constantTimeEqual(hotp(secretBase32, step), normalized);
    if (equal && step > afterStep && matched === undefined) {
      matched = step;
    }
  }
  return matched === undefined ? { ok: false } : { ok: true, step: matched };
}

/** `otpauth://` provisioning URI for authenticator apps / QR codes. */
export function totpProvisioningUri(input: {
  secretBase32: string;
  accountName: string;
  issuer: string;
}): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.accountName)}`;
  const query = new URLSearchParams({
    secret: input.secretBase32,
    issuer: input.issuer,
    algorithm: TOTP_PARAMS.algorithm.toUpperCase(),
    digits: String(TOTP_PARAMS.digits),
    period: String(TOTP_PARAMS.stepSeconds),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

// --- Recovery codes -----------------------------------------------------------

export const RECOVERY_CODE_COUNT = 8;
const RECOVERY_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const RECOVERY_CODE_GROUP = 5;

/** Human-friendly `xxxxx-xxxxx` codes without ambiguous characters. */
export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => `${recoveryGroup()}-${recoveryGroup()}`);
}

/** Canonical form used for hashing: lower-case, no separators or whitespace. */
export function normalizeRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function recoveryGroup(): string {
  let group = "";
  for (let index = 0; index < RECOVERY_CODE_GROUP; index += 1) {
    group += RECOVERY_CODE_ALPHABET[randomInt(RECOVERY_CODE_ALPHABET.length)];
  }
  return group;
}

// --- Base32 (RFC 4648, no padding) --------------------------------------------

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return output;
}

export function base32Decode(encoded: string): Buffer {
  const cleaned = encoded.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error("Invalid base32 character in TOTP secret");
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}
