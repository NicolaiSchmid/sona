/**
 * Enable Banking authenticates API calls with a short-lived RS256 JWT signed by
 * the application's private key. We build and sign it with `node:crypto` so no
 * JWT library is required.
 *
 * Never log or embed the private key or signed token in errors.
 */
import { createSign } from "node:crypto";

/** Hard ceiling on token lifetime. Enable Banking rejects long-lived tokens. */
export const MAX_JWT_TTL_SECONDS = 24 * 60 * 60;

const DEFAULT_TTL_SECONDS = 3600;
const DEFAULT_AUDIENCE = "api.enablebanking.com";

export interface JwtConfig {
  /** Enable Banking Application ID; used as both `kid` and `iss`. */
  applicationId: string;
  /** PEM-encoded RSA private key. */
  privateKeyPem: string;
  /** Token audience; defaults to the Enable Banking API host. */
  audience?: string;
  /** Lifetime in seconds; clamped to {@link MAX_JWT_TTL_SECONDS}. */
  ttlSeconds?: number;
}

export interface JwtHeader {
  typ: "JWT";
  alg: "RS256";
  kid: string;
}

export interface JwtPayload {
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Builds and signs an Enable Banking JWT. `nowSeconds` is injectable for
 * deterministic tests. The lifetime is clamped so `exp - iat` never exceeds
 * {@link MAX_JWT_TTL_SECONDS}.
 */
export function createEnableBankingJwt(
  config: JwtConfig,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const ttl = Math.min(config.ttlSeconds ?? DEFAULT_TTL_SECONDS, MAX_JWT_TTL_SECONDS);
  const header: JwtHeader = { typ: "JWT", alg: "RS256", kid: config.applicationId };
  const payload: JwtPayload = {
    iss: config.applicationId,
    aud: config.audience ?? DEFAULT_AUDIENCE,
    iat: nowSeconds,
    exp: nowSeconds + ttl,
  };

  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(config.privateKeyPem);
  return `${signingInput}.${base64Url(signature)}`;
}

export interface DecodedJwt {
  header: JwtHeader;
  payload: JwtPayload;
  signature: string;
}

/** Decodes a JWT's parts without verifying the signature (test/debug helper). */
export function decodeJwt(token: string): DecodedJwt {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed JWT: expected three dot-separated parts");
  }
  const [headerPart, payloadPart, signature] = parts as [string, string, string];
  const header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8")) as JwtHeader;
  const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as JwtPayload;
  return { header, payload, signature };
}
