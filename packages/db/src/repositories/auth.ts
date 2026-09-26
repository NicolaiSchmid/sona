/**
 * SQLite implementation of the `@sona/auth` store interfaces
 * (`migrations/0009_auth.sql`).
 *
 * Single-use and monotonic guards (invite claim, session revoke, TOTP step,
 * recovery code consumption) are enforced by conditional UPDATEs that report
 * their change count, so they hold under concurrent callers without a
 * read-then-write in the service.
 */
import {
  type ApiToken,
  type ApiTokenScope,
  type AuthSession,
  type AuthStore,
  type AuthUser,
  isApiTokenScope,
  isWorkspaceRole,
  type RecoveryCode,
  type TotpEnrollment,
  type UserCredential,
  type Workspace,
  type WorkspaceInvite,
  type WorkspaceMembership,
} from "@sona/auth";
import type { DbClient, DbValue } from "../runner.js";
import {
  optionalString,
  parseJson,
  type Row,
  requiredLiteral,
  requiredNumber,
  requiredString,
  row,
  rows,
  stringifyJson,
  withTransaction,
} from "./helpers.js";

const USER_SELECT = "SELECT id, email, created_at FROM users";
const MEMBERSHIP_SELECT = "SELECT workspace_id, user_id, role, created_at FROM workspace_members";
const INVITE_SELECT =
  "SELECT id, workspace_id, email, role, token_hash, created_by_user_id, created_at, expires_at, accepted_at, accepted_by_user_id, revoked_at FROM workspace_invites";
const SESSION_SELECT =
  "SELECT id, user_id, token_hash, created_at, expires_at, absolute_expires_at, last_seen_at, revoked_at, client_label FROM auth_sessions";
const API_TOKEN_SELECT =
  "SELECT id, workspace_id, created_by_user_id, name, token_hash, scopes_json, created_at, expires_at, last_used_at, revoked_at FROM api_tokens";

export class SqliteAuthRepository implements AuthStore {
  readonly #db: DbClient;

  constructor(db: DbClient) {
    this.#db = db;
  }

  // --- Users ------------------------------------------------------------------

