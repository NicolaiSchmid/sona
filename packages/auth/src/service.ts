import { randomUUID } from "node:crypto";
import type { JsonValue } from "@sona/core";
import { z } from "zod";
import {
  ANONYMOUS_ACTOR,
  type AuditSink,
  type AuthAuditInput,
  createAuthAuditEvent,
  type LoginFailureReason,
} from "./audit.js";
import {
  assertCan,
  auditActor,
  can,
  createApiTokenAccess,
  createSessionAccess,
  SCOPE_GRANTS,
  type WorkspaceAccess,
} from "./authorization.js";
import {
  constantTimeEqual,
  generateToken,
  hashToken,
  type SecretCipher,
  TOKEN_PREFIXES,
  type TokenKind,
} from "./crypto.js";
import { AuthError } from "./errors.js";
import {
  checkPasswordPolicy,
  DEFAULT_PASSWORD_POLICY,
  DEFAULT_SCRYPT_PARAMS,
  hashPassword,
  type PasswordPolicy,
  passwordHashNeedsRehash,
  type ScryptParams,
  verifyPassword,
} from "./passwords.js";
import { type AttemptThrottle, createFixedWindowThrottle } from "./rate-limit.js";
import {
  generateRecoveryCodes,
  generateTotpSecret,
  normalizeRecoveryCode,
  totpProvisioningUri,
  verifyTotp,
} from "./totp.js";
import {
  type ApiToken,
  type ApiTokenScope,
  type AuthSession,
  type AuthStore,
  type AuthUser,
  isApiTokenScope,
  isWorkspaceRole,
  type Workspace,
  type WorkspaceAction,
  type WorkspaceInvite,
  type WorkspaceMembership,
  type WorkspaceRole,
} from "./types.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export interface SessionPolicy {
  /** Inactivity window; renewed on activity. */
  idleTtlMs: number;
  /** Hard lifetime since login. */
  absoluteTtlMs: number;
  /** Minimum time between renewal writes, to avoid one UPDATE per request. */
  renewIntervalMs: number;
}

export const DEFAULT_SESSION_POLICY = {
  idleTtlMs: 7 * DAY_MS,
  absoluteTtlMs: 30 * DAY_MS,
  renewIntervalMs: HOUR_MS,
} as const satisfies SessionPolicy;

export const DEFAULT_INVITE_TTL_MS = 7 * DAY_MS;
export const DEFAULT_API_TOKEN_TTL_MS = 90 * DAY_MS;
export const MAX_API_TOKEN_TTL_MS = 365 * DAY_MS;
const API_TOKEN_TOUCH_INTERVAL_MS = MINUTE_MS;

export const ID_KINDS = [
  "user",
  "workspace",
  "session",
  "invite",
  "api_token",
  "recovery_code",
  "audit",
] as const;

export type IdKind = (typeof ID_KINDS)[number];

const ID_PREFIXES = {
  user: "user",
  workspace: "ws",
  session: "ses",
  invite: "inv",
  api_token: "tok",
  recovery_code: "rc",
  audit: "audit",
} as const satisfies Record<IdKind, string>;

export interface AuthServiceOptions {
  store: AuthStore;
  audit: AuditSink;
  /** Encrypts TOTP secrets at rest; see `createAesGcmSecretCipher`. */
  secretCipher: SecretCipher;
  now?: () => Date;
  idFactory?: (kind: IdKind) => string;
  scrypt?: ScryptParams;
  passwordPolicy?: PasswordPolicy;
  sessionPolicy?: SessionPolicy;
  inviteTtlMs?: number;
  /** Accepted TOTP steps on either side of "now"; default 1 (±30 s). */
  totpWindow?: number;
  /** Issuer shown in authenticator apps. */
  totpIssuer?: string;
  throttle?: AttemptThrottle;
  /**
   * Workspace that additionally receives user-level security events, including
   * login failures for unknown emails which have no workspace of their own.
   * Hosted deployments point this at a platform-operations workspace.
   */
  systemAuditWorkspaceId?: string;
}

/** Public view of a session: no token hash. */
export type SessionView = Omit<AuthSession, "tokenHash">;
export type InviteView = Omit<WorkspaceInvite, "tokenHash">;
export type ApiTokenView = Omit<ApiToken, "tokenHash">;

export interface AuthenticatedSession {
  user: AuthUser;
  session: SessionView;
}

export const LOGIN_METHODS = ["password", "password_totp", "password_recovery_code"] as const;

export type LoginMethod = (typeof LOGIN_METHODS)[number];

