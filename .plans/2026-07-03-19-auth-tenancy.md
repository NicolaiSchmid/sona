# Auth and Tenancy Plan

## Purpose

Add invite-only authentication and workspace membership so the hosted mode can onboard trusted early users, and so every request path derives workspace context from an authenticated session instead of static config.

## Goals

- Invite-only signup: admin-created invites, email + strong password with a modern KDF (argon2id/scrypt), optional TOTP 2FA.
- Session management: HTTP-only secure cookies, expiry, revocation, session listing.
- Workspace membership model: `owner`, `member`, `advisor_readonly` roles as literal unions.
- Bind web and MCP surfaces to authenticated workspace context; scoped API tokens for MCP/agent sessions.
- Login/logout/invite audit events.

## Non-Goals

- Billing.
- SSO/OIDC providers (follow-up).
- Fine-grained per-account permissions; role-level is enough for v1.
- Self-serve open registration.

## Required Reading

- `docs/security-compliance.md`
- `.plans/2026-06-28-08-cloud-self-hosting-boundary.md` tenancy boundary
- `AGENTS.md` cross-user leak review focus

## Target Files

Likely create/modify:

```text
packages/core/src/auth/types.ts
packages/core/src/auth/passwords.ts
packages/core/src/auth/sessions.ts
packages/core/src/auth/invites.ts
packages/core/src/auth/*.test.ts
packages/db/src/migrations/0008_auth.sql
packages/db/src/repositories/auth.ts
apps/web/src/server/auth.ts
packages/mcp/src/tokens.ts
```

## Design Constraints

- Evaluate an existing library (e.g. better-auth) vs a small handrolled core; record the decision. Whatever is chosen, password hashing, session semantics, and token scoping must be testable in isolation.
- Workspace context becomes a required, typed parameter derived once at the session boundary — repositories keep their explicit `workspaceId` (defense in depth, phase 09 isolation tests still apply).
- `advisor_readonly` can view review queues, ledger, and exports but cannot approve or mutate; enforced in the shared service layer so web and MCP inherit it.
- API tokens are hashed at rest, scoped (`read`, `suggest`, `execute`), revocable, and attributable in audit logs; agent tokens can never carry approval rights (aligns with phase-15 session-origin rule).
- Rate-limit login and invite endpoints; constant-time comparisons for tokens.
- Self-hosted single-user mode keeps working: a bootstrap owner account is created from config on first run.

## TDD Steps

### Task 1: Credentials and sessions

Write tests first:

- signup only with a valid unexpired invite; invites are single-use,
- password hashes use the chosen KDF with per-user salt; verification works, timing-safe,
- session expiry and revocation enforced,
- TOTP enrollment/verification roundtrip.

### Task 2: Workspace isolation

- user in workspace A gets 404/denied for every workspace B resource across all route families (table-driven test over the API surface),
- `advisor_readonly` approval attempt is denied and audited.

### Task 3: MCP tokens

- scoped token grants exactly its scopes; `suggest` cannot approve,
- revoked token fails immediately,
- token value appears nowhere in logs or audit rows (hash only).

## Acceptance Criteria

- `pnpm check` passes.
- Every authenticated surface has an isolation test.
- No plaintext secrets/tokens at rest or in logs.
- Commit uses Conventional Commits, e.g. `feat(core): add invite-only auth, sessions, and workspace membership`.

## Follow-Up

- OIDC/passkey support.
- Advisor invitation flow with expiring access.
- Admin console for invite/user management.