  async createUser(user: AuthUser, credential: UserCredential): Promise<void> {
    if (credential.userId !== user.id) {
      throw new Error("credential user id must match the user");
    }
    withTransaction(this.#db, () => {
      this.#db
        .prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
        .run(user.id, user.email, user.createdAt);
      this.#insertCredential(credential);
    });
  }

  async createCredential(credential: UserCredential): Promise<void> {
    this.#insertCredential(credential);
  }

  #insertCredential(credential: UserCredential): void {
    this.#db
      .prepare("INSERT INTO user_credentials (user_id, password_hash, updated_at) VALUES (?, ?, ?)")
      .run(credential.userId, credential.passwordHash, credential.updatedAt);
  }

  async getUserById(userId: string): Promise<AuthUser | undefined> {
    return this.#one(`${USER_SELECT} WHERE id = ?`, [userId], userFromRow);
  }

  async getUserByEmail(email: string): Promise<AuthUser | undefined> {
    return this.#one(`${USER_SELECT} WHERE email = ?`, [email], userFromRow);
  }

  async getCredential(userId: string): Promise<UserCredential | undefined> {
    return this.#one(
      "SELECT user_id, password_hash, updated_at FROM user_credentials WHERE user_id = ?",
      [userId],
      credentialFromRow,
    );
  }

  async updateCredential(credential: UserCredential): Promise<void> {
    const changed = this.#run(
      "UPDATE user_credentials SET password_hash = ?, updated_at = ? WHERE user_id = ?",
      [credential.passwordHash, credential.updatedAt, credential.userId],
    );
    if (!changed) {
      throw new Error("credential not found");
    }
  }

  async countUsers(): Promise<number> {
    return this.#count("SELECT COUNT(*) AS count FROM users", []);
  }

  async countCredentials(): Promise<number> {
    return this.#count("SELECT COUNT(*) AS count FROM user_credentials", []);
  }

  // --- Workspaces and memberships ---------------------------------------------

  async createWorkspace(workspace: Workspace): Promise<void> {
    this.#db
      .prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)")
      .run(workspace.id, workspace.name, workspace.createdAt);
  }

  async getWorkspace(workspaceId: string): Promise<Workspace | undefined> {
    return this.#one(
      "SELECT id, name, created_at FROM workspaces WHERE id = ?",
      [workspaceId],
      workspaceFromRow,
    );
  }

  async createMembership(membership: WorkspaceMembership): Promise<void> {
    this.#db
      .prepare(
        "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(membership.workspaceId, membership.userId, membership.role, membership.createdAt);
  }

  async getMembership(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceMembership | undefined> {
    return this.#one(
      `${MEMBERSHIP_SELECT} WHERE workspace_id = ? AND user_id = ?`,
      [workspaceId, userId],
      membershipFromRow,
    );
  }

  async listMemberships(userId: string): Promise<WorkspaceMembership[]> {
    return this.#all(
      `${MEMBERSHIP_SELECT} WHERE user_id = ? ORDER BY created_at, workspace_id`,
      [userId],
      membershipFromRow,
    );
  }

  // --- Invites ----------------------------------------------------------------

  async createInvite(invite: WorkspaceInvite): Promise<void> {
    this.#db
      .prepare(
        "INSERT INTO workspace_invites (id, workspace_id, email, role, token_hash, created_by_user_id, created_at, expires_at, accepted_at, accepted_by_user_id, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        invite.id,
        invite.workspaceId,
        invite.email,
        invite.role,
        invite.tokenHash,
        invite.createdByUserId,
        invite.createdAt,
        invite.expiresAt,
        invite.acceptedAt ?? null,
        invite.acceptedByUserId ?? null,
        invite.revokedAt ?? null,
      );
  }

  async getInviteByTokenHash(tokenHash: string): Promise<WorkspaceInvite | undefined> {
    return this.#one(`${INVITE_SELECT} WHERE token_hash = ?`, [tokenHash], inviteFromRow);
  }

  async getInvite(workspaceId: string, inviteId: string): Promise<WorkspaceInvite | undefined> {
    return this.#one(
      `${INVITE_SELECT} WHERE workspace_id = ? AND id = ?`,
      [workspaceId, inviteId],
      inviteFromRow,
    );
  }

  async listInvites(workspaceId: string): Promise<WorkspaceInvite[]> {
    return this.#all(
      `${INVITE_SELECT} WHERE workspace_id = ? ORDER BY created_at, id`,
      [workspaceId],
      inviteFromRow,
    );
  }

  async claimInvite(
    inviteId: string,
    acceptedAt: string,
    acceptedByUserId: string,
  ): Promise<boolean> {
    return this.#run(
      "UPDATE workspace_invites SET accepted_at = ?, accepted_by_user_id = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL",
      [acceptedAt, acceptedByUserId, inviteId],
    );
  }

  async revokeInvite(workspaceId: string, inviteId: string, revokedAt: string): Promise<boolean> {
    return this.#run(
      "UPDATE workspace_invites SET revoked_at = ? WHERE workspace_id = ? AND id = ? AND accepted_at IS NULL AND revoked_at IS NULL",
      [revokedAt, workspaceId, inviteId],
    );
  }

  // --- Sessions ---------------------------------------------------------------

  async createSession(session: AuthSession): Promise<void> {
    this.#db
      .prepare(
        "INSERT INTO auth_sessions (id, user_id, token_hash, created_at, expires_at, absolute_expires_at, last_seen_at, revoked_at, client_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        session.id,
        session.userId,
        session.tokenHash,
        session.createdAt,
        session.expiresAt,
        session.absoluteExpiresAt,
        session.lastSeenAt,
        session.revokedAt ?? null,
        session.clientLabel ?? null,
      );
  }

  async getSessionByTokenHash(tokenHash: string): Promise<AuthSession | undefined> {
    return this.#one(`${SESSION_SELECT} WHERE token_hash = ?`, [tokenHash], sessionFromRow);
  }

  async getSession(userId: string, sessionId: string): Promise<AuthSession | undefined> {
    return this.#one(
      `${SESSION_SELECT} WHERE user_id = ? AND id = ?`,
      [userId, sessionId],
      sessionFromRow,
    );
  }

  async listSessions(userId: string): Promise<AuthSession[]> {
    return this.#all(
      `${SESSION_SELECT} WHERE user_id = ? ORDER BY created_at, id`,
      [userId],
      sessionFromRow,
    );
  }

  async renewSession(sessionId: string, expiresAt: string, lastSeenAt: string): Promise<void> {
    this.#run("UPDATE auth_sessions SET expires_at = ?, last_seen_at = ? WHERE id = ?", [
      expiresAt,
      lastSeenAt,
      sessionId,
    ]);
  }

  async revokeSession(userId: string, sessionId: string, revokedAt: string): Promise<boolean> {
    return this.#run(
      "UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND id = ? AND revoked_at IS NULL",
      [revokedAt, userId, sessionId],
    );
  }

  async revokeAllSessions(userId: string, revokedAt: string): Promise<number> {
    return this.#changes(
      "UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
      [revokedAt, userId],
    );
  }

  // --- TOTP -------------------------------------------------------------------

  async getTotpEnrollment(userId: string): Promise<TotpEnrollment | undefined> {
    return this.#one(
      "SELECT user_id, secret_ciphertext, last_used_step, created_at, confirmed_at FROM user_totp_enrollments WHERE user_id = ?",
      [userId],
      totpEnrollmentFromRow,
    );
  }

  async saveTotpEnrollment(enrollment: TotpEnrollment): Promise<void> {
    withTransaction(this.#db, () => {
      this.#db
        .prepare("DELETE FROM user_totp_enrollments WHERE user_id = ?")
        .run(enrollment.userId);
      this.#db
        .prepare(
          "INSERT INTO user_totp_enrollments (user_id, secret_ciphertext, last_used_step, created_at, confirmed_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          enrollment.userId,
          enrollment.secretCiphertext,
          enrollment.lastUsedStep,
          enrollment.createdAt,
          enrollment.confirmedAt ?? null,
        );
    });
  }

  async confirmTotpEnrollment(userId: string, confirmedAt: string): Promise<void> {
    const changed = this.#run(
      "UPDATE user_totp_enrollments SET confirmed_at = ? WHERE user_id = ? AND confirmed_at IS NULL",
      [confirmedAt, userId],
    );
    if (!changed) {
      throw new Error("totp enrollment not found or already confirmed");
    }
  }

  async deleteTotpEnrollment(userId: string): Promise<void> {
    this.#run("DELETE FROM user_totp_enrollments WHERE user_id = ?", [userId]);
  }

  async advanceTotpStep(userId: string, step: number): Promise<boolean> {
    return this.#run(
      "UPDATE user_totp_enrollments SET last_used_step = ? WHERE user_id = ? AND last_used_step < ?",
      [step, userId, step],
    );
  }

  async replaceRecoveryCodes(userId: string, codes: readonly RecoveryCode[]): Promise<void> {
    withTransaction(this.#db, () => {
      this.#db.prepare("DELETE FROM user_recovery_codes WHERE user_id = ?").run(userId);
      const insert = this.#db.prepare(
        "INSERT INTO user_recovery_codes (id, user_id, code_hash, created_at, used_at) VALUES (?, ?, ?, ?, ?)",
      );
      for (const code of codes) {
        if (code.userId !== userId) {
          throw new Error("recovery code user id must match");
        }
        insert.run(code.id, code.userId, code.codeHash, code.createdAt, code.usedAt ?? null);
      }
    });
  }

  async consumeRecoveryCode(userId: string, codeHash: string, usedAt: string): Promise<boolean> {
    return this.#run(
      "UPDATE user_recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL",
      [usedAt, userId, codeHash],
    );
  }

  async countUnusedRecoveryCodes(userId: string): Promise<number> {
    return this.#count(
      "SELECT COUNT(*) AS count FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL",
      [userId],
    );
  }

  // --- API tokens -------------------------------------------------------------

  async createApiToken(token: ApiToken): Promise<void> {
    this.#db
      .prepare(
        "INSERT INTO api_tokens (id, workspace_id, created_by_user_id, name, token_hash, scopes_json, created_at, expires_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        token.id,
        token.workspaceId,
        token.createdByUserId,
        token.name,
        token.tokenHash,
        stringifyJson([...token.scopes]),
        token.createdAt,
        token.expiresAt,
        token.lastUsedAt ?? null,
        token.revokedAt ?? null,
      );
  }

  async getApiTokenByHash(tokenHash: string): Promise<ApiToken | undefined> {
    return this.#one(`${API_TOKEN_SELECT} WHERE token_hash = ?`, [tokenHash], apiTokenFromRow);
  }

  async getApiToken(workspaceId: string, tokenId: string): Promise<ApiToken | undefined> {
    return this.#one(
      `${API_TOKEN_SELECT} WHERE workspace_id = ? AND id = ?`,
      [workspaceId, tokenId],
      apiTokenFromRow,
    );
  }

  async listApiTokens(workspaceId: string): Promise<ApiToken[]> {
    return this.#all(
      `${API_TOKEN_SELECT} WHERE workspace_id = ? ORDER BY created_at, id`,
      [workspaceId],
      apiTokenFromRow,
    );
  }

  async touchApiToken(tokenId: string, lastUsedAt: string): Promise<void> {
    this.#run("UPDATE api_tokens SET last_used_at = ? WHERE id = ?", [lastUsedAt, tokenId]);
  }

  async revokeApiToken(workspaceId: string, tokenId: string, revokedAt: string): Promise<boolean> {
    return this.#run(
      "UPDATE api_tokens SET revoked_at = ? WHERE workspace_id = ? AND id = ? AND revoked_at IS NULL",
      [revokedAt, workspaceId, tokenId],
    );
  }

  // --- Internals --------------------------------------------------------------

  #one<T>(sql: string, params: DbValue[], map: (source: Row) => T): T | undefined {
    const result = row(this.#db.prepare(sql).get(...params));
    return result === undefined ? undefined : map(result);
  }

  #all<T>(sql: string, params: DbValue[], map: (source: Row) => T): T[] {
    return rows(this.#db.prepare(sql).all(...params)).map(map);
  }

  /** Runs a `SELECT COUNT(*) AS count ...` statement. */
  #count(sql: string, params: DbValue[]): number {
    const result = row(this.#db.prepare(sql).get(...params));
    if (result === undefined) {
      throw new Error("database did not return a count");
    }
    return requiredNumber(result, "count");
  }

  /** Runs a statement and reports whether at least one row changed. */
  #run(sql: string, params: DbValue[]): boolean {
    return this.#changes(sql, params) > 0;
  }

  #changes(sql: string, params: DbValue[]): number {
    const result = row(this.#db.prepare(sql).run(...params));
    if (result === undefined) {
      throw new Error("database did not report the change count of a statement");
    }
    return requiredNumber(result, "changes");
  }
}