export interface LoginInput {
  email: string;
  password: string;
  totpCode?: string;
  recoveryCode?: string;
  /** Redacted device/browser label shown in the session list. */
  clientLabel?: string;
  /** Throttle key, e.g. the client address; the normalized email is always throttled too. */
  throttleKey?: string;
}

export interface LoginResult {
  user: AuthUser;
  session: SessionView;
  /** Plaintext session token — return it to the client once, never store it. */
  token: string;
  method: LoginMethod;
}

export interface CreateInviteInput {
  access: WorkspaceAccess;
  email: string;
  role: WorkspaceRole;
  ttlMs?: number;
}

export interface CreateInviteResult {
  invite: InviteView;
  /** Plaintext invite token to deliver out of band; never persisted. */
  token: string;
}

export interface AcceptInviteInput {
  token: string;
  password: string;
  throttleKey?: string;
}

export interface AcceptInviteResult {
  user: AuthUser;
  membership: WorkspaceMembership;
}

export interface BootstrapOwnerInput {
  email: string;
  password: string;
  workspaceName: string;
  workspaceId?: string;
}

export interface BootstrapOwnerResult {
  user: AuthUser;
  workspace: Workspace;
  membership: WorkspaceMembership;
}

export interface CreateApiTokenInput {
  access: WorkspaceAccess;
  name: string;
  scopes: readonly ApiTokenScope[];
  ttlMs?: number;
}

export interface CreateApiTokenResult {
  token: ApiTokenView;
  /** Plaintext API token — show once. */
  secret: string;
}

export interface TotpEnrollmentStart {
  /** Base32 secret for manual entry; also embedded in `otpauthUri`. */
  secret: string;
  otpauthUri: string;
}

export interface TotpEnrollmentConfirmed {
  /** Plaintext recovery codes — show once. */
  recoveryCodes: readonly string[];
}

const emailSchema = z.string().trim().toLowerCase().email().max(254);

export function normalizeEmail(email: string): string {
  const parsed = emailSchema.safeParse(email);
  if (!parsed.success) {
    throw new AuthError("invalid_credentials", ["invalid_email"]);
  }
  return parsed.data;
}

const DUMMY_PASSWORD = "sona-timing-equalizer-password";

/**
 * Invite-only authentication, sessions, TOTP, workspace access, and scoped
 * API tokens over an `AuthStore`. Every security-relevant transition writes
 * an audit event with identifiers only.
 */
export class AuthService {
  readonly #store: AuthStore;
  readonly #audit: AuditSink;
  readonly #cipher: SecretCipher;
  readonly #now: () => Date;
  readonly #id: (kind: IdKind) => string;
  readonly #scrypt: ScryptParams;
  readonly #passwordPolicy: PasswordPolicy;
  readonly #sessionPolicy: SessionPolicy;
  readonly #inviteTtlMs: number;
  readonly #totpWindow: number;
  readonly #totpIssuer: string;
  readonly #throttle: AttemptThrottle;
  readonly #systemAuditWorkspaceId: string | undefined;
  #dummyHash: Promise<string> | undefined;

