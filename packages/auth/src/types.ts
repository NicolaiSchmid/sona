/**
 * Domain types for invite-only authentication, sessions, workspace membership,
 * and scoped API tokens.
 *
 * Nothing in this module holds a plaintext secret: passwords are stored as
 * KDF strings, tokens (invite, session, API) as SHA-256 digests, TOTP secrets
 * as ciphertext, and recovery codes as digests. Plaintext token values exist
 * only in the return value of the call that created them.
 */

// --- Roles, actions, scopes ---------------------------------------------------

export const WORKSPACE_ROLES = ["owner", "member", "advisor_readonly"] as const;

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export function isWorkspaceRole(value: string): value is WorkspaceRole {
  return (WORKSPACE_ROLES as readonly string[]).includes(value);
}

/**
 * Coarse permission vocabulary checked by the shared service layer so web and
 * MCP inherit the same rules.
 *
 * - `read`: view ledger, review queues, documents, exports.
 * - `write_draft`: create drafts/suggestions, upload documents, trigger syncs.
 * - `review_approve`: move records through review states.
 * - `export`: generate tax-ready export packages.
 * - `admin`: manage members, invites, and API tokens.
 */
export const WORKSPACE_ACTIONS = [
  "read",
  "write_draft",
  "review_approve",
  "export",
  "admin",
] as const;

export type WorkspaceAction = (typeof WORKSPACE_ACTIONS)[number];

export const API_TOKEN_SCOPES = ["read", "suggest", "execute"] as const;

export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

export function isApiTokenScope(value: string): value is ApiTokenScope {
  return (API_TOKEN_SCOPES as readonly string[]).includes(value);
}

// --- Records ------------------------------------------------------------------

export interface AuthUser {
  id: string;
  /** Normalized (trimmed, lower-cased) address. */
  email: string;
  createdAt: string;
}

export interface UserCredential {
  userId: string;
  /** PHC-style scrypt string from `hashPassword`; never the password itself. */
  passwordHash: string;
  updatedAt: string;
}

export interface Workspace {
  id: string;
  name: string;
  createdAt: string;
}

export interface WorkspaceMembership {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  createdAt: string;
}

export interface WorkspaceInvite {
  id: string;
  workspaceId: string;
  /** Normalized invitee address. */
  email: string;
  role: WorkspaceRole;
  /** SHA-256 hex of the plaintext invite token. */
  tokenHash: string;
  createdByUserId: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | undefined;
  acceptedByUserId: string | undefined;
  revokedAt: string | undefined;
}

export interface AuthSession {
  id: string;
  userId: string;
  /** SHA-256 hex of the plaintext session token. */
  tokenHash: string;
  createdAt: string;
  /** Sliding expiry, renewed on activity up to `absoluteExpiresAt`. */
  expiresAt: string;
  /** Hard cap after which the session is invalid regardless of activity. */
  absoluteExpiresAt: string;
  lastSeenAt: string;
  revokedAt: string | undefined;
  /** Redacted, user-facing device/browser label supplied by the web layer. */
  clientLabel: string | undefined;
}

export interface TotpEnrollment {
  userId: string;
  /** AES-256-GCM ciphertext of the base32 secret, produced by a `SecretCipher`. */
  secretCiphertext: string;
  /** Highest RFC 6238 time step accepted so far; codes at or below it are replays. */
  lastUsedStep: number;
  createdAt: string;
  /** Set once the user proved possession with a valid code; unconfirmed enrollments are not enforced. */
  confirmedAt: string | undefined;
}

export interface RecoveryCode {
  id: string;
  userId: string;
  /** SHA-256 hex of the normalized plaintext code. */
  codeHash: string;
  createdAt: string;
  usedAt: string | undefined;
}

export interface ApiToken {
  id: string;
  workspaceId: string;
  createdByUserId: string;
  name: string;
  /** SHA-256 hex of the plaintext token. */
  tokenHash: string;
  scopes: readonly ApiTokenScope[];
  createdAt: string;
  /** Always set: agent tokens must not live forever. */
  expiresAt: string;
  lastUsedAt: string | undefined;
  revokedAt: string | undefined;
}

