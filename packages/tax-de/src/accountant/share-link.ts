/**
 * Expiring, read-only share links for accountant packages (hosted mode).
 *
 * Pure domain model: the link stores only a hash of the bearer token, the
 * package it points at (by artifact id and SHA-256), an expiry, a download
 * cap, and a revocation timestamp. Serving the bytes over HTTP is a separate
 * concern; this module only decides whether a presented token may download.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { sha256Hex } from "@sona/core";

export interface AccountantShareLink {
  id: string;
  workspaceId: string;
  /** `DocumentStorage` id of the stored ZIP. */
  packageDocumentId: string;
  /** SHA-256 of the ZIP bytes; the recipient can verify the download against it. */
  packageSha256: string;
  /** Tax year of the package, for listing. */
  taxYear: number;
  /** SHA-256 of the bearer token; the token itself is never stored. */
  tokenHash: string;
  /** Who created the link: a user id or "agent:<session>". */
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  maxDownloads: number;
  downloadCount: number;
  revokedAt: string | undefined;
}

export const SHARE_LINK_DENIAL_REASONS = [
  "token_mismatch",
  "revoked",
  "expired",
  "download_cap_reached",
] as const;

export type ShareLinkDenialReason = (typeof SHARE_LINK_DENIAL_REASONS)[number];

export type ShareLinkAccess = { allowed: true } | { allowed: false; reason: ShareLinkDenialReason };

/** Bearer tokens are 32 random bytes, base64url — 43 characters. */
export const SHARE_TOKEN_BYTES = 32;
const MIN_TOKEN_LENGTH = 43;
/** Hard ceiling so a link cannot be minted "for a year"; default ttl is shorter. */
export const MAX_SHARE_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_SHARE_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_DOWNLOADS = 5;

export function generateShareToken(
  random: (byteLength: number) => Uint8Array = (n) => new Uint8Array(randomBytes(n)),
): string {
  return Buffer.from(random(SHARE_TOKEN_BYTES)).toString("base64url");
}

export function hashShareToken(token: string): string {
  return sha256Hex(token);
}

export interface CreateShareLinkInput {
  id: string;
  workspaceId: string;
  packageDocumentId: string;
  packageSha256: string;
  taxYear: number;
  /** Plaintext token from {@link generateShareToken}; only its hash is kept. */
  token: string;
  createdBy: string;
  createdAt: string;
  /** Default {@link DEFAULT_SHARE_LINK_TTL_MS}; capped at {@link MAX_SHARE_LINK_TTL_MS}. */
  ttlMs?: number;
  /** Default {@link DEFAULT_MAX_DOWNLOADS}; must be a positive integer. */
  maxDownloads?: number;
}

export function createShareLink(input: CreateShareLinkInput): AccountantShareLink {
  if (input.token.length < MIN_TOKEN_LENGTH) {
    throw new Error("share token is too short; use generateShareToken()");
  }
  const ttlMs = input.ttlMs ?? DEFAULT_SHARE_LINK_TTL_MS;
  if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_SHARE_LINK_TTL_MS) {
    throw new Error(`share link ttl must be between 1 ms and ${MAX_SHARE_LINK_TTL_MS} ms`);
  }
  const maxDownloads = input.maxDownloads ?? DEFAULT_MAX_DOWNLOADS;
  if (!Number.isInteger(maxDownloads) || maxDownloads < 1) {
    throw new Error("share link maxDownloads must be a positive integer");
  }
  const createdAtMs = Date.parse(input.createdAt);
  if (Number.isNaN(createdAtMs)) {
    throw new Error("share link createdAt must be an ISO-8601 timestamp");
  }
  if (!/^[a-f0-9]{64}$/.test(input.packageSha256)) {
    throw new Error("share link packageSha256 must be a lowercase hex SHA-256");
  }
  if (input.createdBy.trim() === "") {
    throw new Error("share link createdBy is required");
  }
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    packageDocumentId: input.packageDocumentId,
    packageSha256: input.packageSha256,
    taxYear: input.taxYear,
    tokenHash: hashShareToken(input.token),
    createdBy: input.createdBy,
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(createdAtMs + ttlMs).toISOString(),
    maxDownloads,
    downloadCount: 0,
    revokedAt: undefined,
  };
}

export interface ShareLinkAccessRequest {
  /** Plaintext token presented by the caller. */
  token: string;
  /** ISO-8601 time of the request. */
  now: string;
}

/**
 * Whether a presented token may download the package right now. Checks are
 * ordered so an attacker with a wrong token learns nothing about the link's
 * state, and the token comparison is constant-time on the hashes.
 */
export function evaluateShareLinkAccess(
  link: Pick<
    AccountantShareLink,
    "tokenHash" | "expiresAt" | "maxDownloads" | "downloadCount" | "revokedAt"
  >,
  request: ShareLinkAccessRequest,
): ShareLinkAccess {
  const presented = Buffer.from(hashShareToken(request.token), "hex");
  const expected = Buffer.from(link.tokenHash, "hex");
  if (presented.byteLength !== expected.byteLength || !timingSafeEqual(presented, expected)) {
    return { allowed: false, reason: "token_mismatch" };
  }
  if (link.revokedAt !== undefined) {
    return { allowed: false, reason: "revoked" };
  }
  const now = Date.parse(request.now);
  if (Number.isNaN(now)) {
    throw new Error("share link access time must be an ISO-8601 timestamp");
  }
  if (now >= Date.parse(link.expiresAt)) {
    return { allowed: false, reason: "expired" };
  }
  if (link.downloadCount >= link.maxDownloads) {
    return { allowed: false, reason: "download_cap_reached" };
  }
  return { allowed: true };
}

/** Audit action names emitted by share-link repositories. */
export const SHARE_LINK_AUDIT_ACTIONS = {
  created: "accountant_share_link.created",
  downloaded: "accountant_share_link.downloaded",
  denied: "accountant_share_link.denied",
  revoked: "accountant_share_link.revoked",
} as const;

export type ShareLinkAuditAction =
  (typeof SHARE_LINK_AUDIT_ACTIONS)[keyof typeof SHARE_LINK_AUDIT_ACTIONS];
