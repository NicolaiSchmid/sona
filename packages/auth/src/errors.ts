export const AUTH_ERROR_CODES = [
  "invalid_credentials",
  "totp_required",
  "invalid_totp",
  "totp_not_enrolled",
  "totp_already_enrolled",
  "invite_invalid",
  "invite_expired",
  "invite_used",
  "invite_email_mismatch",
  "email_taken",
  "password_policy",
  "session_invalid",
  "workspace_access_denied",
  "forbidden",
  "api_token_invalid",
  "invalid_scope",
  "rate_limited",
  "not_found",
  "invalid_input",
] as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

const DEFAULT_MESSAGES: Record<AuthErrorCode, string> = {
  invalid_credentials: "Invalid email or password",
  totp_required: "A one-time code is required to complete sign-in",
  invalid_totp: "Invalid one-time code",
  totp_not_enrolled: "Two-factor authentication is not enrolled",
  totp_already_enrolled: "Two-factor authentication is already enrolled",
  invite_invalid: "Invite is invalid",
  invite_expired: "Invite has expired",
  invite_used: "Invite has already been used",
  invite_email_mismatch: "Invite was issued to a different email address",
  email_taken: "An account with this email already exists",
  password_policy: "Password does not meet the password policy",
  session_invalid: "Session is invalid or expired",
  workspace_access_denied: "Workspace access denied",
  forbidden: "Action not permitted for this role or token",
  api_token_invalid: "API token is invalid, expired, or revoked",
  invalid_scope: "Requested scope is not permitted",
  rate_limited: "Too many attempts; try again later",
  not_found: "Not found",
  invalid_input: "Invalid input",
};

/**
 * Error surfaced to callers. Messages are fixed per code and never echo the
 * input (passwords, tokens, codes, emails), so they can be serialized into
 * logs and HTTP responses. `details` is for non-secret, machine-readable
 * hints such as password-policy violations or the offending `invalid_input`
 * field name. Configuration mistakes throw plain `Error`/`RangeError` instead,
 * so adapters can map `AuthError` to 4xx and everything else to 5xx.
 */
export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly details: readonly string[];

  constructor(code: AuthErrorCode, details: readonly string[] = []) {
    super(DEFAULT_MESSAGES[code]);
    this.name = "AuthError";
    this.code = code;
    this.details = details;
  }

  toJSON(): { name: string; code: AuthErrorCode; message: string; details: readonly string[] } {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

export function isAuthError(error: unknown, code?: AuthErrorCode): error is AuthError {
  return error instanceof AuthError && (code === undefined || error.code === code);
}
