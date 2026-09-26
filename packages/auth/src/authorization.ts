import { createWorkspaceContext, type WorkspaceContext } from "@sona/core";
import { AuthError } from "./errors.js";
import {
  type ApiTokenScope,
  WORKSPACE_ACTIONS,
  type WorkspaceAction,
  type WorkspaceMembership,
  type WorkspaceRole,
} from "./types.js";

/**
 * What each role may do. `advisor_readonly` can look at everything (review
 * queues, ledger, exports) but never approve, mutate, or administer.
 */
export const ROLE_GRANTS: Readonly<Record<WorkspaceRole, readonly WorkspaceAction[]>> = {
  owner: WORKSPACE_ACTIONS,
  member: ["read", "write_draft", "review_approve", "export"],
  advisor_readonly: ["read"],
};

/**
 * What each API token scope may do. No scope maps to `review_approve` or
 * `admin`: agent tokens can suggest and run jobs, never approve tax-relevant
 * decisions or manage access (phase-15 session-origin rule).
 */
export const SCOPE_GRANTS: Readonly<Record<ApiTokenScope, readonly WorkspaceAction[]>> = {
  read: ["read"],
  suggest: ["read", "write_draft"],
  execute: ["read", "write_draft", "export"],
};

export interface SessionPrincipal {
  kind: "session";
  sessionId: string;
}

export interface ApiTokenPrincipal {
  kind: "api_token";
  tokenId: string;
  scopes: readonly ApiTokenScope[];
}

export type Principal = SessionPrincipal | ApiTokenPrincipal;

/**
 * Result of authenticating a request against one workspace. `context` is the
 * plain `WorkspaceContext` repositories and services already require, so the
 * derived context is created once here and then passed down unchanged.
 */
export interface WorkspaceAccess {
  readonly context: WorkspaceContext;
  readonly role: WorkspaceRole;
  readonly principal: Principal;
  readonly grants: readonly WorkspaceAction[];
}

export function grantsForRole(role: WorkspaceRole): readonly WorkspaceAction[] {
  return ROLE_GRANTS[role];
}

/** Effective grants of a token: its scopes' actions, capped by the creator's role. */
export function grantsForScopes(
  scopes: readonly ApiTokenScope[],
  role: WorkspaceRole,
): readonly WorkspaceAction[] {
  const fromScopes = new Set<WorkspaceAction>(scopes.flatMap((scope) => SCOPE_GRANTS[scope]));
  return WORKSPACE_ACTIONS.filter(
    (action) => fromScopes.has(action) && ROLE_GRANTS[role].includes(action),
  );
}

export function can(access: WorkspaceAccess, action: WorkspaceAction): boolean {
  return access.grants.includes(action);
}

export function assertCan(access: WorkspaceAccess, action: WorkspaceAction): void {
  if (!can(access, action)) {
    throw new AuthError("forbidden", [action]);
  }
}

/** Audit `actor` string for the principal: the user id, or `agent:<tokenId>`. */
export function auditActor(access: WorkspaceAccess): string {
  return access.principal.kind === "api_token"
    ? `agent:${access.principal.tokenId}`
    : (access.context.userId ?? "system");
}

export function createSessionAccess(input: {
  membership: WorkspaceMembership;
  sessionId: string;
  requestId?: string;
}): WorkspaceAccess {
  return Object.freeze({
    context: accessContext(input.membership, input.requestId),
    role: input.membership.role,
    principal: Object.freeze({ kind: "session", sessionId: input.sessionId }),
    grants: grantsForRole(input.membership.role),
  } satisfies WorkspaceAccess);
}

export function createApiTokenAccess(input: {
  membership: WorkspaceMembership;
  tokenId: string;
  scopes: readonly ApiTokenScope[];
  requestId?: string;
}): WorkspaceAccess {
  return Object.freeze({
    context: accessContext(input.membership, input.requestId),
    role: input.membership.role,
    principal: Object.freeze({ kind: "api_token", tokenId: input.tokenId, scopes: input.scopes }),
    grants: grantsForScopes(input.scopes, input.membership.role),
  } satisfies WorkspaceAccess);
}

/** `requestId` is omitted rather than set to `undefined` so the frozen context has no phantom keys. */
function accessContext(
  membership: WorkspaceMembership,
  requestId: string | undefined,
): WorkspaceContext {
  return createWorkspaceContext({
    workspaceId: membership.workspaceId,
    userId: membership.userId,
    ...(requestId === undefined ? {} : { requestId }),
  });
}