// --- Store interfaces ---------------------------------------------------------
//
// Implemented by `@sona/db` (SQLite) and by the in-memory store in
// `./testing.ts`. Methods that guard a single-use or monotonic transition
// return whether the conditional update applied, so the guard is enforced by
// the store's atomic update rather than by a read-then-write in the service.

export interface UserStore {
  createUser(user: AuthUser, credential: UserCredential): Promise<void>;
  getUserById(userId: string): Promise<AuthUser | undefined>;
  getUserByEmail(email: string): Promise<AuthUser | undefined>;
  getCredential(userId: string): Promise<UserCredential | undefined>;
  updateCredential(credential: UserCredential): Promise<void>;
  countUsers(): Promise<number>;
}

export interface WorkspaceMembershipStore {
  createWorkspace(workspace: Workspace): Promise<void>;
  createMembership(membership: WorkspaceMembership): Promise<void>;
  getMembership(workspaceId: string, userId: string): Promise<WorkspaceMembership | undefined>;
  listMemberships(userId: string): Promise<WorkspaceMembership[]>;
}

export interface InviteStore {
  createInvite(invite: WorkspaceInvite): Promise<void>;
  getInviteByTokenHash(tokenHash: string): Promise<WorkspaceInvite | undefined>;
  getInvite(workspaceId: string, inviteId: string): Promise<WorkspaceInvite | undefined>;
  listInvites(workspaceId: string): Promise<WorkspaceInvite[]>;
  /** Claims an open invite; returns false if it was already accepted or revoked. */
  claimInvite(inviteId: string, acceptedAt: string, acceptedByUserId: string): Promise<boolean>;
  revokeInvite(workspaceId: string, inviteId: string, revokedAt: string): Promise<boolean>;
}

export interface SessionStore {
  createSession(session: AuthSession): Promise<void>;
  getSessionByTokenHash(tokenHash: string): Promise<AuthSession | undefined>;
  getSession(userId: string, sessionId: string): Promise<AuthSession | undefined>;
  listSessions(userId: string): Promise<AuthSession[]>;
  renewSession(sessionId: string, expiresAt: string, lastSeenAt: string): Promise<void>;
  revokeSession(userId: string, sessionId: string, revokedAt: string): Promise<boolean>;
  /** Revokes every active session of the user; returns how many were revoked. */
  revokeAllSessions(userId: string, revokedAt: string): Promise<number>;
}

export interface TotpStore {
  getTotpEnrollment(userId: string): Promise<TotpEnrollment | undefined>;
  /** Inserts or replaces the user's enrollment (re-enrolling discards the old secret). */
  saveTotpEnrollment(enrollment: TotpEnrollment): Promise<void>;
  confirmTotpEnrollment(userId: string, confirmedAt: string): Promise<void>;
  deleteTotpEnrollment(userId: string): Promise<void>;
  /** Advances the replay counter; returns false if `step` is not strictly newer. */
  advanceTotpStep(userId: string, step: number): Promise<boolean>;
  replaceRecoveryCodes(userId: string, codes: readonly RecoveryCode[]): Promise<void>;
  /** Marks an unused recovery code as used; returns false if none matched. */
  consumeRecoveryCode(userId: string, codeHash: string, usedAt: string): Promise<boolean>;
  countUnusedRecoveryCodes(userId: string): Promise<number>;
}

export interface ApiTokenStore {
  createApiToken(token: ApiToken): Promise<void>;
  getApiTokenByHash(tokenHash: string): Promise<ApiToken | undefined>;
  getApiToken(workspaceId: string, tokenId: string): Promise<ApiToken | undefined>;
  listApiTokens(workspaceId: string): Promise<ApiToken[]>;
  touchApiToken(tokenId: string, lastUsedAt: string): Promise<void>;
  revokeApiToken(workspaceId: string, tokenId: string, revokedAt: string): Promise<boolean>;
}

export interface AuthStore
  extends UserStore,
    WorkspaceMembershipStore,
    InviteStore,
    SessionStore,
    TotpStore,
    ApiTokenStore {}
