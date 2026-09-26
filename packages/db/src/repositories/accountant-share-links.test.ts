import { createShareLink, generateShareToken } from "@sona/tax-de";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteAccountantShareLinkRepository } from "./accountant-share-links.js";
import { SqliteAuditEventRepository } from "./audit-events.js";
import { createTestDatabase, type TestDatabase } from "./test-support.js";

const TOKEN = generateShareToken(() => new Uint8Array(32).fill(1));
const OTHER_TOKEN = generateShareToken(() => new Uint8Array(32).fill(2));
const SHA = "b".repeat(64);
const CREATED_AT = "2027-03-01T10:00:00.000Z";

function link(overrides: Partial<Parameters<typeof createShareLink>[0]> = {}) {
  return createShareLink({
    id: "sl_1",
    workspaceId: "ws_1",
    packageDocumentId: "doc_pkg",
    packageSha256: SHA,
    taxYear: 2026,
    token: TOKEN,
    createdBy: "user_1",
    createdAt: CREATED_AT,
    ttlMs: 60_000,
    maxDownloads: 2,
    ...overrides,
  });
}

describe("SqliteAccountantShareLinkRepository", () => {
  let test: TestDatabase;
  let repo: SqliteAccountantShareLinkRepository;
  let audit: SqliteAuditEventRepository;
  let eventCounter = 0;
  const by = (actor = "user_1") => ({ actor, eventId: `ev_${eventCounter++}` });

  beforeEach(async () => {
    test = createTestDatabase();
    repo = new SqliteAccountantShareLinkRepository(test.db);
    audit = new SqliteAuditEventRepository(test.db);
    await repo.create(link(), by());
  });

  afterEach(() => {
    test.close();
  });

  async function actions(workspaceId = "ws_1"): Promise<string[]> {
    return (await audit.list(workspaceId)).events.map((e) => e.action);
  }

  it("persists the link without the token and audits creation", async () => {
    const stored = await repo.getById("ws_1", "sl_1");
    expect(stored).toEqual(link());
    expect(JSON.stringify(stored)).not.toContain(TOKEN);
    expect(await actions()).toEqual(["accountant_share_link.created"]);
    const [created] = (await audit.list("ws_1")).events;
    expect(created).toMatchObject({
      actor: "user_1",
      targetType: "accountant_share_link",
      targetId: "sl_1",
      metadata: { taxYear: 2026, packageSha256: SHA, maxDownloads: 2 },
    });
  });

  it("authorizes downloads up to the cap, counting and auditing each one", async () => {
    const now = "2027-03-01T10:00:10Z";
    const first = await repo.authorizeDownload({ token: TOKEN, now, ...by("share_link:sl_1") });
    expect(first).toMatchObject({ allowed: true, link: { downloadCount: 1 } });
    const second = await repo.authorizeDownload({ token: TOKEN, now, ...by("share_link:sl_1") });
    expect(second).toMatchObject({ allowed: true, link: { downloadCount: 2 } });
    const third = await repo.authorizeDownload({ token: TOKEN, now, ...by("share_link:sl_1") });
    expect(third).toEqual({ allowed: false, reason: "download_cap_reached" });
    expect((await repo.getById("ws_1", "sl_1"))?.downloadCount).toBe(2);
    expect(await actions()).toEqual([
      "accountant_share_link.created",
      "accountant_share_link.downloaded",
      "accountant_share_link.downloaded",
      "accountant_share_link.denied",
    ]);
    const denied = (await audit.list("ws_1")).events.at(-1);
    expect(denied?.metadata).toEqual({ reason: "download_cap_reached" });
  });

  it("denies expired links and audits the denial", async () => {
    const result = await repo.authorizeDownload({
      token: TOKEN,
      now: "2027-03-01T10:01:00Z",
      ...by("share_link:sl_1"),
    });
    expect(result).toEqual({ allowed: false, reason: "expired" });
    expect((await repo.getById("ws_1", "sl_1"))?.downloadCount).toBe(0);
    expect(await actions()).toContain("accountant_share_link.denied");
  });

  it("refuses unknown tokens without touching any workspace's audit log", async () => {
    const result = await repo.authorizeDownload({
      token: OTHER_TOKEN,
      now: "2027-03-01T10:00:10Z",
      ...by("share_link:?"),
    });
    expect(result).toEqual({ allowed: false, reason: "unknown_link" });
    expect(await actions()).toEqual(["accountant_share_link.created"]);
    expect((await audit.list("ws_2")).events).toEqual([]);
  });

  it("revokes idempotently and denies afterwards", async () => {
    const revoked = await repo.revoke("ws_1", "sl_1", { now: "2027-03-01T10:00:05Z", ...by() });
    expect(revoked.revokedAt).toBe("2027-03-01T10:00:05Z");
    const again = await repo.revoke("ws_1", "sl_1", { now: "2027-03-01T10:00:06Z", ...by() });
    expect(again.revokedAt).toBe("2027-03-01T10:00:05Z");
    expect(await actions()).toEqual([
      "accountant_share_link.created",
      "accountant_share_link.revoked",
    ]);
    const result = await repo.authorizeDownload({
      token: TOKEN,
      now: "2027-03-01T10:00:10Z",
      ...by("share_link:sl_1"),
    });
    expect(result).toEqual({ allowed: false, reason: "revoked" });
  });

  it("isolates workspaces", async () => {
    expect(await repo.getById("ws_2", "sl_1")).toBeUndefined();
    await expect(
      repo.revoke("ws_2", "sl_1", { now: "2027-03-01T10:00:05Z", ...by() }),
    ).rejects.toThrow(/not found in workspace/);
    expect(await repo.list("ws_2")).toEqual([]);
    expect((await repo.list("ws_1")).map((l) => l.id)).toEqual(["sl_1"]);
  });

  it("rejects a second link with the same token hash", async () => {
    await expect(
      repo.create(link({ id: "sl_2", workspaceId: "ws_2" }), by("user_2")),
    ).rejects.toThrow(/UNIQUE constraint failed/i);
    // The failed insert rolled back together with its audit event.
    expect((await audit.list("ws_2")).events).toEqual([]);
  });

  it("rejects links that are pre-used or pre-revoked", async () => {
    await expect(
      repo.create({ ...link({ id: "sl_3", token: OTHER_TOKEN }), downloadCount: 1 }, by()),
    ).rejects.toThrow(/unused and unrevoked/);
  });
});