function userFromRow(source: Row): AuthUser {
  return {
    id: requiredString(source, "id"),
    email: requiredString(source, "email"),
    createdAt: requiredString(source, "created_at"),
  };
}

function credentialFromRow(source: Row): UserCredential {
  return {
    userId: requiredString(source, "user_id"),
    passwordHash: requiredString(source, "password_hash"),
    updatedAt: requiredString(source, "updated_at"),
  };
}

function workspaceFromRow(source: Row): Workspace {
  return {
    id: requiredString(source, "id"),
    name: requiredString(source, "name"),
    createdAt: requiredString(source, "created_at"),
  };
}

function membershipFromRow(source: Row): WorkspaceMembership {
  return {
    workspaceId: requiredString(source, "workspace_id"),
    userId: requiredString(source, "user_id"),
    role: requiredLiteral(source, "role", isWorkspaceRole),
    createdAt: requiredString(source, "created_at"),
  };
}

function inviteFromRow(source: Row): WorkspaceInvite {
  return {
    id: requiredString(source, "id"),
    workspaceId: requiredString(source, "workspace_id"),
    email: requiredString(source, "email"),
    role: requiredLiteral(source, "role", isWorkspaceRole),
    tokenHash: requiredString(source, "token_hash"),
    createdByUserId: requiredString(source, "created_by_user_id"),
    createdAt: requiredString(source, "created_at"),
    expiresAt: requiredString(source, "expires_at"),
    acceptedAt: optionalString(source, "accepted_at"),
    acceptedByUserId: optionalString(source, "accepted_by_user_id"),
    revokedAt: optionalString(source, "revoked_at"),
  };
}

