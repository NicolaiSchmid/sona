import type { JsonValue } from "@sona/core";
import { describe, expect, it } from "vitest";
import {
  ANONYMOUS_ACTOR,
  AUTH_AUDIT_ACTIONS,
  createAuthAuditEvent,
  LOGIN_FAILURE_REASONS,
} from "./audit.js";

describe("createAuthAuditEvent", () => {
  it("omits optional keys entirely instead of setting them to undefined", () => {
    const event = createAuthAuditEvent(
      { workspaceId: "ws_1", action: "auth.logout", actor: "user_1" },
      "audit_1",
      "2026-07-01T09:00:00.000Z",
    );
    expect(event).toEqual({
      id: "audit_1",
      workspaceId: "ws_1",
      action: "auth.logout",
      actor: "user_1",
      createdAt: "2026-07-01T09:00:00.000Z",
    });
    expect(Object.keys(event)).not.toContain("targetType");
    expect(Object.keys(event)).not.toContain("targetId");
    expect(Object.keys(event)).not.toContain("metadata");
  });

  it("copies metadata so later mutation of the input does not alter the event", () => {
    const metadata: Record<string, JsonValue> = { reason: "invalid_password" };
    const event = createAuthAuditEvent(
      {
        workspaceId: "ws_1",
        action: "auth.login.failed",
        actor: ANONYMOUS_ACTOR,
        targetType: "user",
        targetId: "user_1",
        metadata,
      },
      "audit_2",
      "2026-07-01T09:00:00.000Z",
    );
    expect(event).toMatchObject({
      actor: "anonymous",
      targetType: "user",
      targetId: "user_1",
      metadata: { reason: "invalid_password" },
    });
    expect(event.metadata).not.toBe(metadata);
    metadata["reason"] = "tampered";
    metadata["extra"] = true;
    expect(event.metadata).toEqual({ reason: "invalid_password" });
  });

  it("keeps the action and reason vocabularies free of duplicates", () => {
    expect(new Set(AUTH_AUDIT_ACTIONS).size).toBe(AUTH_AUDIT_ACTIONS.length);
    expect(new Set(LOGIN_FAILURE_REASONS).size).toBe(LOGIN_FAILURE_REASONS.length);
    for (const action of AUTH_AUDIT_ACTIONS) {
      expect(action.startsWith("auth.")).toBe(true);
    }
  });
});