  constructor(options: AuthServiceOptions) {
    this.#store = options.store;
    this.#audit = options.audit;
    this.#cipher = options.secretCipher;
    this.#now = options.now ?? (() => new Date());
    this.#id = options.idFactory ?? ((kind) => `${ID_PREFIXES[kind]}_${randomUUID()}`);
    this.#scrypt = options.scrypt ?? DEFAULT_SCRYPT_PARAMS;
    this.#passwordPolicy = options.passwordPolicy ?? DEFAULT_PASSWORD_POLICY;
    this.#sessionPolicy = options.sessionPolicy ?? DEFAULT_SESSION_POLICY;
    this.#inviteTtlMs = options.inviteTtlMs ?? DEFAULT_INVITE_TTL_MS;
    this.#totpWindow = options.totpWindow ?? 1;
    this.#totpIssuer = options.totpIssuer ?? "Sona";
    this.#throttle = options.throttle ?? createFixedWindowThrottle();
    this.#systemAuditWorkspaceId = options.systemAuditWorkspaceId;
    assertPositive(this.#sessionPolicy.idleTtlMs, "sessionPolicy.idleTtlMs");
    assertPositive(this.#sessionPolicy.absoluteTtlMs, "sessionPolicy.absoluteTtlMs");
    assertPositive(this.#inviteTtlMs, "inviteTtlMs");
  }

  // --- Bootstrap --------------------------------------------------------------

  /**
   * Self-hosted single-user mode: creates the first owner and workspace from
   * config on an empty database. Returns undefined when any user exists.
   */
  async bootstrapOwner(input: BootstrapOwnerInput): Promise<BootstrapOwnerResult | undefined> {
    if ((await this.#store.countUsers()) > 0) {
      return undefined;
    }
    const email = normalizeEmail(input.email);
    this.#assertPasswordPolicy(input.password, email);
    if (input.workspaceName.trim() === "") {
      throw new Error("workspaceName is required");
    }
    const now = this.#timestamp();
    const workspace: Workspace = {
      id: input.workspaceId ?? this.#id("workspace"),
      name: input.workspaceName.trim(),
      createdAt: now,
    };
    const user: AuthUser = { id: this.#id("user"), email, createdAt: now };
    const membership: WorkspaceMembership = {
      workspaceId: workspace.id,
      userId: user.id,
      role: "owner",
      createdAt: now,
    };
    const passwordHash = await hashPassword(input.password, this.#scrypt);
    await this.#store.createWorkspace(workspace);
    await this.#store.createUser(user, { userId: user.id, passwordHash, updatedAt: now });
    await this.#store.createMembership(membership);
    await this.#record({
      workspaceId: workspace.id,
      action: "auth.bootstrap.completed",
      actor: user.id,
      targetType: "user",
      targetId: user.id,
    });
    return { user, workspace, membership };
  }

  // --- Invites ----------------------------------------------------------------

  async createInvite(input: CreateInviteInput): Promise<CreateInviteResult> {
    assertCan(input.access, "admin");
    if (!isWorkspaceRole(input.role)) {
      throw new Error("Unknown workspace role");
    }
    const email = normalizeEmail(input.email);
    const ttlMs = input.ttlMs ?? this.#inviteTtlMs;
    assertPositive(ttlMs, "invite ttlMs");
    const now = this.#now();
    const token = generateToken("invite");
    const invite: WorkspaceInvite = {
      id: this.#id("invite"),
      workspaceId: input.access.context.workspaceId,
      email,
      role: input.role,
      tokenHash: hashToken(token),
      createdByUserId: requireUserId(input.access),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      acceptedAt: undefined,
      acceptedByUserId: undefined,
      revokedAt: undefined,
    };
    await this.#store.createInvite(invite);
    await this.#record({
      workspaceId: invite.workspaceId,
      action: "auth.invite.created",
      actor: auditActor(input.access),
      targetType: "workspace_invite",
      targetId: invite.id,
      metadata: { role: invite.role, expiresAt: invite.expiresAt },
    });
    return { invite: stripHash(invite), token };
  }

  async listInvites(access: WorkspaceAccess): Promise<InviteView[]> {
    assertCan(access, "admin");
    const invites = await this.#store.listInvites(access.context.workspaceId);
    return invites.map(stripHash);
  }

  async revokeInvite(input: { access: WorkspaceAccess; inviteId: string }): Promise<void> {
    assertCan(input.access, "admin");
    const workspaceId = input.access.context.workspaceId;
    const revoked = await this.#store.revokeInvite(workspaceId, input.inviteId, this.#timestamp());
    if (!revoked) {
      throw new AuthError("not_found");
    }
    await this.#record({
      workspaceId,
      action: "auth.invite.revoked",
      actor: auditActor(input.access),
      targetType: "workspace_invite",
      targetId: input.inviteId,
    });
  }

