import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

/**
 * scrypt parameters. Defaults follow the OWASP Password Storage Cheat Sheet
 * (N=2^16, r=8, p=2, ~64 MiB). Lower them only in tests.
 */
export interface ScryptParams {
  /** log2 of the CPU/memory cost `N`. */
  logN: number;
  blockSize: number;
  parallelization: number;
}

export const DEFAULT_SCRYPT_PARAMS = {
  logN: 16,
  blockSize: 8,
  parallelization: 2,
} as const satisfies ScryptParams;

const SALT_BYTES = 16;
const KEY_BYTES = 32;
const ALGORITHM = "scrypt";

/**
 * Hashes a password into a PHC-style string
 * `$scrypt$ln=16,r=8,p=2$<salt>$<hash>` with a fresh per-user salt. The
 * parameters travel with the hash so they can be raised later without
 * breaking verification of older hashes.
 */
export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<string> {
  assertScryptParams(params);
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, params);
  return `$${ALGORITHM}$ln=${params.logN},r=${params.blockSize},p=${params.parallelization}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

/** Timing-safe verification; malformed hashes verify as false rather than throwing. */
export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  const parsed = parsePasswordHash(passwordHash);
  if (parsed === undefined) {
    return false;
  }
  const key = await derive(password, parsed.salt, parsed.params);
  return key.byteLength === parsed.key.byteLength && timingSafeEqual(key, parsed.key);
}

/** True when the stored hash was produced with weaker parameters than `params`. */
export function passwordHashNeedsRehash(
  passwordHash: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): boolean {
  const parsed = parsePasswordHash(passwordHash);
  if (parsed === undefined) {
    return true;
  }
  return (
    parsed.params.logN < params.logN ||
    parsed.params.blockSize < params.blockSize ||
    parsed.params.parallelization < params.parallelization
  );
}

interface ParsedPasswordHash {
  params: ScryptParams;
  salt: Buffer;
  key: Buffer;
}

const HASH_RE =
  /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,3}),p=(\d{1,3})\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

function parsePasswordHash(passwordHash: string): ParsedPasswordHash | undefined {
  const match = HASH_RE.exec(passwordHash);
  if (match === null) {
    return undefined;
  }
  const [, logN, blockSize, parallelization, salt, key] = match;
  if (
    logN === undefined ||
    blockSize === undefined ||
    parallelization === undefined ||
    salt === undefined ||
    key === undefined
  ) {
    return undefined;
  }
  const params: ScryptParams = {
    logN: Number(logN),
    blockSize: Number(blockSize),
    parallelization: Number(parallelization),
  };
  try {
    assertScryptParams(params);
  } catch {
    return undefined;
  }
  return { params, salt: Buffer.from(salt, "base64url"), key: Buffer.from(key, "base64url") };
}

function assertScryptParams(params: ScryptParams): void {
  if (!Number.isInteger(params.logN) || params.logN < 10 || params.logN > 20) {
    throw new RangeError("scrypt logN must be an integer between 10 and 20");
  }
  if (!Number.isInteger(params.blockSize) || params.blockSize < 1 || params.blockSize > 32) {
    throw new RangeError("scrypt blockSize must be an integer between 1 and 32");
  }
  if (
    !Number.isInteger(params.parallelization) ||
    params.parallelization < 1 ||
    params.parallelization > 16
  ) {
    throw new RangeError("scrypt parallelization must be an integer between 1 and 16");
  }
}

async function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const cost = 2 ** params.logN;
  return new Promise<Buffer>((resolvePromise, rejectPromise) => {
    scryptCallback(
      Buffer.from(password, "utf8"),
      salt,
      KEY_BYTES,
      {
        N: cost,
        r: params.blockSize,
        p: params.parallelization,
        // Node refuses when 128 * N * r > maxmem; leave headroom above the exact footprint.
        maxmem: 128 * cost * params.blockSize * 2,
      },
      (error, derived) => (error ? rejectPromise(error) : resolvePromise(derived)),
    );
  });
}

// --- Password policy ----------------------------------------------------------

export const PASSWORD_POLICY_VIOLATIONS = [
  "too_short",
  "too_long",
  "too_repetitive",
  "contains_email",
  "common_password",
] as const;

export type PasswordPolicyViolation = (typeof PASSWORD_POLICY_VIOLATIONS)[number];

export interface PasswordPolicy {
  minLength: number;
  maxLength: number;
}

export const DEFAULT_PASSWORD_POLICY = {
  minLength: 12,
  maxLength: 128,
} as const satisfies PasswordPolicy;

export interface PasswordPolicyResult {
  ok: boolean;
  violations: readonly PasswordPolicyViolation[];
}

/** Small denylist of the most common leaked passwords (lower-cased, length >= 12). */
const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  "password1234",
  "password12345",
  "password123456",
  "123456789012",
  "1234567890123",
  "qwertyuiop12",
  "qwertyuiopas",
  "iloveyou1234",
  "administrator",
  "letmeinletmein",
  "changemechangeme",
  "correcthorsebattery",
  "correcthorsebatterystaple",
  "passwordpassword",
  "welcome12345",
]);

/**
 * Length- and denylist-based policy per NIST SP 800-63B: no composition rules,
 * but a sensible minimum, a DoS-preventing maximum, and rejection of the
 * user's own email and trivially repetitive strings.
 */
export function checkPasswordPolicy(
  password: string,
  context: { email?: string } = {},
  policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY,
): PasswordPolicyResult {
  const violations: PasswordPolicyViolation[] = [];
  const length = [...password].length;
  if (length < policy.minLength) {
    violations.push("too_short");
  }
  if (length > policy.maxLength) {
    violations.push("too_long");
  }
  if (length > 0 && new Set(password.toLowerCase()).size <= 2) {
    violations.push("too_repetitive");
  }
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) {
    violations.push("common_password");
  }
  if (context.email !== undefined) {
    const normalized = context.email.trim().toLowerCase();
    const localPart = normalized.split("@")[0] ?? "";
    if (
      (normalized.length >= 4 && lower.includes(normalized)) ||
      (localPart.length >= 4 && lower.includes(localPart))
    ) {
      violations.push("contains_email");
    }
  }
  return { ok: violations.length === 0, violations };
}
