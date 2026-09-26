import type {
  ApiToken,
  AuthSession,
  AuthStore,
  AuthUser,
  RecoveryCode,
  TotpEnrollment,
  UserCredential,
  Workspace,
  WorkspaceInvite,
  WorkspaceMembership,
} from "./types.js";

/**
 * In-memory `AuthStore` with the same conditional-update semantics as the
 * SQLite repository, for unit tests of the service layer and for consumers
 * (web, MCP) that need a fake in their own tests.
 */
export class InMemoryAuthStore implements AuthStore {
  readonly users = new Map<string, AuthUser>();
  readonly credentials = new Map<string, UserCredential>();
  readonly workspaces = new Map<string, Workspace>();
  readonly memberships: WorkspaceMembership[] = [];
  readonly invites = new Map<string, WorkspaceInvite>();
  readonly sessions = new Map<string, AuthSession>();
  readonly totp = new Map<string, TotpEnrollment>();
  readonly recoveryCodes: RecoveryCode[] = [];
  readonly apiTokens = new Map<string, ApiToken>();

  async createUser(user: AuthUser, credential: UserCredential): Promise<void> {
    if (this.users.has(user.id) || (await this.getUserByEmail(user.email)) !== undefined) {
      throw new Error("user already exists");
    }
    this.users.set(user.id, { ...user });
    this.credentials.set(user.id, { ...credential });
  }

  async getUserById(userId: string): Promise<AuthUser | undefined> {
    return this.users.get(userId);
  }

  async getUserByEmail(email: string): Promise<AuthUser | undefined> {
    return [...this.users.values()].find((user) => user.email === email);
  }

  async getCredential(userId: string): Promise<UserCredential | undefined> {
    return this.credentials.get(userId);
  }

  async updateCredential(credential: UserCredential): Promise<void> {
    if (!this.credentials.has(credential.userId)) {
      throw new Error("credential not found");
    }
    this.credentials.set(credential.userId, { ...credential });
  }

  async countUsers(): Promise<number> {
    return this.users.size;
  }

  async createWorkspace(workspace: Workspace): Promise<void> {
    if (this.workspaces.has(workspace.id)) {
      throw new Error("workspace already exists");
    }
    this.workspaces.set(workspace.id, { ...workspace });
  }

  async createMembership(membership: WorkspaceMembership): Promise<void> {
    if ((await this.getMembership(membership.workspaceId, membership.userId)) !== undefined) {
      throw new Error("membership already exists");
    }
    this.memberships.push({ ...membership });
  }

  async getMembership(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceMembership | undefined> {
    return this.memberships.find(
      (membership) => membership.workspaceId === workspaceId && membership.userId === userId,
    );
  }

  async listMemberships(userId: string): Promise<WorkspaceMembership[]> {
    return this.memberships.filter((membership) => membership.userId === userId);
  }

  async createInvite(invite: WorkspaceInvite): Promise<void> {
    this.invites.set(invite.id, { ...invite });
  }

  async getInviteByTokenHash(tokenHash: string): Promise<WorkspaceInvite | undefined> {
    return [...this.invites.values()].find((invite) => invite.tokenHash === tokenHash);
  }

  async getInvite(workspaceId: string, inviteId: string): Promise<WorkspaceInvite | undefined> {
    const invite = this.invites.get(inviteId);
    return invite?.workspaceId === workspaceId ? invite : undefined;
  }

  async listInvites(workspaceId: string): Promise<WorkspaceInvite[]> {
    return [...this.invites.values()].filter((invite) => invite.workspaceId === workspaceId);
  }

  async claimInvite(
    inviteId: string,
    acceptedAt: string,
    acceptedByUserId: string,
  ): Promise<boolean> {
    const invite = this.invites.get(inviteId);
    if (invite === undefined || invite.acceptedAt !== undefined || invite.revokedAt !== undefined) {
      return false;
    }
    this.invites.set(inviteId, { ...invite, acceptedAt, acceptedByUserId });
    return true;
  }

  async revokeInvite(workspaceId: string, inviteId: string, revokedAt: string): Promise<boolean> {
    const invite = await this.getInvite(workspaceId, inviteId);
    if (invite === undefined || invite.acceptedAt !== undefined || invite.revokedAt !== undefined) {
      return false;
    }
    this.invites.set(inviteId, { ...invite, revokedAt });
    return true;
  }

  async createSession(session: AuthSession): Promise<void> {
    this.sessions.set(session.id, { ...session });
  }

  async getSessionByTokenHash(tokenHash: string): Promise<AuthSession | undefined> {
    return [...this.sessions.values()].find((session) => session.tokenHash === tokenHash);
  }

  async getSession(userId: string, sessionId: string): Promise<AuthSession | undefined> {
    const session = this.sessions.get(sessionId);
    return session?.userId === userId ? session : undefined;
  }

  async listSessions(userId: string): Promise<AuthSession[]> {
    return [...this.sessions.values()].filter((session) => session.userId === userId);
  }

  async renewSession(sessionId: string, expiresAt: string, lastSeenAt: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new Error("session not found");
    }
    this.sessions.set(sessionId, { ...session, expiresAt, lastSeenAt });
  }