  /** Signup: a new account for the invited email, joining the inviting workspace. */
  async acceptInvite(input: AcceptInviteInput): Promise<AcceptInviteResult> {
    const now = this.#now();
    const throttleKey = input.throttleKey ?? "invite";
    if (!this.#throttle.allows(throttleKey, now)) {
      throw new AuthError("rate_limited");
    }
    const invite = await this.#openInvite(input.token, now, throttleKey);
    this.#assertPasswordPolicy(input.password, invite.email);
    if ((await this.#store.getUserByEmail(invite.email)) !== undefined) {
      throw new AuthError("email_taken");
    }
    const passwordHash = await hashPassword(input.password, this.#scrypt);
    const timestamp = now.toISOString();
    const user: AuthUser = { id: this.#id("user"), email: invite.email, createdAt: timestamp };
    // Claim first: the conditional update is the single-use guard. If account
    // creation fails afterwards the invite is burned, which fails safe.
    if (!(await this.#store.claimInvite(invite.id, timestamp, user.id))) {
      throw new AuthError("invite_used");
    }
    await this.#store.createUser(user, { userId: user.id, passwordHash, updatedAt: timestamp });
    const membership = await this.#joinFromInvite(invite, user, timestamp);
    this.#throttle.reset(throttleKey);
    return { user, membership };
  }

  /** An existing, signed-in user accepting an invite issued to their email. */
  async acceptInviteAsUser(input: {
    token: string;
    session: AuthenticatedSession;
  }): Promise<WorkspaceMembership> {
    const now = this.#now();
    const invite = await this.#openInvite(input.token, now, undefined);
    if (!constantTimeEqual(invite.email, input.session.user.email)) {
      throw new AuthError("invite_email_mismatch");
    }
    if (
      (await this.#store.getMembership(invite.workspaceId, input.session.user.id)) !== undefined
    ) {
      throw new AuthError("invite_invalid", ["already_member"]);
    }
    const timestamp = now.toISOString();
    if (!(await this.#store.claimInvite(invite.id, timestamp, input.session.user.id))) {
      throw new AuthError("invite_used");
    }
    return this.#joinFromInvite(invite, input.session.user, timestamp);
  }

  async #openInvite(
    token: string,
    now: Date,
    throttleKey: string | undefined,
  ): Promise<WorkspaceInvite> {
    const fail = (code: "invite_invalid" | "invite_expired" | "invite_used"): never => {
      if (throttleKey !== undefined) {
        this.#throttle.recordFailure(throttleKey, now);
      }
      throw new AuthError(code);
    };
    const invite = await findByToken(token, "invite", (hash) =>
      this.#store.getInviteByTokenHash(hash),
    );
    if (invite === undefined || invite.revokedAt !== undefined) {
      return fail("invite_invalid");
    }
    if (invite.acceptedAt !== undefined) {
      return fail("invite_used");
    }
    if (isExpired(invite.expiresAt, now)) {
      return fail("invite_expired");
    }
    return invite;
  }

  async #joinFromInvite(
    invite: WorkspaceInvite,
    user: AuthUser,
    timestamp: string,
  ): Promise<WorkspaceMembership> {
    const membership: WorkspaceMembership = {
      workspaceId: invite.workspaceId,
      userId: user.id,
      role: invite.role,
      createdAt: timestamp,
    };
    await this.#store.createMembership(membership);
    await this.#record({
      workspaceId: invite.workspaceId,
      action: "auth.invite.accepted",
      actor: user.id,
      targetType: "workspace_invite",
      targetId: invite.id,
      metadata: { role: invite.role },
    });
    return membership;
  }

  // --- Login and sessions -----------------------------------------------------

  async login(input: LoginInput): Promise<LoginResult> {
    const now = this.#now();
    let email: string;
    try {
      email = normalizeEmail(input.email);
    } catch {
      await this.#recordLoginFailure(undefined, "unknown_email");
      throw new AuthError("invalid_credentials");
    }
    const throttleKeys = [`email:${email}`, ...(input.throttleKey ? [input.throttleKey] : [])];
    if (!throttleKeys.every((key) => this.#throttle.allows(key, now))) {
      const user = await this.#store.getUserByEmail(email);
      await this.#recordLoginFailure(user, "rate_limited");
      throw new AuthError("rate_limited");
    }
    const fail = async (user: AuthUser | undefined, reason: LoginFailureReason): Promise<never> => {
      for (const key of throttleKeys) {
        this.#throttle.recordFailure(key, now);
      }
      await this.#recordLoginFailure(user, reason);
      throw new AuthError(
        reason === "unknown_email" || reason === "invalid_password"
          ? "invalid_credentials"
          : "invalid_totp",
      );
    };

    const user = await this.#store.getUserByEmail(email);
    const credential = user === undefined ? undefined : await this.#store.getCredential(user.id);
    // Always run the KDF so unknown emails take as long as wrong passwords.
    const passwordOk = await verifyPassword(
      input.password,
      credential?.passwordHash ?? (await this.#dummyPasswordHash()),
    );
    if (user === undefined || credential === undefined) {
      return fail(undefined, "unknown_email");
    }
    if (!passwordOk) {
      return fail(user, "invalid_password");
    }

    let method: LoginMethod = "password";
    const enrollment = await this.#store.getTotpEnrollment(user.id);
    if (enrollment?.confirmedAt !== undefined) {
      if (input.recoveryCode !== undefined) {
        const codeHash = hashToken(normalizeRecoveryCode(input.recoveryCode));
        if (!(await this.#store.consumeRecoveryCode(user.id, codeHash, now.toISOString()))) {
          return fail(user, "invalid_recovery_code");
        }
        await this.#recordForUser(user.id, {
          action: "auth.recovery_code.used",
          actor: user.id,
          targetType: "user",
          targetId: user.id,
          metadata: { remaining: await this.#store.countUnusedRecoveryCodes(user.id) },
        });
        method = "password_recovery_code";
      } else if (input.totpCode !== undefined) {
        const secret = this.#cipher.decrypt(enrollment.secretCiphertext);
        const result = verifyTotp(secret, input.totpCode, now, {
          window: this.#totpWindow,
          afterStep: enrollment.lastUsedStep,
        });
        if (!result.ok || !(await this.#store.advanceTotpStep(user.id, result.step))) {
          return fail(user, "invalid_totp");
        }
        method = "password_totp";
      } else {
        // Correct password, second factor pending: not a throttled failure.
        await this.#recordLoginFailure(user, "totp_required");
        throw new AuthError("totp_required");
      }
    }

    if (passwordHashNeedsRehash(credential.passwordHash, this.#scrypt)) {
      await this.#store.updateCredential({
        userId: user.id,
        passwordHash: await hashPassword(input.password, this.#scrypt),
        updatedAt: now.toISOString(),
      });
    }
    for (const key of throttleKeys) {
      this.#throttle.reset(key);
    }
    const { session, token } = await this.#createSession(user.id, now, input.clientLabel);
    await this.#recordForUser(user.id, {
      action: "auth.login.succeeded",
      actor: user.id,
      targetType: "auth_session",
      targetId: session.id,
      metadata: { method },
    });
    return { user, session, token, method };
  }

  async #createSession(
    userId: string,
    now: Date,
    clientLabel: string | undefined,
  ): Promise<{ session: SessionView; token: string }> {
    const token = generateToken("session");
    const absoluteExpiresAt = now.getTime() + this.#sessionPolicy.absoluteTtlMs;
    const session: AuthSession = {
      id: this.#id("session"),
      userId,
      tokenHash: hashToken(token),
      createdAt: now.toISOString(),
      expiresAt: this.#slidingExpiry(now, absoluteExpiresAt),
      absoluteExpiresAt: new Date(absoluteExpiresAt).toISOString(),
      lastSeenAt: now.toISOString(),
      revokedAt: undefined,
      clientLabel,
    };
    await this.#store.createSession(session);
    return { session: stripHash(session), token };
  }

  /** Validates a session token, applies sliding renewal, and returns the user. */
  async resolveSession(token: string): Promise<AuthenticatedSession> {
    const now = this.#now();
    const session = await findByToken(token, "session", (hash) =>
      this.#store.getSessionByTokenHash(hash),
    );
    if (session === undefined || !isSessionActive(session, now)) {
      throw new AuthError("session_invalid");
    }
    const user = await this.#store.getUserById(session.userId);
    if (user === undefined) {
      throw new AuthError("session_invalid");
    }
    let current = session;
    if (now.getTime() - Date.parse(session.lastSeenAt) >= this.#sessionPolicy.renewIntervalMs) {
      const expiresAt = this.#slidingExpiry(now, Date.parse(session.absoluteExpiresAt));
      await this.#store.renewSession(session.id, expiresAt, now.toISOString());
      current = { ...session, expiresAt, lastSeenAt: now.toISOString() };
    }
    return { user, session: stripHash(current) };
  }

  /** Idempotent: unknown or already-revoked tokens are silently ignored. */
  async logout(token: string): Promise<void> {
    const session = await findByToken(token, "session", (hash) =>
      this.#store.getSessionByTokenHash(hash),
    );
    if (session === undefined) {
      return;
    }
    if (await this.#store.revokeSession(session.userId, session.id, this.#timestamp())) {
      await this.#recordForUser(session.userId, {
        action: "auth.logout",
        actor: session.userId,
        targetType: "auth_session",
        targetId: session.id,
      });
    }
  }

