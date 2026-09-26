import { randomBytes } from "node:crypto";
import {
  AuthService,
  createAesGcmSecretCipher,
  hashPassword,
  hashToken,
  isAuthError,
  NO_THROTTLE,
} from "@sona/auth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteAuditEventRepository } from "./audit-events.js";
import { SqliteAuthRepository } from "./auth.js";
import { createTestDatabase, type TestDatabase } from "./test-support.js";

const T0 = "2026-07-01T09:00:00.000Z";
const FAST_SCRYPT = { logN: 10, blockSize: 8, parallelization: 1 } as const;
const OWNER_PASSWORD = "family office ledger passphrase 2026";
const MEMBER_PASSWORD = "receipts reconciled passphrase 2026";

let database: TestDatabase;
let repository: SqliteAuthRepository;

beforeEach(() => {
  database = createTestDatabase();
  repository = new SqliteAuthRepository(database.db);
});

afterEach(() => {
  database.close();
});

async function seedUser(id: string, email: string): Promise<void> {
  await repository.createUser(
    { id, email, createdAt: T0 },
    { userId: id, passwordHash: "$scrypt$ln=10,r=8,p=1$c2FsdA$aGFzaA", updatedAt: T0 },
  );
}

describe("SqliteAuthRepository", () => {
  it("stores users with credentials atomically and looks them up by email", async () => {
    await seedUser("user_1", "alice@sona.test");
    expect(await repository.getUserByEmail("alice@sona.test")).toEqual({
      id: "user_1",
      email: "alice@sona.test",
      createdAt: T0,
    });
    expect(await repository.getCredential("user_1")).toMatchObject({ userId: "user_1" });
    expect(await repository.countUsers()).toBe(1);
    await expect(
      repository.createUser(
        { id: "user_2", email: "alice@sona.test", createdAt: T0 },
        { userId: "user_2", passwordHash: "x", updatedAt: T0 },
      ),
    ).rejects.toThrow(/UNIQUE/i);
    // The failed insert did not leave a dangling credential row.
    expect(await repository.getCredential("user_2")).toBeUndefined();
    expect(await repository.countUsers()).toBe(1);
  });

  it("claims an invite exactly once and refuses revoked or foreign-workspace invites", async () => {
    await seedUser("user_1", "owner@sona.test");
    const invite = {
      id: "inv_1",
      workspaceId: "ws_1",
      email: "new@sona.test",
      role: "member",
      tokenHash: hashToken("sona_inv_one"),
      createdByUserId: "user_1",
      createdAt: T0,
      expiresAt: "2026-07-08T09:00:00.000Z",
      acceptedAt: undefined,
      acceptedByUserId: undefined,
      revokedAt: undefined,
    } as const;
    await repository.createInvite(invite);
    await repository.createInvite({
      ...invite,
      id: "inv_2",
      tokenHash: hashToken("sona_inv_two"),
    });

    expect(await repository.getInviteByTokenHash(hashToken("sona_inv_one"))).toMatchObject({
      id: "inv_1",
      acceptedAt: undefined,
    });
    expect(await repository.claimInvite("inv_1", T0, "user_1")).toBe(true);
    expect(await repository.claimInvite("inv_1", T0, "user_1")).toBe(false);
    expect(await repository.getInvite("ws_1", "inv_1")).toMatchObject({
      acceptedAt: T0,
      acceptedByUserId: "user_1",
    });
    // Cannot revoke an accepted invite, nor one through another workspace.
    expect(await repository.revokeInvite("ws_1", "inv_1", T0)).toBe(false);
    expect(await repository.revokeInvite("ws_2", "inv_2", T0)).toBe(false);
    expect(await repository.getInvite("ws_2", "inv_2")).toBeUndefined();
    expect(await repository.revokeInvite("ws_1", "inv_2", T0)).toBe(true);
    expect(await repository.claimInvite("inv_2", T0, "user_1")).toBe(false);
    expect((await repository.listInvites("ws_1")).map((i) => i.id)).toEqual(["inv_1", "inv_2"]);
    expect(await repository.listInvites("ws_2")).toEqual([]);
  });

  it("revokes sessions only for their owner and counts bulk revocation", async () => {
    await seedUser("user_1", "a@sona.test");
    await seedUser("user_2", "b@sona.test");
    const session = (id: string, userId: string) => ({
      id,
      userId,
      tokenHash: hashToken(`sona_sess_${id}`),
      createdAt: T0,
      expiresAt: "2026-07-08T09:00:00.000Z",
      absoluteExpiresAt: "2026-07-31T09:00:00.000Z",
      lastSeenAt: T0,
      revokedAt: undefined,
      clientLabel: id === "ses_1" ? "Firefox" : undefined,
    });
    await repository.createSession(session("ses_1", "user_1"));
    await repository.createSession(session("ses_2", "user_1"));
    await repository.createSession(session("ses_3", "user_2"));

    expect(await repository.getSessionByTokenHash(hashToken("sona_sess_ses_1"))).toMatchObject({
      id: "ses_1",
      clientLabel: "Firefox",
    });
    await repository.renewSession("ses_1", "2026-07-09T09:00:00.000Z", "2026-07-02T09:00:00.000Z");
    expect(await repository.getSession("user_1", "ses_1")).toMatchObject({
      expiresAt: "2026-07-09T09:00:00.000Z",
      lastSeenAt: "2026-07-02T09:00:00.000Z",
    });
    expect(await repository.getSession("user_2", "ses_1")).toBeUndefined();
    expect(await repository.revokeSession("user_2", "ses_1", T0)).toBe(false);
    expect(await repository.revokeSession("user_1", "ses_1", T0)).toBe(true);
    expect(await repository.revokeSession("user_1", "ses_1", T0)).toBe(false);
    expect(await repository.revokeAllSessions("user_1", T0)).toBe(1);
    expect(await repository.revokeAllSessions("user_1", T0)).toBe(0);
    expect((await repository.listSessions("user_2")).map((s) => s.revokedAt)).toEqual([undefined]);
  });

  it("advances the TOTP step monotonically and consumes recovery codes once", async () => {
    await seedUser("user_1", "a@sona.test");
    await repository.saveTotpEnrollment({
      userId: "user_1",
      secretCiphertext: "v1.ciphertext",
      lastUsedStep: -1,
      createdAt: T0,
      confirmedAt: undefined,
    });
    expect(await repository.advanceTotpStep("user_1", 100)).toBe(true);
    expect(await repository.advanceTotpStep("user_1", 100)).toBe(false);
    expect(await repository.advanceTotpStep("user_1", 99)).toBe(false);
    expect(await repository.advanceTotpStep("user_1", 101)).toBe(true);
    expect(await repository.advanceTotpStep("user_missing", 5)).toBe(false);
    await repository.confirmTotpEnrollment("user_1", T0);
    await expect(repository.confirmTotpEnrollment("user_1", T0)).rejects.toThrow(/confirmed/);
    expect(await repository.getTotpEnrollment("user_1")).toMatchObject({
      lastUsedStep: 101,
      confirmedAt: T0,
    });
    // Re-enrolling replaces the row and resets the counter.
    await repository.saveTotpEnrollment({
      userId: "user_1",
      secretCiphertext: "v1.other",
      lastUsedStep: -1,
      createdAt: T0,
      confirmedAt: undefined,
    });
    expect(await repository.getTotpEnrollment("user_1")).toMatchObject({
      secretCiphertext: "v1.other",
      lastUsedStep: -1,
      confirmedAt: undefined,
    });

    await repository.replaceRecoveryCodes("user_1", [
      {
        id: "rc_1",
        userId: "user_1",
        codeHash: hashToken("aaaaabbbbb"),
        createdAt: T0,
        usedAt: undefined,
      },
      {
        id: "rc_2",
        userId: "user_1",
        codeHash: hashToken("cccccddddd"),
        createdAt: T0,
        usedAt: undefined,
      },
    ]);
    expect(await repository.countUnusedRecoveryCodes("user_1")).toBe(2);
    expect(await repository.consumeRecoveryCode("user_1", hashToken("aaaaabbbbb"), T0)).toBe(true);
    expect(await repository.consumeRecoveryCode("user_1", hashToken("aaaaabbbbb"), T0)).toBe(false);
    expect(await repository.consumeRecoveryCode("user_2", hashToken("cccccddddd"), T0)).toBe(false);
    expect(await repository.countUnusedRecoveryCodes("user_1")).toBe(1);
    await expect(
      repository.replaceRecoveryCodes("user_1", [
        { id: "rc_3", userId: "user_2", codeHash: "h", createdAt: T0, usedAt: undefined },
      ]),
    ).rejects.toThrow(/must match/);
    // The failed replacement rolled back: the previous codes are still there.
    expect(await repository.countUnusedRecoveryCodes("user_1")).toBe(1);
    await repository.deleteTotpEnrollment("user_1");
    expect(await repository.getTotpEnrollment("user_1")).toBeUndefined();
  });

  it("scopes API tokens to their workspace and round-trips the scope list", async () => {
    await seedUser("user_1", "a@sona.test");
    await repository.createApiToken({
      id: "tok_1",
      workspaceId: "ws_1",
      createdByUserId: "user_1",
      name: "bot",
      tokenHash: hashToken("sona_tok_one"),
      scopes: ["read", "suggest"],
      createdAt: T0,
      expiresAt: "2026-09-29T09:00:00.000Z",
      lastUsedAt: undefined,
      revokedAt: undefined,
    });
    expect(await repository.getApiTokenByHash(hashToken("sona_tok_one"))).toMatchObject({
      id: "tok_1",
      scopes: ["read", "suggest"],
    });
    expect(await repository.getApiToken("ws_2", "tok_1")).toBeUndefined();
    expect(await repository.listApiTokens("ws_2")).toEqual([]);
    expect(await repository.revokeApiToken("ws_2", "tok_1", T0)).toBe(false);
    await repository.touchApiToken("tok_1", "2026-07-02T09:00:00.000Z");
    expect(await repository.getApiToken("ws_1", "tok_1")).toMatchObject({
      lastUsedAt: "2026-07-02T09:00:00.000Z",
    });
    expect(await repository.revokeApiToken("ws_1", "tok_1", T0)).toBe(true);
    expect(await repository.revokeApiToken("ws_1", "tok_1", T0)).toBe(false);
    // Corrupted scope vocabulary is rejected instead of cast through.
    database.db
      .prepare("UPDATE api_tokens SET scopes_json = ? WHERE id = ?")
      .run('["read","approve"]', "tok_1");
    await expect(repository.getApiToken("ws_1", "tok_1")).rejects.toThrow(/scopes_json/);
  });

  it("orders memberships by creation time, then workspace id, and rejects duplicates", async () => {
    await seedUser("user_1", "a@sona.test");
    await repository.createWorkspace({ id: "ws_3", name: "C", createdAt: T0 });
    const join = (workspaceId: string, createdAt: string) =>
      repository.createMembership({ workspaceId, userId: "user_1", role: "member", createdAt });
    await join("ws_3", "2026-01-02T00:00:00Z");
    await join("ws_2", "2026-01-01T00:00:00Z");
    await join("ws_1", "2026-01-02T00:00:00Z");
    expect((await repository.listMemberships("user_1")).map((m) => m.workspaceId)).toEqual([
      "ws_2",
      "ws_1",
      "ws_3",
    ]);
    expect(await repository.listMemberships("user_missing")).toEqual([]);
    await expect(join("ws_1", T0)).rejects.toThrow(/UNIQUE|PRIMARY KEY/i);
    await expect(
      repository.createMembership({
        workspaceId: "ws_1",
        userId: "user_missing",
        role: "member",
        createdAt: T0,
      }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/i);
    await expect(join("ws_missing", T0)).rejects.toThrow(/FOREIGN KEY constraint failed/i);
    expect(await repository.listMemberships("user_1")).toHaveLength(3);
  });

  it("rejects a credential for a different user and updates for unknown users", async () => {
    await expect(
      repository.createUser(
        { id: "user_1", email: "a@sona.test", createdAt: T0 },
        { userId: "user_2", passwordHash: "$scrypt$ln=10,r=8,p=1$c2FsdA$aGFzaA", updatedAt: T0 },
      ),
    ).rejects.toThrow(/must match/);
    expect(await repository.getUserById("user_1")).toBeUndefined();
    expect(await repository.countUsers()).toBe(0);
    await expect(
      repository.updateCredential({ userId: "user_missing", passwordHash: "x", updatedAt: T0 }),
    ).rejects.toThrow(/not found/);
    await expect(repository.confirmTotpEnrollment("user_missing", T0)).rejects.toThrow(/not found/);
    // A credential row cannot exist without its user.
    expect(() =>
      database.db
        .prepare(
          "INSERT INTO user_credentials (user_id, password_hash, updated_at) VALUES (?, ?, ?)",
        )
        .run("user_missing", "x", T0),
    ).toThrow(/FOREIGN KEY constraint failed/i);
  });

  it("returns undefined for unknown token hashes and ids", async () => {
    expect(await repository.getInviteByTokenHash(hashToken("sona_inv_unknown"))).toBeUndefined();
    expect(await repository.getSessionByTokenHash(hashToken("sona_sess_unknown"))).toBeUndefined();
    expect(await repository.getApiTokenByHash(hashToken("sona_tok_unknown"))).toBeUndefined();
    expect(await repository.getInvite("ws_1", "inv_missing")).toBeUndefined();
    expect(await repository.getSession("user_1", "ses_missing")).toBeUndefined();
    expect(await repository.getApiToken("ws_1", "tok_missing")).toBeUndefined();
    expect(await repository.getUserByEmail("nobody@sona.test")).toBeUndefined();
    expect(await repository.getCredential("user_missing")).toBeUndefined();
    expect(await repository.getTotpEnrollment("user_missing")).toBeUndefined();
    expect(await repository.getMembership("ws_1", "user_missing")).toBeUndefined();
    expect(await repository.countUnusedRecoveryCodes("user_missing")).toBe(0);
    expect(await repository.claimInvite("inv_missing", T0, "user_1")).toBe(false);
  });

  it("enforces foreign keys, required columns, and hash uniqueness on auth rows", async () => {
    await seedUser("user_1", "a@sona.test");
    const session = {
      id: "ses_1",
      userId: "user_missing",
      tokenHash: hashToken("sona_sess_one"),
      createdAt: T0,
      expiresAt: "2026-07-08T09:00:00.000Z",
      absoluteExpiresAt: "2026-07-31T09:00:00.000Z",
      lastSeenAt: T0,
      revokedAt: undefined,
      clientLabel: undefined,
    };
    await expect(repository.createSession(session)).rejects.toThrow(
      /FOREIGN KEY constraint failed/i,
    );
    await repository.createSession({ ...session, userId: "user_1" });
    // Token hashes are unique, so two sessions can never share a bearer token.
    await expect(
      repository.createSession({ ...session, id: "ses_2", userId: "user_1" }),
    ).rejects.toThrow(/UNIQUE/i);

    const token = {
      id: "tok_1",
      workspaceId: "ws_missing",
      createdByUserId: "user_1",
      name: "bot",
      tokenHash: hashToken("sona_tok_one"),
      scopes: ["read"] as const,
      createdAt: T0,
      expiresAt: "2026-09-29T09:00:00.000Z",
      lastUsedAt: undefined,
      revokedAt: undefined,
    };
    await expect(repository.createApiToken(token)).rejects.toThrow(
      /FOREIGN KEY constraint failed/i,
    );
    await expect(
      repository.createApiToken({ ...token, workspaceId: "ws_1", createdByUserId: "user_missing" }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/i);
    await repository.createApiToken({ ...token, workspaceId: "ws_1" });
    await expect(
      repository.createApiToken({ ...token, id: "tok_2", workspaceId: "ws_2" }),
    ).rejects.toThrow(/UNIQUE/i);
    // Agent tokens must carry an expiry.
    expect(() =>
      database.db
        .prepare(
          "INSERT INTO api_tokens (id, workspace_id, created_by_user_id, name, token_hash, scopes_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("tok_3", "ws_1", "user_1", "bot", hashToken("sona_tok_three"), "[]", T0, null),
    ).toThrow(/NOT NULL constraint failed: api_tokens.expires_at/i);

    const invite = {
      id: "inv_1",
      workspaceId: "ws_missing",
      email: "new@sona.test",
      role: "member" as const,
      tokenHash: hashToken("sona_inv_one"),
      createdByUserId: "user_1",
      createdAt: T0,
      expiresAt: "2026-07-08T09:00:00.000Z",
      acceptedAt: undefined,
      acceptedByUserId: undefined,
      revokedAt: undefined,
    };
    await expect(repository.createInvite(invite)).rejects.toThrow(/FOREIGN KEY constraint failed/i);
    await expect(
      repository.createInvite({ ...invite, workspaceId: "ws_1", createdByUserId: "user_missing" }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/i);
    await repository.createInvite({ ...invite, workspaceId: "ws_1" });
    await expect(
      repository.createInvite({ ...invite, id: "inv_2", workspaceId: "ws_2" }),
    ).rejects.toThrow(/UNIQUE/i);

    await expect(
      repository.saveTotpEnrollment({
        userId: "user_missing",
        secretCiphertext: "v1.x",
        lastUsedStep: -1,
        createdAt: T0,
        confirmedAt: undefined,
      }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/i);
    await expect(
      repository.replaceRecoveryCodes("user_missing", [
        { id: "rc_1", userId: "user_missing", codeHash: "h", createdAt: T0, usedAt: undefined },
      ]),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/i);
    expect(await repository.listSessions("user_1")).toHaveLength(1);
    expect(await repository.listApiTokens("ws_1")).toHaveLength(1);
    expect(await repository.listInvites("ws_1")).toHaveLength(1);
  });

  it("rejects an unknown membership role read from the database", async () => {
    await seedUser("user_1", "a@sona.test");
    database.db
      .prepare(
        "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
      )
      .run("ws_1", "user_1", "superuser", T0);
    await expect(repository.getMembership("ws_1", "user_1")).rejects.toThrow(/role/);
  });
});

describe("AuthService on SQLite", () => {
  it("runs the invite → login → workspace access → API token flow with audit rows", async () => {
    const audit = new SqliteAuditEventRepository(database.db);
    let tick = 0;
    const service = new AuthService({
      store: repository,
      audit,
      secretCipher: createAesGcmSecretCipher(randomBytes(32)),
      now: () => new Date(Date.parse(T0) + tick++ * 1000),
      scrypt: FAST_SCRYPT,
      throttle: NO_THROTTLE,
    });

    // Owner of ws_1 (seeded by the test database) and a member invited into it.
    await repository.createUser(
      { id: "user_owner", email: "owner@sona.test", createdAt: T0 },
      { userId: "user_owner", passwordHash: "$scrypt$ln=10,r=8,p=1$c2FsdA$aGFzaA", updatedAt: T0 },
    );
    await repository.createMembership({
      workspaceId: "ws_1",
      userId: "user_owner",
      role: "owner",
      createdAt: T0,
    });
    const bootstrapped = await service.bootstrapOwner({
      email: "x@sona.test",
      password: OWNER_PASSWORD,
      workspaceName: "x",
    });
    expect(bootstrapped).toBeUndefined();

    // Owner sets a real password through the store, then logs in.
    await repository.updateCredential({
      userId: "user_owner",
      passwordHash: await hashPassword(OWNER_PASSWORD, FAST_SCRYPT),
      updatedAt: T0,
    });
    const ownerLogin = await service.login({ email: "owner@sona.test", password: OWNER_PASSWORD });
    const ownerSession = await service.resolveSession(ownerLogin.token);
    const ownerAccess = await service.resolveWorkspaceAccess({
      session: ownerSession,
      workspaceId: "ws_1",
    });
    expect(ownerAccess.role).toBe("owner");
    await expect(
      service.resolveWorkspaceAccess({ session: ownerSession, workspaceId: "ws_2" }),
    ).rejects.toSatisfy((error: unknown) => isAuthError(error, "workspace_access_denied"));

    const { token: inviteToken } = await service.createInvite({
      access: ownerAccess,
      email: "advisor@sona.test",
      role: "advisor_readonly",
    });
    const accepted = await service.acceptInvite({
      token: inviteToken,
      password: MEMBER_PASSWORD,
      throttleKey: "client:test",
    });
    expect(accepted.membership).toMatchObject({ workspaceId: "ws_1", role: "advisor_readonly" });
    await expect(
      service.acceptInvite({
        token: inviteToken,
        password: MEMBER_PASSWORD,
        throttleKey: "client:test",
      }),
    ).rejects.toSatisfy((error: unknown) => isAuthError(error, "invite_used"));

    const advisorLogin = await service.login({
      email: "advisor@sona.test",
      password: MEMBER_PASSWORD,
    });
    const advisorSession = await service.resolveSession(advisorLogin.token);
    const advisorAccess = await service.resolveWorkspaceAccess({
      session: advisorSession,
      workspaceId: "ws_1",
    });
    await expect(service.authorize(advisorAccess, "review_approve")).rejects.toSatisfy(
      (error: unknown) => isAuthError(error, "forbidden"),
    );

    const { token: secret } = await service.createApiToken({
      access: ownerAccess,
      name: "agent",
      scopes: ["execute"],
    });
    const agent = await service.resolveApiToken(secret);
    expect(agent.grants).toEqual(["read", "write_draft", "export"]);
    expect(agent.context.workspaceId).toBe("ws_1");

    const page = await audit.list("ws_1");
    expect(page.events.map((event) => event.action)).toEqual([
      "auth.login.succeeded",
      "auth.invite.created",
      "auth.invite.accepted",
      "auth.permission.denied",
      "auth.api_token.created",
    ]);
    const dump = JSON.stringify(page.events);
    for (const value of [
      ownerLogin.token,
      advisorLogin.token,
      inviteToken,
      secret,
      OWNER_PASSWORD,
    ]) {
      expect(dump).not.toContain(value);
    }
    expect(dump).not.toContain("advisor@sona.test");
    expect(await audit.list("ws_2")).toEqual({ events: [], nextCursor: undefined });
  });
});
