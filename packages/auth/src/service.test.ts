import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import type { AuditEvent } from "@sona/core";
import { describe, expect, it } from "vitest";
import { createAesGcmSecretCipher } from "./crypto.js";
import { type AuthError, isAuthError } from "./errors.js";
import { createFixedWindowThrottle, NO_THROTTLE } from "./rate-limit.js";
import { AuthService, type AuthServiceOptions, DEFAULT_SESSION_POLICY } from "./service.js";
import { InMemoryAuthStore } from "./testing.js";
import { hotp, totpStep } from "./totp.js";
import type { ApiTokenScope, WorkspaceRole } from "./types.js";

const FAST_SCRYPT = { logN: 10, blockSize: 8, parallelization: 1 } as const;
const OWNER_PASSWORD = "family office ledger passphrase 2026";
const MEMBER_PASSWORD = "receipts reconciled passphrase 2026";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

class Clock {
  now = new Date("2026-07-01T09:00:00.000Z");
  advance(ms: number): void {
    this.now = new Date(this.now.getTime() + ms);
  }
  read = (): Date => new Date(this.now.getTime());
}

interface Harness {
  service: AuthService;
  store: InMemoryAuthStore;
  clock: Clock;
  events: AuditEvent[];
}

function harness(overrides: Partial<AuthServiceOptions> = {}): Harness {
  const store = new InMemoryAuthStore();
  const clock = new Clock();
  const events: AuditEvent[] = [];
  let counter = 0;
  const service = new AuthService({
    store,
    audit: { append: async (event) => void events.push(event) },
    secretCipher: createAesGcmSecretCipher(randomBytes(32)),
    now: clock.read,
    idFactory: (kind) => `${kind}_${++counter}`,
    scrypt: FAST_SCRYPT,
    throttle: NO_THROTTLE,
    ...overrides,
  });
  return { service, store, clock, events };
}

async function bootstrapped(overrides: Partial<AuthServiceOptions> = {}) {
  const h = harness(overrides);
  if (
    overrides.systemAuditWorkspaceId !== undefined &&
    overrides.systemAuditWorkspaceId !== "ws_a"
  ) {
    await h.store.createWorkspace({
      id: overrides.systemAuditWorkspaceId,
      name: "Operations",
      createdAt: "2026-01-01T00:00:00Z",
    });
  }
  const owner = await h.service.bootstrapOwner({
    email: "Owner@Sona.test",
    password: OWNER_PASSWORD,
    workspaceName: "Family Office",
    workspaceId: "ws_a",
  });
  if (owner === undefined) {
    throw new Error("bootstrap failed");
  }
  const login = await h.service.login({ email: "owner@sona.test", password: OWNER_PASSWORD });
  const session = await h.service.resolveSession(login.token);
  const access = await h.service.resolveWorkspaceAccess({ session, workspaceId: "ws_a" });
  return { ...h, owner, ownerToken: login.token, ownerSession: session, ownerAccess: access };
}

async function invitedMember(
  h: Awaited<ReturnType<typeof bootstrapped>>,
  input: { email: string; role: "member" | "advisor_readonly" | "owner"; password?: string },
) {
  const { token } = await h.service.createInvite({
    access: h.ownerAccess,
    email: input.email,
    role: input.role,
  });
  const password = input.password ?? MEMBER_PASSWORD;
  const accepted = await h.service.acceptInvite({ token, password, throttleKey: "client:test" });
  const login = await h.service.login({ email: input.email, password });
  const session = await h.service.resolveSession(login.token);
  const access = await h.service.resolveWorkspaceAccess({ session, workspaceId: "ws_a" });
  return { ...accepted, token: login.token, session, access };
}

/** A second workspace `ws_b` in which the bootstrapped owner is also an owner. */
async function secondWorkspace(h: Awaited<ReturnType<typeof bootstrapped>>) {
  await h.store.createWorkspace({ id: "ws_b", name: "B", createdAt: "2026-01-01T00:00:00Z" });
  await h.store.createMembership({
    workspaceId: "ws_b",
    userId: h.owner.user.id,
    role: "owner",
    createdAt: "2026-01-01T00:00:00Z",
  });
  return h.service.resolveWorkspaceAccess({ session: h.ownerSession, workspaceId: "ws_b" });
}

function actions(events: AuditEvent[], workspaceId?: string): string[] {
  return events
    .filter((event) => workspaceId === undefined || event.workspaceId === workspaceId)
    .map((event) => event.action);
}

async function expectAuthError(promise: Promise<unknown>, code: AuthError["code"]) {
  await expect(promise).rejects.toSatisfy((error: unknown) => isAuthError(error, code));
}

describe("bootstrap", () => {
  it("creates the first owner and workspace once, then becomes a no-op", async () => {
    const h = await bootstrapped();
    expect(h.owner.user.email).toBe("owner@sona.test");
    expect(h.owner.membership).toMatchObject({ workspaceId: "ws_a", role: "owner" });
    expect(actions(h.events)).toContain("auth.bootstrap.completed");
    await expect(
      h.service.bootstrapOwner({
        email: "second@sona.test",
        password: OWNER_PASSWORD,
        workspaceName: "Other",
      }),
    ).resolves.toBeUndefined();
    expect(await h.store.countUsers()).toBe(1);
  });

  it("enforces the password policy on the bootstrap password", async () => {
    const h = harness();
    await expectAuthError(
      h.service.bootstrapOwner({ email: "o@sona.test", password: "short", workspaceName: "X" }),
      "password_policy",
    );
  });

  it("requires a non-blank workspace name and creates nothing when it is missing", async () => {
    const h = harness();
    await expect(
      h.service.bootstrapOwner({
        email: "o@sona.test",
        password: OWNER_PASSWORD,
        workspaceName: "   ",
      }),
    ).rejects.toMatchObject({ code: "invalid_input", details: ["workspace_name"] });
    expect(await h.store.countUsers()).toBe(0);
    expect(h.store.workspaces.size).toBe(0);
    expect(h.store.memberships).toEqual([]);
    expect(h.events).toEqual([]);
    // The name is trimmed on success and the email normalized.
    const result = await h.service.bootstrapOwner({
      email: "  O@Sona.TEST ",
      password: OWNER_PASSWORD,
      workspaceName: "  Family Office  ",
    });
    expect(result?.workspace.name).toBe("Family Office");
    expect(result?.user.email).toBe("o@sona.test");
    expect(await h.store.getCredential(result?.user.id ?? "")).toMatchObject({
      passwordHash: expect.stringMatching(/^\$scrypt\$ln=10,/),
    });
  });

  it("rejects a bootstrap password that contains the owner's email local part", async () => {
    const h = harness();
    await expectAuthError(
      h.service.bootstrapOwner({
        email: "treasurer@sona.test",
        password: "the treasurer ledger 2026",
        workspaceName: "X",
      }),
      "password_policy",
    );
    expect(await h.store.countUsers()).toBe(0);
  });
});

