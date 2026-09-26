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
import { AuthError, type AuthErrorCode } from "./errors.js";
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
  TOTP_STEP_UNUSED,
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
  type TotpEnrollment,
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
/** Write-coalescing for `last_used_at`, like `renewIntervalMs` for sessions. */
const API_TOKEN_TOUCH_INTERVAL_MS = MINUTE_MS;
const MAX_CLIENT_LABEL_LENGTH = 200;
const MAX_API_TOKEN_NAME_LENGTH = 100;

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
   * Workspace that receives user-level security events (logins, logouts,
   * session and 2FA changes) for every user, including login failures for
   * unknown emails which have no workspace of their own. Without it those
   * events are only visible in workspaces the user owns. Hosted deployments
   * point this at a platform-operations workspace; self-hosted deployments
   * can use the bootstrap workspace. Must exist in the store.
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

export const SECOND_FACTOR_KINDS = ["totp", "recovery_code"] as const;

export type SecondFactorKind = (typeof SECOND_FACTOR_KINDS)[number];

export interface SecondFactor {
  kind: SecondFactorKind;
  code: string;
}

export interface LoginInput {
  email: string;
  password: string;
  /** Required once the account has confirmed TOTP enrollment. */
  secondFactor?: SecondFactor;
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
  /** Throttle key for the anonymous caller, e.g. the client address. */
  throttleKey: string;
}

export interface AcceptInviteResult {
  user: AuthUser;
  membership: WorkspaceMembership;
}

export interface AcceptInviteAsUserInput {
  token: string;
  session: AuthenticatedSession;
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

export interface WorkspaceListing {
  workspace: Workspace;
  membership: WorkspaceMembership;
}

export interface RevokeSessionInput {
  session: AuthenticatedSession;
  sessionId: string;
}

export interface ResolveWorkspaceAccessInput {
  session: AuthenticatedSession;
  workspaceId: string;
  requestId?: string;
}

export interface ConfirmTotpEnrollmentInput {
  session: AuthenticatedSession;
  code: string;
}

export interface DisableTotpInput {
  session: AuthenticatedSession;
  /** Current password; re-verified so a hijacked session cannot weaken the account. */
  password: string;
}

export interface CreateApiTokenInput {
  access: WorkspaceAccess;
  name: string;
  scopes: readonly ApiTokenScope[];
  ttlMs?: number;
}

export interface CreateApiTokenResult {
  apiToken: ApiTokenView;
  /** Plaintext API token — show once. */
  token: string;
}

export interface RevokeApiTokenInput {
  access: WorkspaceAccess;
  tokenId: string;
}

export interface RevokeInviteInput {
  access: WorkspaceAccess;
  inviteId: string;
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
    throw new AuthError("invalid_input", ["email"]);
  }
  return parsed.data;
}

/**
 * Hashed once per service (fresh salt) and verified against for unknown
 * emails. Its value is irrelevant — only the KDF timing matters.
 */
const DUMMY_PASSWORD = "sona-timing-equalizer-password";

