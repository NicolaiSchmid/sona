/**
 * @sona/auth
 *
 * Invite-only authentication, sessions, TOTP, workspace membership roles, and
 * scoped API tokens for agents. Pure library: `@sona/db` implements the
 * `AuthStore` interfaces, and the web/MCP layers bind sessions and tokens to
 * a `WorkspaceAccess` whose `context` is the core `WorkspaceContext`.
 *
 * Decision record: a small hand-rolled core over Node built-ins (scrypt,
 * HMAC, AES-GCM, timing-safe compare) was chosen over an auth framework so
 * password hashing, session semantics, and token scoping are testable in
 * isolation, carry no native dependencies, and stay portable between the
 * SQLite and PostgreSQL backends. OIDC/passkeys remain a follow-up.
 */

/** Package version marker, used to verify wiring and test discovery. */
export const sonaAuthVersion = "0.0.0" as const;

export {
  ANONYMOUS_ACTOR,
  AUTH_AUDIT_ACTIONS,
  type AuditSink,
  type AuthAuditAction,
  type AuthAuditInput,
  createAuthAuditEvent,
  LOGIN_FAILURE_REASONS,
  type LoginFailureReason,
} from "./audit.js";
export {
  type ApiTokenPrincipal,
  auditActor,
  can,
  createApiTokenAccess,
  createSessionAccess,
  grantsForRole,
  grantsForScopes,
  type Principal,
  ROLE_GRANTS,
  SCOPE_GRANTS,
  type SessionPrincipal,
  type WorkspaceAccess,
} from "./authorization.js";
export {
  clearSessionCookie,
  DEFAULT_SESSION_COOKIE_NAME,
  readCookie,
  SAME_SITE_MODES,
  type SameSiteMode,
  type SessionCookieAttributes,
  type SessionCookieOptions,
  serializeCookie,
  sessionCookie,
} from "./cookies.js";
export {
  constantTimeEqual,
  createAesGcmSecretCipher,
  generateToken,
  hashToken,
  type SecretCipher,
  TOKEN_PREFIXES,
  type TokenKind,
} from "./crypto.js";
export { AUTH_ERROR_CODES, AuthError, type AuthErrorCode, isAuthError } from "./errors.js";
export {
  checkPasswordPolicy,
  DEFAULT_PASSWORD_POLICY,
  DEFAULT_SCRYPT_PARAMS,
  hashPassword,
  PASSWORD_POLICY_VIOLATIONS,
  type PasswordPolicy,
  type PasswordPolicyResult,
  type PasswordPolicyViolation,
  passwordHashNeedsRehash,
  type ScryptParams,
  verifyPassword,
} from "./passwords.js";
export {
  type AttemptThrottle,
  createFixedWindowThrottle,
  DEFAULT_LOGIN_THROTTLE,
  type FixedWindowThrottleOptions,
  NO_THROTTLE,
} from "./rate-limit.js";
export {
  type AcceptInviteAsUserInput,
  type AcceptInviteInput,
  type AcceptInviteResult,
  type ApiTokenView,
  type AuthenticatedSession,
  AuthService,
  type AuthServiceOptions,
  type BootstrapOwnerInput,
  type BootstrapOwnerResult,
  type ConfirmTotpEnrollmentInput,
  type CreateApiTokenInput,
  type CreateApiTokenResult,
  type CreateInviteInput,
  type CreateInviteResult,
  DEFAULT_API_TOKEN_TTL_MS,
  DEFAULT_INVITE_TTL_MS,
  DEFAULT_SESSION_POLICY,
  type DisableTotpInput,
  ID_KINDS,
  type IdKind,
  type InviteView,
  LOGIN_METHODS,
  type LoginInput,
  type LoginMethod,
  type LoginResult,
  MAX_API_TOKEN_TTL_MS,
  normalizeEmail,
  type ResolveWorkspaceAccessInput,
  type RevokeApiTokenInput,
  type RevokeInviteInput,
  type RevokeSessionInput,
  SECOND_FACTOR_KINDS,
  type SecondFactor,
  type SecondFactorKind,
  type SessionPolicy,
  type SessionView,
  type TotpEnrollmentConfirmed,
  type TotpEnrollmentStart,
  type WorkspaceListing,
} from "./service.js";
export { InMemoryAuthStore } from "./testing.js";
export {
  generateRecoveryCodes,
  generateTotpSecret,
  normalizeRecoveryCode,
  RECOVERY_CODE_COUNT,
  TOTP_PARAMS,
  TOTP_STEP_UNUSED,
  type TotpVerification,
  totp,
  totpProvisioningUri,
  verifyTotp,
} from "./totp.js";
export {
  API_TOKEN_SCOPES,
  type ApiToken,
  type ApiTokenScope,
  type ApiTokenStore,
  type AuthSession,
  type AuthStore,
  type AuthUser,
  type InviteStore,
  isApiTokenScope,
  isWorkspaceRole,
  type RecoveryCode,
  type SessionStore,
  type TotpEnrollment,
  type TotpStore,
  type UserCredential,
  type UserStore,
  WORKSPACE_ACTIONS,
  WORKSPACE_ROLES,
  type Workspace,
  type WorkspaceAction,
  type WorkspaceInvite,
  type WorkspaceMembership,
  type WorkspaceMembershipStore,
  type WorkspaceRole,
} from "./types.js";