function sessionFromRow(source: Row): AuthSession {
  return {
    id: requiredString(source, "id"),
    userId: requiredString(source, "user_id"),
    tokenHash: requiredString(source, "token_hash"),
    createdAt: requiredString(source, "created_at"),
    expiresAt: requiredString(source, "expires_at"),
    absoluteExpiresAt: requiredString(source, "absolute_expires_at"),
    lastSeenAt: requiredString(source, "last_seen_at"),
    revokedAt: optionalString(source, "revoked_at"),
    clientLabel: optionalString(source, "client_label"),
  };
}

function totpEnrollmentFromRow(source: Row): TotpEnrollment {
  return {
    userId: requiredString(source, "user_id"),
    secretCiphertext: requiredString(source, "secret_ciphertext"),
    lastUsedStep: requiredNumber(source, "last_used_step"),
    createdAt: requiredString(source, "created_at"),
    confirmedAt: optionalString(source, "confirmed_at"),
  };
}

function apiTokenFromRow(source: Row): ApiToken {
  return {
    id: requiredString(source, "id"),
    workspaceId: requiredString(source, "workspace_id"),
    createdByUserId: requiredString(source, "created_by_user_id"),
    name: requiredString(source, "name"),
    tokenHash: requiredString(source, "token_hash"),
    scopes: parseScopes(requiredString(source, "scopes_json")),
    createdAt: requiredString(source, "created_at"),
    expiresAt: requiredString(source, "expires_at"),
    lastUsedAt: optionalString(source, "last_used_at"),
    revokedAt: optionalString(source, "revoked_at"),
  };
}

function parseScopes(json: string): ApiTokenScope[] {
  const parsed = parseJson(json);
  if (!Array.isArray(parsed)) {
    throw new Error("api token scopes_json was not an array");
  }
  return parsed.map((scope) => {
    if (typeof scope !== "string" || !isApiTokenScope(scope)) {
      throw new Error(`api token scopes_json had unexpected value ${JSON.stringify(scope)}`);
    }
    return scope;
  });
}