  async revokeSession(userId: string, sessionId: string, revokedAt: string): Promise<boolean> {
    const session = await this.getSession(userId, sessionId);
    if (session === undefined || session.revokedAt !== undefined) {
      return false;
    }
    this.sessions.set(sessionId, { ...session, revokedAt });
    return true;
  }

  async revokeAllSessions(userId: string, revokedAt: string): Promise<number> {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.userId === userId && session.revokedAt === undefined) {
        this.sessions.set(session.id, { ...session, revokedAt });
        count += 1;
      }
    }
    return count;
  }

  async getTotpEnrollment(userId: string): Promise<TotpEnrollment | undefined> {
    return this.totp.get(userId);
  }

  async saveTotpEnrollment(enrollment: TotpEnrollment): Promise<void> {
    this.totp.set(enrollment.userId, { ...enrollment });
  }

  async confirmTotpEnrollment(userId: string, confirmedAt: string): Promise<void> {
    const enrollment = this.totp.get(userId);
    if (enrollment === undefined) {
      throw new Error("totp enrollment not found");
    }
    this.totp.set(userId, { ...enrollment, confirmedAt });
  }

  async deleteTotpEnrollment(userId: string): Promise<void> {
    this.totp.delete(userId);
  }

  async advanceTotpStep(userId: string, step: number): Promise<boolean> {
    const enrollment = this.totp.get(userId);
    if (enrollment === undefined || step <= enrollment.lastUsedStep) {
      return false;
    }
    this.totp.set(userId, { ...enrollment, lastUsedStep: step });
    return true;
  }

  async replaceRecoveryCodes(userId: string, codes: readonly RecoveryCode[]): Promise<void> {
    const kept = this.recoveryCodes.filter((code) => code.userId !== userId);
    this.recoveryCodes.splice(
      0,
      this.recoveryCodes.length,
      ...kept,
      ...codes.map((c) => ({ ...c })),
    );
  }

  async consumeRecoveryCode(userId: string, codeHash: string, usedAt: string): Promise<boolean> {
    const code = this.recoveryCodes.find(
      (entry) =>
        entry.userId === userId && entry.codeHash === codeHash && entry.usedAt === undefined,
    );
    if (code === undefined) {
      return false;
    }
    code.usedAt = usedAt;
    return true;
  }

  async countUnusedRecoveryCodes(userId: string): Promise<number> {
    return this.recoveryCodes.filter((code) => code.userId === userId && code.usedAt === undefined)
      .length;
  }

  async createApiToken(token: ApiToken): Promise<void> {
    this.apiTokens.set(token.id, { ...token, scopes: [...token.scopes] });
  }

  async getApiTokenByHash(tokenHash: string): Promise<ApiToken | undefined> {
    return [...this.apiTokens.values()].find((token) => token.tokenHash === tokenHash);
  }

  async getApiToken(workspaceId: string, tokenId: string): Promise<ApiToken | undefined> {
    const token = this.apiTokens.get(tokenId);
    return token?.workspaceId === workspaceId ? token : undefined;
  }

  async listApiTokens(workspaceId: string): Promise<ApiToken[]> {
    return [...this.apiTokens.values()].filter((token) => token.workspaceId === workspaceId);
  }

  async touchApiToken(tokenId: string, lastUsedAt: string): Promise<void> {
    const token = this.apiTokens.get(tokenId);
    if (token !== undefined) {
      this.apiTokens.set(tokenId, { ...token, lastUsedAt });
    }
  }

  async revokeApiToken(workspaceId: string, tokenId: string, revokedAt: string): Promise<boolean> {
    const token = await this.getApiToken(workspaceId, tokenId);
    if (token === undefined || token.revokedAt !== undefined) {
      return false;
    }
    this.apiTokens.set(tokenId, { ...token, revokedAt });
    return true;
  }
}