describe("invites", () => {
  it("requires admin rights to create, list, and revoke invites", async () => {
    const h = await bootstrapped();
    const member = await invitedMember(h, { email: "member@sona.test", role: "member" });
    await expectAuthError(
      h.service.createInvite({ access: member.access, email: "x@sona.test", role: "member" }),
      "forbidden",
    );
    await expectAuthError(h.service.listInvites(member.access), "forbidden");
    const invites = await h.service.listInvites(h.ownerAccess);
    expect(invites).toHaveLength(1);
    expect(invites[0]).not.toHaveProperty("tokenHash");
  });

  it("is single-use: the second accept fails and creates nothing", async () => {
    const h = await bootstrapped();
    const { token } = await h.service.createInvite({
      access: h.ownerAccess,
      email: "new@sona.test",
      role: "member",
    });
    await h.service.acceptInvite({ token, password: MEMBER_PASSWORD, throttleKey: "client:test" });
    await expectAuthError(
      h.service.acceptInvite({ token, password: MEMBER_PASSWORD, throttleKey: "client:test" }),
      "invite_used",
    );
    expect(await h.store.countUsers()).toBe(2);
    expect(actions(h.events, "ws_a").filter((a) => a === "auth.invite.accepted")).toHaveLength(1);
  });

  it("expires after its ttl", async () => {
    const h = await bootstrapped();
    const { token, invite } = await h.service.createInvite({
      access: h.ownerAccess,
      email: "late@sona.test",
      role: "member",
      ttlMs: HOUR,
    });
    expect(invite.expiresAt).toBe("2026-07-01T10:00:00.000Z");
    h.clock.advance(HOUR);
    await expectAuthError(
      h.service.acceptInvite({ token, password: MEMBER_PASSWORD, throttleKey: "client:test" }),
      "invite_expired",
    );
  });

  it("rejects unknown, revoked, and malformed tokens without distinguishing them", async () => {
    const h = await bootstrapped();
    const { token, invite } = await h.service.createInvite({
      access: h.ownerAccess,
      email: "gone@sona.test",
      role: "member",
    });
    await h.service.revokeInvite({ access: h.ownerAccess, inviteId: invite.id });
    await expectAuthError(
      h.service.acceptInvite({ token, password: MEMBER_PASSWORD, throttleKey: "client:test" }),
      "invite_invalid",
    );
    await expectAuthError(
      h.service.acceptInvite({
        token: "sona_inv_nope",
        password: MEMBER_PASSWORD,
        throttleKey: "client:test",
      }),
      "invite_invalid",
    );
    await expectAuthError(
      h.service.acceptInvite({
        token: "garbage",
        password: MEMBER_PASSWORD,
        throttleKey: "client:test",
      }),
      "invite_invalid",
    );
    await expectAuthError(
      h.service.revokeInvite({ access: h.ownerAccess, inviteId: invite.id }),
      "not_found",
    );
  });

  it("applies the password policy and refuses to create a duplicate account", async () => {
    const h = await bootstrapped();
    const { token } = await h.service.createInvite({
      access: h.ownerAccess,
      email: "owner@sona.test",
      role: "member",
    });
    await expectAuthError(
      h.service.acceptInvite({ token, password: "weak", throttleKey: "client:test" }),
      "password_policy",
    );
    await expectAuthError(
      h.service.acceptInvite({ token, password: MEMBER_PASSWORD, throttleKey: "client:test" }),
      "email_taken",
    );
    // Neither failure consumed the invite.
    const [invite] = await h.service.listInvites(h.ownerAccess);
    expect(invite?.acceptedAt).toBeUndefined();
  });

  it("lets an existing signed-in user join a second workspace when the email matches", async () => {
    const h = await bootstrapped();
    // Second workspace owned by another user.
    await h.store.createWorkspace({ id: "ws_b", name: "B", createdAt: "2026-01-01T00:00:00Z" });
    const other = await invitedMember(h, { email: "other@sona.test", role: "member" });
    await h.store.createMembership({
      workspaceId: "ws_b",
      userId: other.user.id,
      role: "owner",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const otherAccessB = await h.service.resolveWorkspaceAccess({
      session: other.session,
      workspaceId: "ws_b",
    });
    const { token } = await h.service.createInvite({
      access: otherAccessB,
      email: "owner@sona.test",
      role: "advisor_readonly",
    });
    const { token: wrong } = await h.service.createInvite({
      access: otherAccessB,
      email: "someone-else@sona.test",
      role: "member",
    });
    await expectAuthError(
      h.service.acceptInviteAsUser({ token: wrong, session: h.ownerSession }),
      "invite_email_mismatch",
    );
    const membership = await h.service.acceptInviteAsUser({ token, session: h.ownerSession });
    expect(membership).toMatchObject({ workspaceId: "ws_b", role: "advisor_readonly" });
    const accessB = await h.service.resolveWorkspaceAccess({
      session: h.ownerSession,
      workspaceId: "ws_b",
    });
    expect(accessB.role).toBe("advisor_readonly");
    expect(await h.service.listWorkspaces(h.ownerSession)).toHaveLength(2);
  });

  it("does not burn an invite when the signed-in user is already a member", async () => {
    const h = await bootstrapped();
    const member = await invitedMember(h, { email: "member@sona.test", role: "member" });
    const { token, invite } = await h.service.createInvite({
      access: h.ownerAccess,
      email: "member@sona.test",
      role: "advisor_readonly",
    });
    await expect(
      h.service.acceptInviteAsUser({ token, session: member.session }),
    ).rejects.toMatchObject({ code: "invite_invalid", details: ["already_member"] });
    // The existing membership keeps its role and the invite stays open.
    expect(await h.store.getMembership("ws_a", member.user.id)).toMatchObject({ role: "member" });
    const listed = await h.service.listInvites(h.ownerAccess);
    expect(listed.find((i) => i.id === invite.id)).toMatchObject({
      acceptedAt: undefined,
      revokedAt: undefined,
    });
    await expect(
      h.service.revokeInvite({ access: h.ownerAccess, inviteId: invite.id }),
    ).resolves.toBeUndefined();
    expect(actions(h.events, "ws_a").filter((a) => a === "auth.invite.accepted")).toHaveLength(1);
  });

  it("throttles invite acceptance per key before the token is even looked up", async () => {
    const throttle = createFixedWindowThrottle({ maxFailures: 1, windowMs: 10 * MINUTE });
    const h = await bootstrapped({ throttle });
    const { token } = await h.service.createInvite({
      access: h.ownerAccess,
      email: "new@sona.test",
      role: "member",
    });
    let lookups = 0;
    const lookup = h.store.getInviteByTokenHash.bind(h.store);
    h.store.getInviteByTokenHash = async (hash) => {
      lookups += 1;
      return lookup(hash);
    };

    await expectAuthError(
      h.service.acceptInvite({
        token: "sona_inv_wrong",
        password: MEMBER_PASSWORD,
        throttleKey: "ip:1",
      }),
      "invite_invalid",
    );
    expect(lookups).toBe(1);
    await expectAuthError(
      h.service.acceptInvite({ token, password: MEMBER_PASSWORD, throttleKey: "ip:1" }),
      "rate_limited",
    );
    expect(lookups).toBe(1);
    expect(await h.store.countUsers()).toBe(1);
    expect((await h.service.listInvites(h.ownerAccess))[0]?.acceptedAt).toBeUndefined();

    // A different client key is unaffected, and success resets its counter.
    const accepted = await h.service.acceptInvite({
      token,
      password: MEMBER_PASSWORD,
      throttleKey: "ip:2",
    });
    expect(accepted.membership).toMatchObject({ workspaceId: "ws_a", role: "member" });
    expect(throttle.allows("ip:2", h.clock.now)).toBe(true);
    expect(throttle.allows("ip:1", h.clock.now)).toBe(false);
    h.clock.advance(10 * MINUTE);
    await expectAuthError(
      h.service.acceptInvite({ token, password: MEMBER_PASSWORD, throttleKey: "ip:1" }),
      "invite_used",
    );
  });

  it("rejects invalid roles, emails, and ttls without creating anything", async () => {
    const h = await bootstrapped();
    await expect(
      h.service.createInvite({
        access: h.ownerAccess,
        email: "x@sona.test",
        role: "superuser" as WorkspaceRole,
      }),
    ).rejects.toMatchObject({ code: "invalid_input", details: ["role"] });
    await expect(
      h.service.createInvite({ access: h.ownerAccess, email: "not-an-email", role: "member" }),
    ).rejects.toMatchObject({ code: "invalid_input", details: ["email"] });
    await expect(
      h.service.createInvite({
        access: h.ownerAccess,
        email: "x@sona.test",
        role: "member",
        ttlMs: 0,
      }),
    ).rejects.toMatchObject({ code: "invalid_input", details: ["ttl"] });
    expect(await h.service.listInvites(h.ownerAccess)).toEqual([]);
    expect(actions(h.events)).not.toContain("auth.invite.created");
  });

  it("cannot see or revoke another workspace's invite through a different access", async () => {
    const h = await bootstrapped();
    const accessB = await secondWorkspace(h);
    const { token, invite } = await h.service.createInvite({
      access: accessB,
      email: "b-only@sona.test",
      role: "member",
    });
    await expectAuthError(
      h.service.revokeInvite({ access: h.ownerAccess, inviteId: invite.id }),
      "not_found",
    );
    expect(await h.service.listInvites(h.ownerAccess)).toEqual([]);
    expect((await h.service.listInvites(accessB)).map((i) => i.id)).toEqual([invite.id]);
    expect(actions(h.events)).not.toContain("auth.invite.revoked");
    // The invite is untouched and still accepts into ws_b only.
    const accepted = await h.service.acceptInvite({
      token,
      password: MEMBER_PASSWORD,
      throttleKey: "client:test",
    });
    expect(accepted.membership.workspaceId).toBe("ws_b");
    expect(await h.store.getMembership("ws_a", accepted.user.id)).toBeUndefined();
    expect(
      (await h.service.listWorkspaces(h.ownerSession)).map((w) => w.workspace.id).sort(),
    ).toEqual(["ws_a", "ws_b"]);
  });
});

describe("login and sessions", () => {
  it("rejects wrong passwords and unknown emails with the same error and audits both", async () => {
    const h = await bootstrapped({ systemAuditWorkspaceId: "ws_a" });
    await expectAuthError(
      h.service.login({ email: "owner@sona.test", password: "wrong password here" }),
      "invalid_credentials",
    );
    await expectAuthError(
      h.service.login({ email: "nobody@sona.test", password: OWNER_PASSWORD }),
      "invalid_credentials",
    );
    await expectAuthError(
      h.service.login({ email: "not an email", password: OWNER_PASSWORD }),
      "invalid_credentials",
    );
    const failures = h.events.filter((event) => event.action === "auth.login.failed");
    expect(failures.map((event) => [event.actor, event.metadata])).toEqual([
      [h.owner.user.id, { reason: "invalid_password" }],
      ["anonymous", { reason: "unknown_email" }],
      ["anonymous", { reason: "unknown_email" }],
    ]);
  });

  it("normalizes the email and records a successful login per workspace", async () => {
    const h = await bootstrapped();
    const result = await h.service.login({ email: "  OWNER@sona.test ", password: OWNER_PASSWORD });
    expect(result.method).toBe("password");
    expect(result.token.startsWith("sona_sess_")).toBe(true);
    expect(result.session).not.toHaveProperty("tokenHash");
    const success = h.events.filter((event) => event.action === "auth.login.succeeded");
    expect(success).toHaveLength(2);
    expect(success[1]).toMatchObject({
      workspaceId: "ws_a",
      actor: h.owner.user.id,
      targetType: "auth_session",
      targetId: result.session.id,
      metadata: { method: "password" },
    });
  });

  it("expires idle sessions, renews on activity, and enforces the absolute lifetime", async () => {
    const h = await bootstrapped({
      sessionPolicy: { idleTtlMs: 2 * HOUR, absoluteTtlMs: 5 * HOUR, renewIntervalMs: MINUTE },
    });
    const { token, session } = await h.service.login({
      email: "owner@sona.test",
      password: OWNER_PASSWORD,
    });
    expect(session.expiresAt).toBe("2026-07-01T11:00:00.000Z");
    expect(session.absoluteExpiresAt).toBe("2026-07-01T14:00:00.000Z");

    // Activity 90 minutes in slides the expiry forward.
    h.clock.advance(90 * MINUTE);
    const renewed = await h.service.resolveSession(token);
    expect(renewed.session.expiresAt).toBe("2026-07-01T12:30:00.000Z");
    expect(renewed.session.lastSeenAt).toBe("2026-07-01T10:30:00.000Z");

    // Quick successive requests do not rewrite the session.
    h.clock.advance(10_000);
    const unchanged = await h.service.resolveSession(token);
    expect(unchanged.session.lastSeenAt).toBe("2026-07-01T10:30:00.000Z");

    // Renewal never passes the absolute cap.
    h.clock.advance(110 * MINUTE);
    const capped = await h.service.resolveSession(token);
    expect(capped.session.expiresAt).toBe("2026-07-01T14:00:00.000Z");

    h.clock.advance(2 * HOUR);
    await expectAuthError(h.service.resolveSession(token), "session_invalid");

    // A fresh session left idle past the idle ttl is gone too.
    const second = await h.service.login({ email: "owner@sona.test", password: OWNER_PASSWORD });
    h.clock.advance(2 * HOUR);
    await expectAuthError(h.service.resolveSession(second.token), "session_invalid");
  });

  it("revokes on logout and lists only active sessions", async () => {
    const h = await bootstrapped();
    const second = await h.service.login({
      email: "owner@sona.test",
      password: OWNER_PASSWORD,
      clientLabel: "Firefox on Linux",
    });
    expect(await h.service.listSessions(h.ownerSession)).toHaveLength(2);

    await h.service.logout(second.token);
    await expectAuthError(h.service.resolveSession(second.token), "session_invalid");
    const remaining = await h.service.listSessions(h.ownerSession);
    expect(remaining.map((session) => session.id)).toEqual([h.ownerSession.session.id]);
    expect(actions(h.events, "ws_a")).toContain("auth.logout");

    // Logout is idempotent and silent for unknown tokens.
    await expect(h.service.logout(second.token)).resolves.toBeUndefined();
    await expect(h.service.logout("sona_sess_unknown")).resolves.toBeUndefined();
    expect(actions(h.events).filter((a) => a === "auth.logout")).toHaveLength(1);
  });

  it("lets a user revoke one or all of their own sessions, but not another user's", async () => {
    const h = await bootstrapped();
    const member = await invitedMember(h, { email: "member@sona.test", role: "member" });
    await expectAuthError(
      h.service.revokeSession({ session: h.ownerSession, sessionId: member.session.session.id }),
      "not_found",
    );
    await expect(h.service.resolveSession(member.token)).resolves.toBeDefined();

    const other = await h.service.login({ email: "owner@sona.test", password: OWNER_PASSWORD });
    await h.service.revokeSession({ session: h.ownerSession, sessionId: other.session.id });
    await expectAuthError(h.service.resolveSession(other.token), "session_invalid");
    expect(actions(h.events, "ws_a")).toContain("auth.session.revoked");

    expect(await h.service.revokeAllSessions(h.ownerSession)).toBe(1);
    await expectAuthError(h.service.resolveSession(h.ownerToken), "session_invalid");
  });

  it("rejects tokens with the wrong prefix or a mismatched hash", async () => {
    const h = await bootstrapped();
    await expectAuthError(h.service.resolveSession("sona_tok_abc"), "session_invalid");
    await expectAuthError(h.service.resolveSession(`${h.ownerToken}x`), "session_invalid");
    await expectAuthError(h.service.resolveSession(""), "session_invalid");
  });

  it("upgrades weak password hashes transparently on login", async () => {
    const h = await bootstrapped();
    const before = await h.store.getCredential(h.owner.user.id);
    const stronger = new AuthService({
      store: h.store,
      audit: { append: async () => undefined },
      secretCipher: createAesGcmSecretCipher(randomBytes(32)),
      now: h.clock.read,
      scrypt: { logN: 11, blockSize: 8, parallelization: 1 },
      throttle: NO_THROTTLE,
    });
    await stronger.login({ email: "owner@sona.test", password: OWNER_PASSWORD });
    const after = await h.store.getCredential(h.owner.user.id);
    expect(after?.passwordHash).not.toEqual(before?.passwordHash);
    expect(after?.passwordHash.startsWith("$scrypt$ln=11,")).toBe(true);
    await expect(
      stronger.login({ email: "owner@sona.test", password: OWNER_PASSWORD }),
    ).resolves.toBeDefined();
  });

  it("throttles repeated failures per email and per client key", async () => {
    const throttle = createFixedWindowThrottle({ maxFailures: 2, windowMs: 10 * MINUTE });
    const h = await bootstrapped({ throttle });
    const attempt = (password: string) =>
      h.service.login({ email: "owner@sona.test", password, throttleKey: "ip:10.0.0.1" });
    await expectAuthError(attempt("wrong one wrong one"), "invalid_credentials");
    await expectAuthError(attempt("wrong two wrong two"), "invalid_credentials");
    await expectAuthError(attempt(OWNER_PASSWORD), "rate_limited");
    // Another account from the same client is blocked too; the window then clears.
    await expectAuthError(
      h.service.login({
        email: "other@sona.test",
        password: OWNER_PASSWORD,
        throttleKey: "ip:10.0.0.1",
      }),
      "rate_limited",
    );
    h.clock.advance(10 * MINUTE);
    await expect(attempt(OWNER_PASSWORD)).resolves.toBeDefined();
    expect(
      h.events.filter(
        (e) => e.metadata && (e.metadata as { reason?: string }).reason === "rate_limited",
      ).length,
    ).toBeGreaterThan(0);
  });

  it("lists only sessions still inside their idle window", async () => {
    const h = await bootstrapped({
      sessionPolicy: { idleTtlMs: 2 * HOUR, absoluteTtlMs: 30 * DAY, renewIntervalMs: MINUTE },
    });
    h.clock.advance(90 * MINUTE);
    const later = await h.service.login({ email: "owner@sona.test", password: OWNER_PASSWORD });
    expect((await h.service.listSessions(h.ownerSession)).map((s) => s.id)).toEqual([
      h.ownerSession.session.id,
      later.session.id,
    ]);
    // 130 minutes in: the first session idled out, the second has 80 minutes left.
    h.clock.advance(40 * MINUTE);
    expect((await h.service.listSessions(h.ownerSession)).map((s) => s.id)).toEqual([
      later.session.id,
    ]);
    await expectAuthError(
      h.service.revokeSession({ session: h.ownerSession, sessionId: "ses_missing" }),
      "not_found",
    );
  });

  it("invalidates sessions whose user record disappeared", async () => {
    const h = await bootstrapped();
    h.store.users.delete(h.owner.user.id);
    await expectAuthError(h.service.resolveSession(h.ownerToken), "session_invalid");
  });

  it("mirrors successes and known-user failures into the system audit workspace", async () => {
    const h = await bootstrapped({ systemAuditWorkspaceId: "ws_ops" });
    const succeeded = h.events.filter((event) => event.action === "auth.login.succeeded");
    expect(succeeded.map((event) => event.workspaceId)).toEqual(["ws_a", "ws_ops"]);
    expect(succeeded[1]).toMatchObject({
      actor: h.owner.user.id,
      metadata: { method: "password" },
    });

    await expectAuthError(
      h.service.login({ email: "owner@sona.test", password: "wrong password here" }),
      "invalid_credentials",
    );
    const failed = h.events.filter((event) => event.action === "auth.login.failed");
    expect(failed.map((event) => [event.workspaceId, event.actor])).toEqual([
      ["ws_a", h.owner.user.id],
      ["ws_ops", h.owner.user.id],
    ]);
    // Without a system workspace, unknown-email failures have nowhere to go.
    const quiet = await bootstrapped();
    await expectAuthError(
      quiet.service.login({ email: "nobody@sona.test", password: OWNER_PASSWORD }),
      "invalid_credentials",
    );
    expect(actions(quiet.events)).not.toContain("auth.login.failed");
  });
});

describe("totp", () => {
  async function enrolled() {
    const h = await bootstrapped();
    const start = await h.service.beginTotpEnrollment(h.ownerSession);
    expect(start.otpauthUri).toContain("otpauth://totp/Sona:owner%40sona.test");
    // Unconfirmed enrollment is not enforced yet.
    await expect(
      h.service.login({ email: "owner@sona.test", password: OWNER_PASSWORD }),
    ).resolves.toMatchObject({ method: "password" });
    const code = hotp(start.secret, totpStep(h.clock.now));
    const confirmed = await h.service.confirmTotpEnrollment({
      session: h.ownerSession,
      code: code,
    });
    expect(confirmed.recoveryCodes).toHaveLength(8);
    return { ...h, secret: start.secret, recoveryCodes: confirmed.recoveryCodes };
  }

  it("requires a second factor after enrollment and rejects replayed codes", async () => {
    const h = await enrolled();
    expect(actions(h.events, "ws_a")).toContain("auth.totp.enabled");
    const stored = await h.store.getTotpEnrollment(h.owner.user.id);
    expect(stored?.secretCiphertext).not.toContain(h.secret);

    await expectAuthError(
      h.service.login({ email: "owner@sona.test", password: OWNER_PASSWORD }),
      "totp_required",
    );
    // The confirmation code's step is already used; wait for the next step.
    h.clock.advance(30_000);
    const code = hotp(h.secret, totpStep(h.clock.now));
    const result = await h.service.login({
      email: "owner@sona.test",
      password: OWNER_PASSWORD,
      secondFactor: { kind: "totp", code: code },
    });
    expect(result.method).toBe("password_totp");
    await expectAuthError(
      h.service.login({
        email: "owner@sona.test",
        password: OWNER_PASSWORD,
        secondFactor: { kind: "totp", code },
      }),
      "invalid_totp",
    );
    await expectAuthError(
      h.service.login({
        email: "owner@sona.test",
        password: OWNER_PASSWORD,
        secondFactor: { kind: "totp", code: "000000" },
      }),
      "invalid_totp",
    );
    const reasons = h.events
      .filter((event) => event.action === "auth.login.failed")
      .map((event) => (event.metadata as { reason: string }).reason);
    expect(reasons).toEqual(["totp_required", "invalid_totp", "invalid_totp"]);
  });

  it("accepts each recovery code once", async () => {
    const h = await enrolled();
    const [first] = h.recoveryCodes;
    if (first === undefined) {
      throw new Error("no recovery codes");
    }
    const result = await h.service.login({
      email: "owner@sona.test",
      password: OWNER_PASSWORD,
      secondFactor: { kind: "recovery_code", code: first.toUpperCase() },
    });
    expect(result.method).toBe("password_recovery_code");
    expect(await h.store.countUnusedRecoveryCodes(h.owner.user.id)).toBe(7);
    await expectAuthError(
      h.service.login({
        email: "owner@sona.test",
        password: OWNER_PASSWORD,
        secondFactor: { kind: "recovery_code", code: first },
      }),
      "invalid_totp",
    );
    const used = h.events.find((event) => event.action === "auth.recovery_code.used");
    expect(used?.metadata).toEqual({ remaining: 7 });
    // Stored codes are hashes only.
    for (const stored of h.store.recoveryCodes) {
      expect(h.recoveryCodes).not.toContain(stored.codeHash);
    }
  });

  it("requires the password to disable and refuses double enrollment", async () => {
    const h = await enrolled();
    await expectAuthError(h.service.beginTotpEnrollment(h.ownerSession), "totp_already_enrolled");
    await expectAuthError(
      h.service.disableTotp({ session: h.ownerSession, password: "not it" }),
      "invalid_credentials",
    );
    await h.service.disableTotp({ session: h.ownerSession, password: OWNER_PASSWORD });
    expect(await h.store.getTotpEnrollment(h.owner.user.id)).toBeUndefined();
    expect(await h.store.countUnusedRecoveryCodes(h.owner.user.id)).toBe(0);
    expect(actions(h.events, "ws_a")).toContain("auth.totp.disabled");
    await expect(
      h.service.login({ email: "owner@sona.test", password: OWNER_PASSWORD }),
    ).resolves.toMatchObject({ method: "password" });
  });

  it("rejects a wrong confirmation code and leaves the enrollment unconfirmed", async () => {
    const h = await bootstrapped();
    await h.service.beginTotpEnrollment(h.ownerSession);
    await expectAuthError(
      h.service.confirmTotpEnrollment({ session: h.ownerSession, code: "123456" }),
      "invalid_totp",
    );
    expect((await h.store.getTotpEnrollment(h.owner.user.id))?.confirmedAt).toBeUndefined();
    // An unconfirmed enrollment can be abandoned with the password, like a confirmed one.
    await h.service.disableTotp({ session: h.ownerSession, password: OWNER_PASSWORD });
    expect(await h.store.getTotpEnrollment(h.owner.user.id)).toBeUndefined();
  });

  it("reports totp_not_enrolled when confirming or disabling without an enrollment", async () => {
    const h = await bootstrapped();
    await expectAuthError(
      h.service.confirmTotpEnrollment({ session: h.ownerSession, code: "123456" }),
      "totp_not_enrolled",
    );
    // The password is checked before the enrollment state is revealed.
    await expectAuthError(
      h.service.disableTotp({ session: h.ownerSession, password: "not it" }),
      "invalid_credentials",
    );
    await expectAuthError(
      h.service.disableTotp({ session: h.ownerSession, password: OWNER_PASSWORD }),
      "totp_not_enrolled",
    );
    expect(actions(h.events)).not.toContain("auth.totp.enabled");
    expect(actions(h.events)).not.toContain("auth.totp.disabled");
  });

  it("uses a recovery code without moving the TOTP replay floor", async () => {
    const h = await enrolled();
    const [first] = h.recoveryCodes;
    if (first === undefined) {
      throw new Error("no recovery codes");
    }
    const before = await h.store.getTotpEnrollment(h.owner.user.id);
    h.clock.advance(30_000);
    const result = await h.service.login({
      email: "owner@sona.test",
      password: OWNER_PASSWORD,
      secondFactor: { kind: "recovery_code", code: first },
    });
    expect(result.method).toBe("password_recovery_code");
    expect(await h.store.countUnusedRecoveryCodes(h.owner.user.id)).toBe(7);
    expect((await h.store.getTotpEnrollment(h.owner.user.id))?.lastUsedStep).toBe(
      before?.lastUsedStep,
    );
    // A TOTP code offered as a recovery code fails, and vice versa.
    const code = hotp(h.secret, totpStep(h.clock.now));
    await expectAuthError(
      h.service.login({
        email: "owner@sona.test",
        password: OWNER_PASSWORD,
        secondFactor: { kind: "recovery_code", code },
      }),
      "invalid_totp",
    );
    const [, second] = h.recoveryCodes;
    await expectAuthError(
      h.service.login({
        email: "owner@sona.test",
        password: OWNER_PASSWORD,
        secondFactor: { kind: "totp", code: second ?? "" },
      }),
      "invalid_totp",
    );
    const reasons = h.events
      .filter((event) => event.action === "auth.login.failed")
      .map((event) => (event.metadata as { reason: string }).reason);
    expect(reasons).toEqual(["invalid_recovery_code", "invalid_totp"]);
  });

  it("replaces the pending secret when enrollment is begun again", async () => {
    const h = await bootstrapped();
    const first = await h.service.beginTotpEnrollment(h.ownerSession);
    const second = await h.service.beginTotpEnrollment(h.ownerSession);
    expect(second.secret).not.toBe(first.secret);
    await expectAuthError(
      h.service.confirmTotpEnrollment({
        session: h.ownerSession,
        code: hotp(first.secret, totpStep(h.clock.now)),
      }),
      "invalid_totp",
    );
    await expect(
      h.service.confirmTotpEnrollment({
        session: h.ownerSession,
        code: hotp(second.secret, totpStep(h.clock.now)),
      }),
    ).resolves.toMatchObject({ recoveryCodes: expect.any(Array) });
    await expectAuthError(
      h.service.confirmTotpEnrollment({
        session: h.ownerSession,
        code: hotp(second.secret, totpStep(h.clock.now)),
      }),
      "totp_already_enrolled",
    );
  });
});

describe("workspace access", () => {
  it("denies members of workspace A any context for workspace B", async () => {
    const h = await bootstrapped();
    await h.store.createWorkspace({ id: "ws_b", name: "B", createdAt: "2026-01-01T00:00:00Z" });
    for (const workspaceId of ["ws_b", "ws_missing"]) {
      await expectAuthError(
        h.service.resolveWorkspaceAccess({ session: h.ownerSession, workspaceId }),
        "workspace_access_denied",
      );
    }
    const member = await invitedMember(h, { email: "member@sona.test", role: "member" });
    await expectAuthError(
      h.service.resolveWorkspaceAccess({ session: member.session, workspaceId: "ws_b" }),
      "workspace_access_denied",
    );
  });

  it("derives the core workspace context with the user and request id", async () => {
    const h = await bootstrapped();
    const access = await h.service.resolveWorkspaceAccess({
      session: h.ownerSession,
      workspaceId: "ws_a",
      requestId: "req_42",
    });
    expect(access.context).toEqual({
      workspaceId: "ws_a",
      userId: h.owner.user.id,
      requestId: "req_42",
    });
    expect(access.principal).toEqual({ kind: "session", sessionId: h.ownerSession.session.id });
    expect(access.role).toBe("owner");
  });

  it("denies and audits an advisor's approval attempt", async () => {
    const h = await bootstrapped();
    const advisor = await invitedMember(h, {
      email: "advisor@steuerberater.test",
      role: "advisor_readonly",
    });
    await h.service.authorize(advisor.access, "read");
    await expectAuthError(h.service.authorize(advisor.access, "review_approve"), "forbidden");
    const denied = h.events.find((event) => event.action === "auth.permission.denied");
    expect(denied).toMatchObject({
      workspaceId: "ws_a",
      actor: advisor.user.id,
      metadata: { action: "review_approve", role: "advisor_readonly", principal: "session" },
    });
  });
});

describe("api tokens", () => {
  it("mints a hashed, workspace-bound token that resolves to capped agent access", async () => {
    const h = await bootstrapped();
    const { apiToken: token, token: secret } = await h.service.createApiToken({
      access: h.ownerAccess,
      name: "domovoi",
      scopes: ["read", "suggest"],
    });
    expect(secret.startsWith("sona_tok_")).toBe(true);
    expect(token).not.toHaveProperty("tokenHash");
    expect(token.expiresAt).toBe("2026-09-29T09:00:00.000Z");
    expect(h.store.apiTokens.get(token.id)?.tokenHash).not.toContain(secret.slice(9));

    const access = await h.service.resolveApiToken(secret, { requestId: "req_1" });
    expect(access.principal).toEqual({
      kind: "api_token",
      tokenId: token.id,
      scopes: ["read", "suggest"],
    });
    expect(access.context).toEqual({
      workspaceId: "ws_a",
      userId: h.owner.user.id,
      requestId: "req_1",
    });
    expect(access.grants).toEqual(["read", "write_draft"]);
    await expectAuthError(h.service.authorize(access, "review_approve"), "forbidden");
    await expectAuthError(h.service.authorize(access, "export"), "forbidden");
    await expectAuthError(h.service.authorize(access, "admin"), "forbidden");
    expect(h.store.apiTokens.get(token.id)?.lastUsedAt).toBe("2026-07-01T09:00:00.000Z");
  });

  it("refuses scopes beyond the creator's role and minting by agent tokens", async () => {
    const h = await bootstrapped();
    const advisor = await invitedMember(h, {
      email: "advisor@sona.test",
      role: "advisor_readonly",
    });
    await expectAuthError(
      h.service.createApiToken({ access: advisor.access, name: "x", scopes: ["execute"] }),
      "invalid_scope",
    );
    await expect(
      h.service.createApiToken({ access: advisor.access, name: "x", scopes: ["read"] }),
    ).resolves.toBeDefined();
    await expectAuthError(
      h.service.createApiToken({ access: h.ownerAccess, name: "x", scopes: [] }),
      "invalid_scope",
    );
    const { token: secret } = await h.service.createApiToken({
      access: h.ownerAccess,
      name: "agent",
      scopes: ["execute"],
    });
    const agent = await h.service.resolveApiToken(secret);
    await expectAuthError(
      h.service.createApiToken({ access: agent, name: "nested", scopes: ["read"] }),
      "forbidden",
    );
    await expectAuthError(
      h.service.createInvite({ access: agent, email: "z@sona.test", role: "member" }),
      "forbidden",
    );
  });

  it("stops working when revoked, expired, or when the creator leaves the workspace", async () => {
    const h = await bootstrapped();
    const member = await invitedMember(h, { email: "member@sona.test", role: "member" });
    const { apiToken: token, token: secret } = await h.service.createApiToken({
      access: member.access,
      name: "sync bot",
      scopes: ["execute"],
      ttlMs: DAY,
    });
    await expect(h.service.resolveApiToken(secret)).resolves.toBeDefined();

    // Another member cannot revoke it; the creator and the owner can.
    const other = await invitedMember(h, { email: "other@sona.test", role: "member" });
    await expectAuthError(
      h.service.revokeApiToken({ access: other.access, tokenId: token.id }),
      "forbidden",
    );
    await h.service.revokeApiToken({ access: h.ownerAccess, tokenId: token.id });
    await expectAuthError(h.service.resolveApiToken(secret), "api_token_invalid");
    await expectAuthError(
      h.service.revokeApiToken({ access: h.ownerAccess, tokenId: token.id }),
      "not_found",
    );

    const expiring = await h.service.createApiToken({
      access: member.access,
      name: "short",
      scopes: ["read"],
      ttlMs: HOUR,
    });
    h.clock.advance(HOUR);
    await expectAuthError(h.service.resolveApiToken(expiring.token), "api_token_invalid");

    const orphaned = await h.service.createApiToken({
      access: member.access,
      name: "orphan",
      scopes: ["read"],
    });
    h.store.memberships.splice(
      h.store.memberships.findIndex((m) => m.userId === member.user.id),
      1,
    );
    await expectAuthError(h.service.resolveApiToken(orphaned.token), "api_token_invalid");
    await expectAuthError(h.service.resolveApiToken("sona_sess_wrongkind"), "api_token_invalid");
    expect(actions(h.events, "ws_a")).toEqual(
      expect.arrayContaining(["auth.api_token.created", "auth.api_token.revoked"]),
    );
  });

  it("lists own tokens for members and every token for admins, hashes excluded", async () => {
    const h = await bootstrapped();
    const member = await invitedMember(h, { email: "member@sona.test", role: "member" });
    await h.service.createApiToken({ access: h.ownerAccess, name: "owner bot", scopes: ["read"] });
    await h.service.createApiToken({ access: member.access, name: "member bot", scopes: ["read"] });
    expect((await h.service.listApiTokens(member.access)).map((t) => t.name)).toEqual([
      "member bot",
    ]);
    const all = await h.service.listApiTokens(h.ownerAccess);
    expect(all.map((t) => t.name)).toEqual(["owner bot", "member bot"]);
    for (const token of all) {
      expect(token).not.toHaveProperty("tokenHash");
    }
  });

  it("touches lastUsedAt at most once a minute", async () => {
    const h = await bootstrapped();
    const { apiToken: token, token: secret } = await h.service.createApiToken({
      access: h.ownerAccess,
      name: "bot",
      scopes: ["read"],
    });
    const lastUsed = () => h.store.apiTokens.get(token.id)?.lastUsedAt;
    expect(lastUsed()).toBeUndefined();
    await h.service.resolveApiToken(secret);
    expect(lastUsed()).toBe("2026-07-01T09:00:00.000Z");
    h.clock.advance(30_000);
    await h.service.resolveApiToken(secret);
    expect(lastUsed()).toBe("2026-07-01T09:00:00.000Z");
    h.clock.advance(30_000);
    await h.service.resolveApiToken(secret);
    expect(lastUsed()).toBe("2026-07-01T09:01:00.000Z");
    h.clock.advance(59_000);
    await h.service.resolveApiToken(secret);
    expect(lastUsed()).toBe("2026-07-01T09:01:00.000Z");
  });

  it("caps grants by the creator's current role, not the role at minting", async () => {
    const h = await bootstrapped();
    const member = await invitedMember(h, { email: "member@sona.test", role: "member" });
    const { token: secret } = await h.service.createApiToken({
      access: member.access,
      name: "suggester",
      scopes: ["suggest"],
    });
    expect((await h.service.resolveApiToken(secret)).grants).toEqual(["read", "write_draft"]);

    const membership = h.store.memberships.find((m) => m.userId === member.user.id);
    if (membership === undefined) {
      throw new Error("membership missing");
    }
    membership.role = "advisor_readonly";
    const demoted = await h.service.resolveApiToken(secret);
    expect(demoted.role).toBe("advisor_readonly");
    expect(demoted.grants).toEqual(["read"]);
    expect(demoted.principal).toMatchObject({ scopes: ["suggest"] });
    await expectAuthError(h.service.authorize(demoted, "write_draft"), "forbidden");

    // Promotion never widens a token beyond its own scopes.
    membership.role = "owner";
    expect((await h.service.resolveApiToken(secret)).grants).toEqual(["read", "write_draft"]);
  });

  it("validates name, ttl, and scope vocabulary and de-duplicates scopes", async () => {
    const h = await bootstrapped();
    const create = (input: { name?: string; scopes?: readonly ApiTokenScope[]; ttlMs?: number }) =>
      h.service.createApiToken({
        access: h.ownerAccess,
        name: input.name ?? "bot",
        scopes: input.scopes ?? ["read"],
        ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
      });
    const invalid = (field: string) => ({ code: "invalid_input", details: [field] });
    await expect(create({ name: "   " })).rejects.toMatchObject(invalid("name"));
    await expect(create({ name: "n".repeat(101) })).rejects.toMatchObject(invalid("name"));
    await expect(create({ ttlMs: 0 })).rejects.toMatchObject(invalid("ttl"));
    await expect(create({ ttlMs: -DAY })).rejects.toMatchObject(invalid("ttl"));
    await expect(create({ scopes: ["admin" as ApiTokenScope] })).rejects.toMatchObject({
      code: "invalid_scope",
      details: ["admin"],
    });
    expect(h.store.apiTokens.size).toBe(0);
    expect(actions(h.events)).not.toContain("auth.api_token.created");

    const { apiToken: token } = await create({
      name: "  padded  ",
      scopes: ["read", "read", "suggest"],
    });
    expect(token.name).toBe("padded");
    expect(token.scopes).toEqual(["read", "suggest"]);
    const created = h.events.find((event) => event.action === "auth.api_token.created");
    expect(created?.metadata).toEqual({
      scopes: ["read", "suggest"],
      expiresAt: token.expiresAt,
    });
  });

  it("keeps tokens invisible and irrevocable from another workspace, and from agents", async () => {
    const h = await bootstrapped();
    const accessB = await secondWorkspace(h);
    const { apiToken: token, token: secret } = await h.service.createApiToken({
      access: accessB,
      name: "b bot",
      scopes: ["read"],
    });
    await expectAuthError(
      h.service.revokeApiToken({ access: h.ownerAccess, tokenId: token.id }),
      "not_found",
    );
    expect(await h.service.listApiTokens(h.ownerAccess)).toEqual([]);
    expect((await h.service.listApiTokens(accessB)).map((t) => t.id)).toEqual([token.id]);

    const agent = await h.service.resolveApiToken(secret);
    expect(agent.context.workspaceId).toBe("ws_b");
    await expect(
      h.service.revokeApiToken({ access: agent, tokenId: token.id }),
    ).rejects.toMatchObject({ code: "forbidden", details: ["api_token_cannot_revoke"] });
    await expect(h.service.listApiTokens(agent)).rejects.toMatchObject({
      code: "forbidden",
      details: ["api_token_cannot_list"],
    });
    await expect(h.service.resolveApiToken(secret)).resolves.toBeDefined();
    expect(actions(h.events)).not.toContain("auth.api_token.revoked");
  });

  it("caps the token lifetime at one year", async () => {
    const h = await bootstrapped();
    await expect(
      h.service.createApiToken({
        access: h.ownerAccess,
        name: "forever",
        scopes: ["read"],
        ttlMs: 400 * DAY,
      }),
    ).rejects.toMatchObject({ code: "invalid_input", details: ["ttl"] });
  });
});

describe("secret hygiene", () => {
  it("never leaks passwords, tokens, codes, or emails into errors or audit rows", async () => {
    const h = await bootstrapped({ systemAuditWorkspaceId: "ws_a" });
    const secrets = [OWNER_PASSWORD, h.ownerToken, "wrong-password-value-xyz"];
    const { token: inviteToken } = await h.service.createInvite({
      access: h.ownerAccess,
      email: "invitee@sona.test",
      role: "member",
    });
    const { token: apiSecret } = await h.service.createApiToken({
      access: h.ownerAccess,
      name: "bot",
      scopes: ["read"],
    });
    secrets.push(inviteToken, apiSecret);

    const failures: unknown[] = [];
    for (const attempt of [
      () => h.service.login({ email: "owner@sona.test", password: "wrong-password-value-xyz" }),
      () =>
        h.service.acceptInvite({
          token: inviteToken,
          password: "short",
          throttleKey: "client:test",
        }),
      () => h.service.resolveSession(`${h.ownerToken}tampered`),
      () => h.service.resolveApiToken(`${apiSecret}tampered`),
    ]) {
      await attempt().catch((error: unknown) => failures.push(error));
    }
    expect(failures).toHaveLength(4);

    const serialized = [
      ...failures.map((error) => JSON.stringify(error)),
      ...failures.map((error) => inspect(error)),
      ...failures.map((error) => String((error as Error).stack)),
      JSON.stringify(h.events),
    ].join("\n");
    for (const secret of secrets) {
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(secret.slice(-20));
    }
    expect(serialized).not.toContain("owner@sona.test");
    expect(serialized).not.toContain("invitee@sona.test");
    expect(JSON.parse(JSON.stringify(failures[0]))).toEqual({
      name: "AuthError",
      code: "invalid_credentials",
      message: "Invalid email or password",
      details: [],
    });
  });

  it("stores only hashes for invite, session, and API tokens", async () => {
    const h = await bootstrapped();
    const invite = await h.service.createInvite({
      access: h.ownerAccess,
      email: "i@sona.test",
      role: "member",
    });
    const api = await h.service.createApiToken({
      access: h.ownerAccess,
      name: "bot",
      scopes: ["read"],
    });
    const dump = JSON.stringify({
      invites: [...h.store.invites.values()],
      sessions: [...h.store.sessions.values()],
      apiTokens: [...h.store.apiTokens.values()],
      credentials: [...h.store.credentials.values()],
    });
    for (const secret of [invite.token, api.token, h.ownerToken, OWNER_PASSWORD]) {
      expect(dump).not.toContain(secret);
    }
  });
});

describe("default policy", () => {
  it("uses week-long idle and month-long absolute session lifetimes", () => {
    expect(DEFAULT_SESSION_POLICY).toEqual({
      idleTtlMs: 7 * DAY,
      absoluteTtlMs: 30 * DAY,
      renewIntervalMs: HOUR,
    });
  });
});

describe("audit routing and lockouts", () => {
  it("audits a lockout once and writes nothing while it lasts", async () => {
    const throttle = createFixedWindowThrottle({ maxFailures: 2, windowMs: 10 * MINUTE });
    const h = await bootstrapped({ throttle });
    const attempt = () =>
      h.service.login({ email: "owner@sona.test", password: "wrong password here" });
    await expectAuthError(attempt(), "invalid_credentials");
    await expectAuthError(attempt(), "invalid_credentials");
    const before = h.events.length;
    for (let index = 0; index < 5; index += 1) {
      await expectAuthError(attempt(), "rate_limited");
    }
    expect(h.events.length).toBe(before);
    const reasons = h.events
      .filter((event) => event.action === "auth.login.failed")
      .map((event) => (event.metadata as { reason: string }).reason);
    expect(reasons).toEqual(["invalid_password", "invalid_password", "rate_limited"]);
  });

  it("keeps a shared advisor's logins out of client workspaces", async () => {
    const h = await bootstrapped({ systemAuditWorkspaceId: "ws_ops" });
    const advisor = await invitedMember(h, {
      email: "advisor@steuerberater.test",
      role: "advisor_readonly",
    });
    const advisorLogins = h.events.filter(
      (event) => event.action === "auth.login.succeeded" && event.actor === advisor.user.id,
    );
    expect(advisorLogins.map((event) => event.workspaceId)).toEqual(["ws_ops"]);
    await h.service.logout(advisor.token);
    expect(actions(h.events, "ws_a")).not.toContain("auth.logout");
    expect(actions(h.events, "ws_ops")).toContain("auth.logout");
    // Workspace-scoped events about the advisor still land in the workspace.
    expect(actions(h.events, "ws_a")).toContain("auth.invite.accepted");
  });

  it("throttles and audits failed password checks when disabling TOTP", async () => {
    const throttle = createFixedWindowThrottle({ maxFailures: 2, windowMs: 10 * MINUTE });
    const h = await bootstrapped({ throttle });
    const start = await h.service.beginTotpEnrollment(h.ownerSession);
    await h.service.confirmTotpEnrollment({
      session: h.ownerSession,
      code: hotp(start.secret, totpStep(h.clock.now)),
    });
    const attempt = (password: string) =>
      h.service.disableTotp({ session: h.ownerSession, password });
    await expectAuthError(attempt("not the password"), "invalid_credentials");
    await expectAuthError(attempt("still not it here"), "invalid_credentials");
    await expectAuthError(attempt(OWNER_PASSWORD), "rate_limited");
    expect(await h.store.getTotpEnrollment(h.owner.user.id)).toBeDefined();
    expect(actions(h.events, "ws_a").filter((a) => a === "auth.totp.disable_denied")).toHaveLength(
      2,
    );
    // The login throttle is separate: the account itself is not locked.
    h.clock.advance(30_000);
    await expect(
      h.service.login({
        email: "owner@sona.test",
        password: OWNER_PASSWORD,
        secondFactor: { kind: "totp", code: hotp(start.secret, totpStep(h.clock.now)) },
      }),
    ).resolves.toBeDefined();
    h.clock.advance(10 * MINUTE);
    await attempt(OWNER_PASSWORD);
    expect(await h.store.getTotpEnrollment(h.owner.user.id)).toBeUndefined();
  });

  it("fails loudly when the system audit workspace does not exist", async () => {
    const h = harness({ systemAuditWorkspaceId: "ws_missing" });
    await h.service.bootstrapOwner({
      email: "owner@sona.test",
      password: OWNER_PASSWORD,
      workspaceName: "Solo",
      workspaceId: "ws_a",
    });
    // Both the unknown-email and the known-user path hit the same check, so a
    // misconfiguration cannot be used to tell accounts apart.
    await expect(
      h.service.login({ email: "owner@sona.test", password: OWNER_PASSWORD }),
    ).rejects.toThrow(/systemAuditWorkspaceId/);
    await expect(
      h.service.login({ email: "nobody@sona.test", password: OWNER_PASSWORD }),
    ).rejects.toThrow(/systemAuditWorkspaceId/);
  });
});
