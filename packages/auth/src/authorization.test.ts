import { requireWorkspaceContext } from "@sona/core";
import { describe, expect, it } from "vitest";
import {
  assertCan,
  auditActor,
  can,
  createApiTokenAccess,
  createSessionAccess,
  grantsForScopes,
  ROLE_GRANTS,
  SCOPE_GRANTS,
} from "./authorization.js";
import { AuthError } from "./errors.js";
import {
  type ApiTokenScope,
  WORKSPACE_ACTIONS,
  type WorkspaceAction,
  type WorkspaceMembership,
  type WorkspaceRole,
} from "./types.js";

function membership(role: WorkspaceRole): WorkspaceMembership {
  return { workspaceId: "ws_1", userId: "user_1", role, createdAt: "2026-01-01T00:00:00Z" };
}

describe("role permission matrix", () => {
  const matrix: Record<WorkspaceRole, Record<WorkspaceAction, boolean>> = {
    owner: { read: true, write_draft: true, review_approve: true, export: true, admin: true },
    member: { read: true, write_draft: true, review_approve: true, export: true, admin: false },
    advisor_readonly: {
      read: true,
      write_draft: false,
      review_approve: false,
      export: false,
      admin: false,
    },
  };

  for (const [role, expectations] of Object.entries(matrix) as Array<
    [WorkspaceRole, Record<WorkspaceAction, boolean>]
  >) {
    it(`grants exactly the expected actions to ${role}`, () => {
      const access = createSessionAccess({ membership: membership(role), sessionId: "ses_1" });
      for (const action of WORKSPACE_ACTIONS) {
        expect(can(access, action), `${role} ${action}`).toBe(expectations[action]);
      }
      expect([...ROLE_GRANTS[role]].sort()).toEqual(
        WORKSPACE_ACTIONS.filter((action) => expectations[action]).sort(),
      );
    });
  }

  it("assertCan throws a forbidden AuthError naming the action", () => {
    const access = createSessionAccess({
      membership: membership("advisor_readonly"),
      sessionId: "ses_1",
    });
    expect(() => assertCan(access, "review_approve")).toThrow(AuthError);
    try {
      assertCan(access, "review_approve");
    } catch (error) {
      expect(error).toMatchObject({ code: "forbidden", details: ["review_approve"] });
    }
  });
});

describe("api token scopes", () => {
  it("never grant approval or admin rights", () => {
    for (const actions of Object.values(SCOPE_GRANTS)) {
      expect(actions).not.toContain("review_approve");
      expect(actions).not.toContain("admin");
    }
  });

  it("are capped by the creator's role", () => {
    expect(grantsForScopes(["execute"], "owner")).toEqual(["read", "write_draft", "export"]);
    expect(grantsForScopes(["execute"], "advisor_readonly")).toEqual(["read"]);
    expect(grantsForScopes(["read", "suggest"], "member")).toEqual(["read", "write_draft"]);
    expect(grantsForScopes([] as ApiTokenScope[], "owner")).toEqual([]);
  });

  it("builds an agent principal whose audit actor is the token, not the user", () => {
    const access = createApiTokenAccess({
      membership: membership("member"),
      tokenId: "tok_1",
      scopes: ["suggest"],
      requestId: "req_1",
    });
    expect(access.principal).toEqual({ kind: "api_token", tokenId: "tok_1", scopes: ["suggest"] });
    expect(auditActor(access)).toBe("agent:tok_1");
    expect(can(access, "write_draft")).toBe(true);
    expect(can(access, "review_approve")).toBe(false);
    expect(access.context).toEqual({ workspaceId: "ws_1", userId: "user_1", requestId: "req_1" });
  });
});

describe("workspace access context", () => {
  it("produces a frozen core WorkspaceContext accepted by requireWorkspaceContext", () => {
    const access = createSessionAccess({ membership: membership("owner"), sessionId: "ses_1" });
    expect(Object.isFrozen(access)).toBe(true);
    expect(Object.isFrozen(access.context)).toBe(true);
    expect(requireWorkspaceContext(access.context)).toEqual({
      workspaceId: "ws_1",
      userId: "user_1",
    });
    expect(auditActor(access)).toBe("user_1");
  });
});