  /** Active (unrevoked, unexpired) sessions of the signed-in user. */
  async listSessions(session: AuthenticatedSession): Promise<SessionView[]> {
    const now = this.#now();
    const sessions = await this.#store.listSessions(session.user.id);
    return sessions.filter((entry) => isSessionActive(entry, now)).map(stripHash);
  }

  async revokeSession(input: { session: AuthenticatedSession; sessionId: string }): Promise<void> {
    const userId = input.session.user.id;
    if (!(await this.#store.revokeSession(userId, input.sessionId, this.#timestamp()))) {
      throw new AuthError("not_found");
    }
    await this.#recordForUser(userId, {
      action: "auth.session.revoked",
      actor: userId,
      targetType: "auth_session",
      targetId: input.sessionId,
    });
  }

  async revokeAllSessions(session: AuthenticatedSession): Promise<number> {
    const userId = session.user.id;
    const count = await this.#store.revokeAllSessions(userId, this.#timestamp());
    await this.#recordForUser(userId, {
      action: "auth.sessions.revoked_all",
      actor: userId,
      targetType: "user",
      targetId: userId,
      metadata: { count },
    });
    return count;
  }

  // --- Workspace access -------------------------------------------------------

  /** Binds a session to one workspace; non-members are denied without revealing whether it exists. */
  async resolveWorkspaceAccess(input: {
    session: AuthenticatedSession;
    workspaceId: string;
    requestId?: string;
  }): Promise<WorkspaceAccess> {
    const membership = await this.#store.getMembership(input.workspaceId, input.session.user.id);
    if (membership === undefined) {
      throw new AuthError("workspace_access_denied");
    }
    return createSessionAccess({
      membership,
      sessionId: input.session.session.id,
      requestId: input.requestId,
    });
  }

  async listWorkspaces(session: AuthenticatedSession): Promise<WorkspaceMembership[]> {
    return this.#store.listMemberships(session.user.id);
  }

  /** Permission check that audits denials, for review-gate and admin paths. */
  async authorize(access: WorkspaceAccess, action: WorkspaceAction): Promise<void> {
    if (can(access, action)) {
      return;
    }
    await this.#record({
      workspaceId: access.context.workspaceId,
      action: "auth.permission.denied",
      actor: auditActor(access),
      metadata: { action, role: access.role, principal: access.principal.kind },
    });
    throw new AuthError("forbidden", [action]);
  }

  // --- TOTP -------------------------------------------------------------------

  async beginTotpEnrollment(session: AuthenticatedSession): Promise<TotpEnrollmentStart> {
    const userId = session.user.id;
    const existing = await this.#store.getTotpEnrollment(userId);
    if (existing?.confirmedAt !== undefined) {
      throw new AuthError("totp_already_enrolled");
    }
    const secret = generateTotpSecret();
    await this.#store.saveTotpEnrollment({
      userId,
      secretCiphertext: this.#cipher.encrypt(secret),
      lastUsedStep: -1,
      createdAt: this.#timestamp(),
      confirmedAt: undefined,
    });
    return {
      secret,
      otpauthUri: totpProvisioningUri({
        secretBase32: secret,
        accountName: session.user.email,
        issuer: this.#totpIssuer,
      }),
    };
  }

  async confirmTotpEnrollment(
    session: AuthenticatedSession,
    code: string,
  ): Promise<TotpEnrollmentConfirmed> {
    const userId = session.user.id;
    const now = this.#now();
    const enrollment = await this.#store.getTotpEnrollment(userId);
    if (enrollment === undefined) {
      throw new AuthError("totp_not_enrolled");
    }
    if (enrollment.confirmedAt !== undefined) {
      throw new AuthError("totp_already_enrolled");
    }
    const result = verifyTotp(this.#cipher.decrypt(enrollment.secretCiphertext), code, now, {
      window: this.#totpWindow,
      afterStep: enrollment.lastUsedStep,
    });
    if (!result.ok || !(await this.#store.advanceTotpStep(userId, result.step))) {
      throw new AuthError("invalid_totp");
    }
    const timestamp = now.toISOString();
    const recoveryCodes = generateRecoveryCodes();
    await this.#store.replaceRecoveryCodes(
      userId,
      recoveryCodes.map((plain) => ({
        id: this.#id("recovery_code"),
        userId,
        codeHash: hashToken(normalizeRecoveryCode(plain)),
        createdAt: timestamp,
        usedAt: undefined,
      })),
    );
    await this.#store.confirmTotpEnrollment(userId, timestamp);
    await this.#recordForUser(userId, {
      action: "auth.totp.enabled",
      actor: userId,
      targetType: "user",
      targetId: userId,
    });
    return { recoveryCodes };
  }

  /** Requires the current password so a hijacked session cannot silently weaken the account. */
  async disableTotp(session: AuthenticatedSession, password: string): Promise<void> {
    const userId = session.user.id;
    const credential = await this.#store.getCredential(userId);
    if (credential === undefined || !(await verifyPassword(password, credential.passwordHash))) {
      throw new AuthError("invalid_credentials");
    }
    if ((await this.#store.getTotpEnrollment(userId)) === undefined) {
      throw new AuthError("totp_not_enrolled");
    }
    await this.#store.deleteTotpEnrollment(userId);
    await this.#store.replaceRecoveryCodes(userId, []);
    await this.#recordForUser(userId, {
      action: "auth.totp.disabled",
      actor: userId,
      targetType: "user",
      targetId: userId,
    });
  }

  // --- API tokens -------------------------------------------------------------

  /**
   * Mints a workspace-bound agent token. Only a human session may mint, and
   * every requested scope must be within the creator's own role, so a token
   * never carries rights its creator lacks.
   */
  async createApiToken(input: CreateApiTokenInput): Promise<CreateApiTokenResult> {
    const { access } = input;
    if (access.principal.kind !== "session") {
      throw new AuthError("forbidden", ["api_token_cannot_mint"]);
    }
    assertCan(access, "read");
    const scopes = uniqueScopes(input.scopes);
    for (const scope of scopes) {
      if (!SCOPE_GRANTS[scope].every((action) => can(access, action))) {
        throw new AuthError("invalid_scope", [scope]);
      }
    }
    const name = input.name.trim();
    if (name === "" || name.length > 100) {
      throw new Error("API token name must be 1-100 characters");
    }
    const ttlMs = input.ttlMs ?? DEFAULT_API_TOKEN_TTL_MS;
    assertPositive(ttlMs, "api token ttlMs");
    if (ttlMs > MAX_API_TOKEN_TTL_MS) {
      throw new RangeError("api token ttlMs exceeds the one-year maximum");
    }
    const now = this.#now();
    const secret = generateToken("apiToken");
    const token: ApiToken = {
      id: this.#id("api_token"),
      workspaceId: access.context.workspaceId,
      createdByUserId: requireUserId(access),
      name,
      tokenHash: hashToken(secret),
      scopes,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      lastUsedAt: undefined,
      revokedAt: undefined,
    };
    await this.#store.createApiToken(token);
    await this.#record({
      workspaceId: token.workspaceId,
      action: "auth.api_token.created",
      actor: auditActor(access),
      targetType: "api_token",
      targetId: token.id,
      metadata: { name: token.name, scopes: [...scopes], expiresAt: token.expiresAt },
    });
    return { token: stripHash(token), secret };
  }

  /**
   * Resolves an agent token to workspace access. The creator must still be a
   * member; grants are the token scopes capped by the creator's current role.
   */
  async resolveApiToken(
    secret: string,
    options: { requestId?: string } = {},
  ): Promise<WorkspaceAccess> {
    const now = this.#now();
    const token = await findByToken(secret, "apiToken", (hash) =>
      this.#store.getApiTokenByHash(hash),
    );
    if (token === undefined || token.revokedAt !== undefined || isExpired(token.expiresAt, now)) {
      throw new AuthError("api_token_invalid");
    }
    const membership = await this.#store.getMembership(token.workspaceId, token.createdByUserId);
    if (membership === undefined) {
      throw new AuthError("api_token_invalid");
    }
    if (
      token.lastUsedAt === undefined ||
      now.getTime() - Date.parse(token.lastUsedAt) >= API_TOKEN_TOUCH_INTERVAL_MS
    ) {
      await this.#store.touchApiToken(token.id, now.toISOString());
    }
    return createApiTokenAccess({
      membership,
      tokenId: token.id,
      scopes: token.scopes,
      requestId: options.requestId,
    });
  }

  /** Admins see every token of the workspace; other members see their own. */
  async listApiTokens(access: WorkspaceAccess): Promise<ApiTokenView[]> {
    assertCan(access, "read");
    const tokens = await this.#store.listApiTokens(access.context.workspaceId);
    const seesAll = can(access, "admin");
    const userId = access.context.userId;
    return tokens.filter((token) => seesAll || token.createdByUserId === userId).map(stripHash);
  }

  /** The creator or an admin may revoke; agent tokens cannot revoke tokens. */
  async revokeApiToken(input: { access: WorkspaceAccess; tokenId: string }): Promise<void> {
    const { access } = input;
    if (access.principal.kind !== "session") {
      throw new AuthError("forbidden", ["api_token_cannot_revoke"]);
    }
    const workspaceId = access.context.workspaceId;
    const token = await this.#store.getApiToken(workspaceId, input.tokenId);
    if (token === undefined) {
      throw new AuthError("not_found");
    }
    if (!can(access, "admin") && token.createdByUserId !== access.context.userId) {
      throw new AuthError("forbidden", ["admin"]);
    }
    if (!(await this.#store.revokeApiToken(workspaceId, token.id, this.#timestamp()))) {
      throw new AuthError("not_found");
    }
    await this.#record({
      workspaceId,
      action: "auth.api_token.revoked",
      actor: auditActor(access),
      targetType: "api_token",
      targetId: token.id,
    });
  }

  // --- Internals --------------------------------------------------------------

  #timestamp(): string {
    return this.#now().toISOString();
  }

  /** Idle expiry from `now`, never past the session's absolute cap. */
  #slidingExpiry(now: Date, absoluteExpiresAtMs: number): string {
    return new Date(
      Math.min(now.getTime() + this.#sessionPolicy.idleTtlMs, absoluteExpiresAtMs),
    ).toISOString();
  }

  #dummyPasswordHash(): Promise<string> {
    this.#dummyHash ??= hashPassword(DUMMY_PASSWORD, this.#scrypt);
    return this.#dummyHash;
  }

  #assertPasswordPolicy(password: string, email: string): void {
    const result = checkPasswordPolicy(password, { email }, this.#passwordPolicy);
    if (!result.ok) {
      throw new AuthError("password_policy", result.violations);
    }
  }

  async #record(input: AuthAuditInput): Promise<void> {
    await this.#audit.append(createAuthAuditEvent(input, this.#id("audit"), this.#timestamp()));
  }

  /** User-level events fan out to every workspace the user belongs to, plus the system workspace. */
  async #recordForUser(userId: string, input: Omit<AuthAuditInput, "workspaceId">): Promise<void> {
    const memberships = await this.#store.listMemberships(userId);
    const workspaceIds = new Set(memberships.map((membership) => membership.workspaceId));
    if (this.#systemAuditWorkspaceId !== undefined) {
      workspaceIds.add(this.#systemAuditWorkspaceId);
    }
    for (const workspaceId of workspaceIds) {
      await this.#record({ ...input, workspaceId });
    }
  }

  async #recordLoginFailure(user: AuthUser | undefined, reason: LoginFailureReason): Promise<void> {
    const metadata: Record<string, JsonValue> = { reason };
    if (user === undefined) {
      if (this.#systemAuditWorkspaceId !== undefined) {
        await this.#record({
          workspaceId: this.#systemAuditWorkspaceId,
          action: "auth.login.failed",
          actor: ANONYMOUS_ACTOR,
          metadata,
        });
      }
      return;
    }
    await this.#recordForUser(user.id, {
      action: "auth.login.failed",
      actor: user.id,
      targetType: "user",
      targetId: user.id,
      metadata,
    });
  }
}

