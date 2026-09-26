import { describe, expect, it } from "vitest";
import {
  type AccountantShareLink,
  createShareLink,
  DEFAULT_MAX_DOWNLOADS,
  DEFAULT_SHARE_LINK_TTL_MS,
  evaluateShareLinkAccess,
  generateShareToken,
  hashShareToken,
  MAX_SHARE_LINK_TTL_MS,
} from "./share-link.js";

const TOKEN = generateShareToken(() => new Uint8Array(32).fill(7));
const OTHER_TOKEN = generateShareToken(() => new Uint8Array(32).fill(8));
const SHA = "a".repeat(64);

function link(overrides: Partial<Parameters<typeof createShareLink>[0]> = {}): AccountantShareLink {
  return createShareLink({
    id: "sl_1",
    workspaceId: "ws_1",
    packageDocumentId: "doc_pkg",
    packageSha256: SHA,
    taxYear: 2026,
    token: TOKEN,
    createdBy: "user_1",
    createdAt: "2027-03-01T10:00:00Z",
    ...overrides,
  });
}

describe("generateShareToken", () => {
  it("is 32 random bytes as base64url and distinct per call", () => {
    expect(TOKEN).toHaveLength(43);
    expect(TOKEN).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(generateShareToken()).not.toBe(generateShareToken());
  });
});

describe("createShareLink", () => {
  it("stores only the token hash with default expiry and cap", () => {
    const l = link();
    expect(l.tokenHash).toBe(hashShareToken(TOKEN));
    expect(JSON.stringify(l)).not.toContain(TOKEN);
    expect(l.expiresAt).toBe(
      new Date(Date.parse("2027-03-01T10:00:00Z") + DEFAULT_SHARE_LINK_TTL_MS).toISOString(),
    );
    expect(l.maxDownloads).toBe(DEFAULT_MAX_DOWNLOADS);
    expect(l.downloadCount).toBe(0);
    expect(l.revokedAt).toBeUndefined();
  });

  it("validates its inputs", () => {
    expect(() => link({ token: "short" })).toThrow(/too short/);
    expect(() => link({ ttlMs: 0 })).toThrow(/ttl/);
    expect(() => link({ ttlMs: MAX_SHARE_LINK_TTL_MS + 1 })).toThrow(/ttl/);
    expect(() => link({ maxDownloads: 0 })).toThrow(/maxDownloads/);
    expect(() => link({ maxDownloads: 1.5 })).toThrow(/maxDownloads/);
    expect(() => link({ createdAt: "yesterday" })).toThrow(/createdAt/);
    expect(() => link({ packageSha256: "nothex" })).toThrow(/packageSha256/);
    expect(() => link({ createdBy: " " })).toThrow(/createdBy/);
  });
});

describe("evaluateShareLinkAccess", () => {
  const l = link({ ttlMs: 60_000, maxDownloads: 2 });
  const inTime = "2027-03-01T10:00:30Z";

  it("allows a matching token before expiry and under the cap", () => {
    expect(evaluateShareLinkAccess(l, { token: TOKEN, now: inTime })).toEqual({ allowed: true });
  });

  it("denies a wrong token without revealing the link state", () => {
    const revoked = { ...l, revokedAt: "2027-03-01T10:00:10Z" };
    expect(evaluateShareLinkAccess(revoked, { token: OTHER_TOKEN, now: inTime })).toEqual({
      allowed: false,
      reason: "token_mismatch",
    });
    expect(evaluateShareLinkAccess(l, { token: "", now: inTime })).toEqual({
      allowed: false,
      reason: "token_mismatch",
    });
  });

  it("denies at and after expiry", () => {
    expect(evaluateShareLinkAccess(l, { token: TOKEN, now: "2027-03-01T10:01:00Z" })).toEqual({
      allowed: false,
      reason: "expired",
    });
    expect(evaluateShareLinkAccess(l, { token: TOKEN, now: "2028-01-01T00:00:00Z" })).toEqual({
      allowed: false,
      reason: "expired",
    });
  });

  it("denies once the download cap is reached", () => {
    expect(
      evaluateShareLinkAccess({ ...l, downloadCount: 1 }, { token: TOKEN, now: inTime }),
    ).toEqual({
      allowed: true,
    });
    expect(
      evaluateShareLinkAccess({ ...l, downloadCount: 2 }, { token: TOKEN, now: inTime }),
    ).toEqual({
      allowed: false,
      reason: "download_cap_reached",
    });
  });

  it("denies a revoked link even with the right token", () => {
    expect(
      evaluateShareLinkAccess(
        { ...l, revokedAt: "2027-03-01T10:00:10Z" },
        { token: TOKEN, now: inTime },
      ),
    ).toEqual({ allowed: false, reason: "revoked" });
  });

  it("rejects an unparseable request time instead of allowing", () => {
    expect(() => evaluateShareLinkAccess(l, { token: TOKEN, now: "now" })).toThrow(/ISO-8601/);
  });
});
