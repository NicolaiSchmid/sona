import { describe, expect, it } from "vitest";
import {
  createWorkspaceContext,
  requireWorkspaceContext,
  type WorkspaceContext,
  type WorkspaceScopedServiceOptions,
} from "./tenancy";

class TestWorkspaceService {
  readonly context: WorkspaceContext;

  constructor(options: WorkspaceScopedServiceOptions) {
    this.context = requireWorkspaceContext(options.context);
  }
}

describe("workspace context", () => {
  it("creates an explicit workspace context", () => {
    const context = createWorkspaceContext({
      workspaceId: "ws_1",
      userId: "user_1",
      requestId: "req_1",
    });

    expect(context).toEqual({
      workspaceId: "ws_1",
      userId: "user_1",
      requestId: "req_1",
    });
  });

  it("rejects an empty workspace id", () => {
    expect(() => createWorkspaceContext({ workspaceId: "" })).toThrow(/workspaceId/);
  });

  it("rejects missing workspace context for service constructors", () => {
    expect(
      () => new TestWorkspaceService({ context: undefined as unknown as WorkspaceContext }),
    ).toThrow(/workspace context/);
  });

  it("rejects service context with a blank workspace id", () => {
    expect(() => new TestWorkspaceService({ context: { workspaceId: " " } })).toThrow(
      /workspaceId/,
    );
  });
});