/** Public error per failure reason; credential and second-factor failures stay indistinguishable within their class. */
const LOGIN_FAILURE_ERROR_CODE = {
  unknown_email: "invalid_credentials",
  invalid_password: "invalid_credentials",
  totp_required: "totp_required",
  invalid_totp: "invalid_totp",
  invalid_recovery_code: "invalid_totp",
  rate_limited: "rate_limited",
} as const satisfies Record<LoginFailureReason, AuthErrorCode>;

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
  #systemWorkspaceChecked: Promise<void> | undefined;
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
    const workspaceName = input.workspaceName.trim();
    if (workspaceName === "") {
      throw new AuthError("invalid_input", ["workspace_name"]);
    }
    const now = this.#timestamp();
    const workspace: Workspace = {
      id: input.workspaceId ?? this.#id("workspace"),
      name: workspaceName,
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
    await this.authorize(input.access, "admin");
    if (!isWorkspaceRole(input.role)) {
      throw new AuthError("invalid_input", ["role"]);
    }
    const email = normalizeEmail(input.email);
    const ttlMs = input.ttlMs ?? this.#inviteTtlMs;
    assertTtl(ttlMs, Number.POSITIVE_INFINITY);
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
    await this.authorize(access, "admin");
    const invites = await this.#store.listInvites(access.context.workspaceId);
    return invites.map(stripHash);
  }

  async revokeInvite(input: RevokeInviteInput): Promise<void> {
    await this.authorize(input.access, "admin");
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
    if (!this.#throttle.allows(input.throttleKey, now)) {
      throw new AuthError("rate_limited");
    }
    const invite = await this.#openInvite(input.token, now, input.throttleKey);
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
    this.#throttle.reset(input.throttleKey);
    return { user, membership };
  }

  /**
   * An existing, signed-in user accepting an invite issued to their email.
   * Not throttled: the caller is already authenticated, so guessing is
   * bounded by the session rather than anonymous.
   */
  async acceptInviteAsUser(input: AcceptInviteAsUserInput): Promise<WorkspaceMembership> {
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
    if (input.clientLabel !== undefined && input.clientLabel.length > MAX_CLIENT_LABEL_LENGTH) {
      throw new AuthError("invalid_input", ["client_label"]);
    }
    const throttleKeys = [`email:${email}`, ...(input.throttleKey ? [input.throttleKey] : [])];
    if (!throttleKeys.every((key) => this.#throttle.allows(key, now))) {
      // Locked out: no KDF, no lookup, and no audit row — the lockout itself
      // was recorded when it began, so repeated attempts cannot flood the log.
      throw new AuthError("rate_limited");
    }
    const fail = async (user: AuthUser | undefined, reason: LoginFailureReason): Promise<never> => {
      for (const key of throttleKeys) {
        this.#throttle.recordFailure(key, now);
      }
      await this.#recordLoginFailure(user, reason);
      if (!throttleKeys.every((key) => this.#throttle.allows(key, now))) {
        await this.#recordLoginFailure(user, "rate_limited");
      }
      throw new AuthError(LOGIN_FAILURE_ERROR_CODE[reason]);
    };

    const user = await this.#store.getUserByEmail(email);
    const credential = user === undefined ? undefined : await this.#store.getCredential(user.id);
    const passwordOk = await this.#verifyPasswordBounded(
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
      if (input.secondFactor === undefined) {
        // Correct password, second factor pending: recorded but not throttled.
        await this.#recordLoginFailure(user, "totp_required");
        throw new AuthError("totp_required");
      }
      const verified = await this.#verifySecondFactor(user, enrollment, input.secondFactor, now);
      if (verified.ok) {
        method = verified.method;
      } else {
        return fail(user, verified.reason);
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
    await this.#recordAcrossUserWorkspaces(user.id, {
      action: "auth.login.succeeded",
      actor: user.id,
      targetType: "auth_session",
      targetId: session.id,
      metadata: { method },
    });
    return { user, session, token, method };
  }

  async #verifySecondFactor(
    user: AuthUser,
    enrollment: TotpEnrollment,
    factor: SecondFactor,
    now: Date,
  ): Promise<{ ok: true; method: LoginMethod } | { ok: false; reason: LoginFailureReason }> {
    switch (factor.kind) {
      case "recovery_code": {
        const codeHash = hashToken(normalizeRecoveryCode(factor.code));
        if (!(await this.#store.consumeRecoveryCode(user.id, codeHash, now.toISOString()))) {
          return { ok: false, reason: "invalid_recovery_code" };
        }
        await this.#recordAcrossUserWorkspaces(user.id, {
          action: "auth.recovery_code.used",
          actor: user.id,
          targetType: "user",
          targetId: user.id,
          metadata: { remaining: await this.#store.countUnusedRecoveryCodes(user.id) },
        });
        return { ok: true, method: "password_recovery_code" };
      }
      case "totp": {
        const result = verifyTotp(
          this.#cipher.decrypt(enrollment.secretCiphertext),
          factor.code,
          now,
          {
            window: this.#totpWindow,
            afterStep: enrollment.lastUsedStep,
          },
        );
        // Advance the replay floor before issuing anything; a lost race means a retry, not a replay.
        if (!result.ok || !(await this.#store.advanceTotpStep(user.id, result.step))) {
          return { ok: false, reason: "invalid_totp" };
        }
        return { ok: true, method: "password_totp" };
      }
    }
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
      await this.#recordAcrossUserWorkspaces(session.userId, {
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

  async revokeSession(input: RevokeSessionInput): Promise<void> {
    const userId = input.session.user.id;
    if (!(await this.#store.revokeSession(userId, input.sessionId, this.#timestamp()))) {
      throw new AuthError("not_found");
    }
    await this.#recordAcrossUserWorkspaces(userId, {
      action: "auth.session.revoked",
      actor: userId,
      targetType: "auth_session",
      targetId: input.sessionId,
    });
  }

  async revokeAllSessions(session: AuthenticatedSession): Promise<number> {
    const userId = session.user.id;
    const count = await this.#store.revokeAllSessions(userId, this.#timestamp());
    await this.#recordAcrossUserWorkspaces(userId, {
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
  async resolveWorkspaceAccess(input: ResolveWorkspaceAccessInput): Promise<WorkspaceAccess> {
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

  /** Workspaces the user belongs to, with names, for a workspace switcher. */
  async listWorkspaces(session: AuthenticatedSession): Promise<WorkspaceListing[]> {
    const memberships = await this.#store.listMemberships(session.user.id);
    const listings: WorkspaceListing[] = [];
    for (const membership of memberships) {
      const workspace = await this.#store.getWorkspace(membership.workspaceId);
      if (workspace !== undefined) {
        listings.push({ workspace, membership });
      }
    }
    return listings;
  }

  /** Permission check that audits denials; the single enforcement path for web and MCP. */
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
      lastUsedStep: TOTP_STEP_UNUSED,
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

  async confirmTotpEnrollment(input: ConfirmTotpEnrollmentInput): Promise<TotpEnrollmentConfirmed> {
    const userId = input.session.user.id;
    const now = this.#now();
    const enrollment = await this.#store.getTotpEnrollment(userId);
    if (enrollment === undefined) {
      throw new AuthError("totp_not_enrolled");
    }
    if (enrollment.confirmedAt !== undefined) {
      throw new AuthError("totp_already_enrolled");
    }
    const result = verifyTotp(this.#cipher.decrypt(enrollment.secretCiphertext), input.code, now, {
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
    await this.#recordAcrossUserWorkspaces(userId, {
      action: "auth.totp.enabled",
      actor: userId,
      targetType: "user",
      targetId: userId,
    });
    return { recoveryCodes };
  }

  /** Password re-check is throttled and audited like a login, so a hijacked session cannot guess freely. */
  async disableTotp(input: DisableTotpInput): Promise<void> {
    const userId = input.session.user.id;
    const now = this.#now();
    const throttleKey = `totp_disable:${userId}`;
    if (!this.#throttle.allows(throttleKey, now)) {
      throw new AuthError("rate_limited");
    }
    const credential = await this.#store.getCredential(userId);
    if (
      credential === undefined ||
      !(await this.#verifyPasswordBounded(input.password, credential.passwordHash))
    ) {
      this.#throttle.recordFailure(throttleKey, now);
      await this.#recordAcrossUserWorkspaces(userId, {
        action: "auth.totp.disable_denied",
        actor: userId,
        targetType: "user",
        targetId: userId,
        metadata: { reason: "invalid_password" },
      });
      throw new AuthError("invalid_credentials");
    }
    if ((await this.#store.getTotpEnrollment(userId)) === undefined) {
      throw new AuthError("totp_not_enrolled");
    }
    await this.#store.deleteTotpEnrollment(userId);
    await this.#store.replaceRecoveryCodes(userId, []);
    this.#throttle.reset(throttleKey);
    await this.#recordAcrossUserWorkspaces(userId, {
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
    const scopes = uniqueScopes(input.scopes);
    for (const scope of scopes) {
      if (!SCOPE_GRANTS[scope].every((action) => can(access, action))) {
        throw new AuthError("invalid_scope", [scope]);
      }
    }
    const name = input.name.trim();
    if (name === "" || name.length > MAX_API_TOKEN_NAME_LENGTH) {
      throw new AuthError("invalid_input", ["name"]);
    }
    const ttlMs = input.ttlMs ?? DEFAULT_API_TOKEN_TTL_MS;
    assertTtl(ttlMs, MAX_API_TOKEN_TTL_MS);
    const now = this.#now();
    const token = generateToken("api_token");
    const apiToken: ApiToken = {
      id: this.#id("api_token"),
      workspaceId: access.context.workspaceId,
      createdByUserId: requireUserId(access),
      name,
      tokenHash: hashToken(token),
      scopes,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      lastUsedAt: undefined,
      revokedAt: undefined,
    };
    await this.#store.createApiToken(apiToken);
    await this.#record({
      workspaceId: apiToken.workspaceId,
      action: "auth.api_token.created",
      actor: auditActor(access),
      targetType: "api_token",
      targetId: apiToken.id,
      metadata: { scopes: [...scopes], expiresAt: apiToken.expiresAt },
    });
    return { apiToken: stripHash(apiToken), token };
  }

  /**
   * Resolves an agent token to workspace access. The creator must still be a
   * member; grants are the token scopes capped by the creator's current role.
   */
  async resolveApiToken(
    token: string,
    options: { requestId?: string } = {},
  ): Promise<WorkspaceAccess> {
    const now = this.#now();
    const apiToken = await findByToken(token, "api_token", (hash) =>
      this.#store.getApiTokenByHash(hash),
    );
    if (
      apiToken === undefined ||
      apiToken.revokedAt !== undefined ||
      isExpired(apiToken.expiresAt, now)
    ) {
      throw new AuthError("api_token_invalid");
    }
    const membership = await this.#store.getMembership(
      apiToken.workspaceId,
      apiToken.createdByUserId,
    );
    if (membership === undefined) {
      throw new AuthError("api_token_invalid");
    }
    if (
      apiToken.lastUsedAt === undefined ||
      now.getTime() - Date.parse(apiToken.lastUsedAt) >= API_TOKEN_TOUCH_INTERVAL_MS
    ) {
      await this.#store.touchApiToken(apiToken.id, now.toISOString());
    }
    return createApiTokenAccess({
      membership,
      tokenId: apiToken.id,
      scopes: apiToken.scopes,
      requestId: options.requestId,
    });
  }

  /** Admins see every token of the workspace; other members see their own. Agents see none. */
  async listApiTokens(access: WorkspaceAccess): Promise<ApiTokenView[]> {
    if (access.principal.kind !== "session") {
      throw new AuthError("forbidden", ["api_token_cannot_list"]);
    }
    const tokens = await this.#store.listApiTokens(access.context.workspaceId);
    const seesAll = can(access, "admin");
    const userId = access.context.userId;
    return tokens.filter((token) => seesAll || token.createdByUserId === userId).map(stripHash);
  }

  /** The creator or an admin may revoke; agent tokens cannot revoke tokens. */
  async revokeApiToken(input: RevokeApiTokenInput): Promise<void> {
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

  /** Over-long passwords can never match a policy-checked hash; skip the KDF instead of feeding it. */
  async #verifyPasswordBounded(password: string, passwordHash: string): Promise<boolean> {
    if ([...password].length > this.#passwordPolicy.maxLength) {
      return false;
    }
    return verifyPassword(password, passwordHash);
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

  /**
   * User-level events are written to the system audit workspace (when
   * configured) and to every workspace the user *owns*. They are deliberately
   * not mirrored into workspaces where the user is only a member or advisor:
   * one client's workspace must not see when a shared advisor logs in for
   * another client.
   */
  async #recordAcrossUserWorkspaces(
    userId: string,
    input: Omit<AuthAuditInput, "workspaceId">,
  ): Promise<void> {
    const memberships = await this.#store.listMemberships(userId);
    const workspaceIds = new Set(
      memberships.filter((m) => m.role === "owner").map((m) => m.workspaceId),
    );
    const systemWorkspaceId = await this.#systemAuditWorkspace();
    if (systemWorkspaceId !== undefined) {
      workspaceIds.add(systemWorkspaceId);
    }
    for (const workspaceId of workspaceIds) {
      await this.#record({ ...input, workspaceId });
    }
  }

  async #recordLoginFailure(user: AuthUser | undefined, reason: LoginFailureReason): Promise<void> {
    const metadata: Record<string, JsonValue> = { reason };
    if (user !== undefined) {
      await this.#recordAcrossUserWorkspaces(user.id, {
        action: "auth.login.failed",
        actor: user.id,
        targetType: "user",
        targetId: user.id,
        metadata,
      });
      return;
    }
    const systemWorkspaceId = await this.#systemAuditWorkspace();
    if (systemWorkspaceId !== undefined) {
      await this.#record({
        workspaceId: systemWorkspaceId,
        action: "auth.login.failed",
        actor: ANONYMOUS_ACTOR,
        metadata,
      });
    }
  }

  /**
   * Verifies once that the configured system audit workspace exists, so a
   * misconfiguration surfaces on the first login of any kind instead of only
   * on unknown-email failures (which would make them distinguishable).
   */
  async #systemAuditWorkspace(): Promise<string | undefined> {
    const workspaceId = this.#systemAuditWorkspaceId;
    if (workspaceId === undefined) {
      return undefined;
    }
    this.#systemWorkspaceChecked ??= this.#store.getWorkspace(workspaceId).then((workspace) => {
      if (workspace === undefined) {
        this.#systemWorkspaceChecked = undefined;
        throw new Error("systemAuditWorkspaceId does not reference an existing workspace");
      }
    });
    await this.#systemWorkspaceChecked;
    return workspaceId;
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

/** Fails closed: an unparseable timestamp counts as expired. */
function isExpired(isoTimestamp: string, now: Date): boolean {
  return !(Date.parse(isoTimestamp) > now.getTime());
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

/** Caller-supplied lifetimes are input faults, not configuration errors. */
function assertTtl(ttlMs: number, maxMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > maxMs) {
    throw new AuthError("invalid_input", ["ttl"]);
  }
}

function assertPositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive number of milliseconds`);
  }
}
