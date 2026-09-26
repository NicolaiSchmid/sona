import type { AuditEvent, JsonValue } from "@sona/core";

/**
 * Auth-related audit actions. Metadata is limited to identifiers, roles,
 * scopes, and literal reason codes — never emails, passwords, tokens, codes,
 * or secrets.
 */
export const AUTH_AUDIT_ACTIONS = [
  "auth.bootstrap.completed",
  "auth.login.succeeded",
  "auth.login.failed",
  "auth.logout",
  "auth.session.revoked",
  "auth.sessions.revoked_all",
  "auth.invite.created",
  "auth.invite.accepted",
  "auth.invite.revoked",
  "auth.totp.enabled",
  "auth.totp.disabled",
  "auth.totp.disable_denied",
  "auth.recovery_code.used",
  "auth.api_token.created",
  "auth.api_token.revoked",
  "auth.permission.denied",
] as const;

export type AuthAuditAction = (typeof AUTH_AUDIT_ACTIONS)[number];

export const LOGIN_FAILURE_REASONS = [
  "unknown_email",
  "invalid_password",
  "totp_required",
  "invalid_totp",
  "invalid_recovery_code",
  "rate_limited",
] as const;

export type LoginFailureReason = (typeof LOGIN_FAILURE_REASONS)[number];

/** Anonymous actor for events before a user is identified. */
export const ANONYMOUS_ACTOR = "anonymous";

/**
 * Structural match for `SqliteAuditEventRepository.append`, so the db
 * repository can be passed directly without an adapter.
 */
export interface AuditSink {
  append(event: AuditEvent): Promise<void>;
}

export interface AuthAuditInput {
  workspaceId: string;
  action: AuthAuditAction;
  actor: string;
  targetType?: string;
  targetId?: string;
  metadata?: Readonly<Record<string, JsonValue>>;
}

export function createAuthAuditEvent(
  input: AuthAuditInput,
  id: string,
  createdAt: string,
): AuditEvent {
  return {
    id,
    workspaceId: input.workspaceId,
    action: input.action,
    actor: input.actor,
    ...(input.targetType === undefined ? {} : { targetType: input.targetType }),
    ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
    ...(input.metadata === undefined ? {} : { metadata: { ...input.metadata } }),
    createdAt,
  };
}
