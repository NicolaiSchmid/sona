import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Opaque bearer tokens. The prefix makes a leaked token recognizable in
 * secret scanners; the body is 256 bits of randomness, base64url encoded.
 */
export const TOKEN_PREFIXES = {
  session: "sona_sess_",
  invite: "sona_inv_",
  apiToken: "sona_tok_",
} as const;

export type TokenKind = keyof typeof TOKEN_PREFIXES;

const TOKEN_BYTES = 32;

export function generateToken(kind: TokenKind): string {
  return `${TOKEN_PREFIXES[kind]}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
}

/** Digest stored at rest instead of the token; a DB leak yields nothing usable. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Constant-time string equality that also hides the length difference by
 * comparing fixed-size digests. Use for every secret-vs-secret comparison.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}

// --- Symmetric cipher for TOTP secrets --------------------------------------
//
// A TOTP secret is a shared secret, so unlike passwords and tokens it cannot
// be stored as a one-way digest. It is encrypted at rest with a key the
// deployment supplies (same operational model as the local secret store).

export interface SecretCipher {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

const CIPHER_KEY_LENGTH = 32;
const CIPHER_NONCE_LENGTH = 12;
const CIPHER_TAG_LENGTH = 16;
const CIPHER_VERSION = "v1";

export function createAesGcmSecretCipher(key: Uint8Array): SecretCipher {
  if (key.byteLength !== CIPHER_KEY_LENGTH) {
    throw new Error("Secret cipher key must be 32 bytes for AES-256-GCM");
  }
  const keyBuffer = Buffer.from(key);
  return {
    encrypt(plaintext) {
      const nonce = randomBytes(CIPHER_NONCE_LENGTH);
      const cipher = createCipheriv("aes-256-gcm", keyBuffer, nonce, {
        authTagLength: CIPHER_TAG_LENGTH,
      });
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${CIPHER_VERSION}.${Buffer.concat([nonce, tag, body]).toString("base64url")}`;
    },
    decrypt(ciphertext) {
      const [version, encoded, extra] = ciphertext.split(".");
      if (version !== CIPHER_VERSION || encoded === undefined || extra !== undefined) {
        throw new Error("Unsupported secret ciphertext format");
      }
      const bytes = Buffer.from(encoded, "base64url");
      if (bytes.byteLength < CIPHER_NONCE_LENGTH + CIPHER_TAG_LENGTH) {
        throw new Error("Secret ciphertext is truncated");
      }
      const nonce = bytes.subarray(0, CIPHER_NONCE_LENGTH);
      const tag = bytes.subarray(CIPHER_NONCE_LENGTH, CIPHER_NONCE_LENGTH + CIPHER_TAG_LENGTH);
      const body = bytes.subarray(CIPHER_NONCE_LENGTH + CIPHER_TAG_LENGTH);
      const decipher = createDecipheriv("aes-256-gcm", keyBuffer, nonce, {
        authTagLength: CIPHER_TAG_LENGTH,
      });
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    },
  };
}