/**
 * Looks a bearer token up by its digest. The store already keys on the hash;
 * the constant-time re-compare is defence in depth against a lookup that
 * matches loosely (collation, trimming) and keeps the reject path timing-flat.
 */
async function findByToken<T extends { tokenHash: string }>(
  token: string,
  kind: TokenKind,
  lookup: (hash: string) => Promise<T | undefined>,
): Promise<T | undefined> {
  if (!token.startsWith(TOKEN_PREFIXES[kind])) {
    return undefined;
  }
  const hash = hashToken(token);
  const record = await lookup(hash);
  return record !== undefined && constantTimeEqual(record.tokenHash, hash) ? record : undefined;
}

function isExpired(isoTimestamp: string, now: Date): boolean {
  return Date.parse(isoTimestamp) <= now.getTime();
}

function isSessionActive(session: AuthSession, now: Date): boolean {
  return (
    session.revokedAt === undefined &&
    !isExpired(session.expiresAt, now) &&
    !isExpired(session.absoluteExpiresAt, now)
  );
}

function stripHash<T extends { tokenHash: string }>(record: T): Omit<T, "tokenHash"> {
  const { tokenHash: _tokenHash, ...rest } = record;
  return rest;
}

function requireUserId(access: WorkspaceAccess): string {
  const userId = access.context.userId;
  if (userId === undefined) {
    throw new AuthError("forbidden", ["user_required"]);
  }
  return userId;
}

function uniqueScopes(scopes: readonly ApiTokenScope[]): readonly ApiTokenScope[] {
  const unique = [...new Set(scopes)];
  if (unique.length === 0) {
    throw new AuthError("invalid_scope", ["empty"]);
  }
  for (const scope of unique) {
    if (!isApiTokenScope(scope)) {
      throw new AuthError("invalid_scope", [String(scope)]);
    }
  }
  return unique;
}

function assertPositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive number of milliseconds`);
  }
}
