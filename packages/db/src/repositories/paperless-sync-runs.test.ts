import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWorkspacePaperlessSyncRunStore,
  SqlitePaperlessSyncRunRepository,
} from "./paperless-sync-runs.js";
import { createTestDatabase, type TestDatabase } from "./test-support.js";
import type { PaperlessSyncSummary } from "./types.js";

function summary(overrides: Partial<PaperlessSyncSummary> = {}): PaperlessSyncSummary {
  return {
    runId: "run_1",
    documentsSeen: 3,
    documentsIngested: 2,
    documentsSkippedNotAllowlisted: 1,
    documentsSkippedDuplicate: 0,
    documentsSkippedPolicy: 0,
    documentsStored: 2,
    documentsDeduplicated: 0,
    cursorReset: undefined,
    cursor: { lastModified: "2026-03-06T08:00:00Z", lastDocumentId: 103, policyHash: "ph_1" },
    errors: [],
    ...overrides,
  };
}

describe("SqlitePaperlessSyncRunRepository", () => {
  let test: TestDatabase;
  let repo: SqlitePaperlessSyncRunRepository;

  beforeEach(() => {
    test = createTestDatabase();
    repo = new SqlitePaperlessSyncRunRepository(test.db);
  });

  afterEach(() => {
    test.close();
  });

  it("round-trips a run with errors, summary, and cursor", async () => {
    await repo.start({
      runId: "run_1",
      workspaceId: "ws_1",
      sourceId: "src_1",
      startedAt: "2026-04-01T00:00:00Z",
    });
    expect(await repo.get("ws_1", "run_1")).toMatchObject({ status: "running", cursor: undefined });

    await repo.recordError("ws_1", {
      runId: "run_1",
      documentId: 101,
      message: "connection reset",
      at: "2026-04-01T00:00:01Z",
    });
    const finished = summary({
      errors: [{ documentId: 101, message: "connection reset" }],
      cursorReset: "policy_changed",
    });
    await repo.finish("ws_1", {
      runId: "run_1",
      status: "completed_with_errors",
      finishedAt: "2026-04-01T00:00:02Z",
      summary: finished,
    });

    const run = await repo.get("ws_1", "run_1");
    expect(run).toEqual({
      runId: "run_1",
      workspaceId: "ws_1",
      sourceId: "src_1",
      status: "completed_with_errors",
      startedAt: "2026-04-01T00:00:00Z",
      finishedAt: "2026-04-01T00:00:02Z",
      errors: [{ documentId: 101, message: "connection reset", at: "2026-04-01T00:00:01Z" }],
      summary: finished,
      cursor: finished.cursor,
    });
    expect(await repo.latestCursor({ workspaceId: "ws_1", sourceId: "src_1" })).toEqual(
      finished.cursor,
    );
  });

  it("returns the most recent cursor and none for a failed run", async () => {
    for (const [runId, at, id] of [
      ["run_a", "2026-04-01T00:00:00Z", 1],
      ["run_b", "2026-04-02T00:00:00Z", 2],
    ] as const) {
      await repo.start({ runId, workspaceId: "ws_1", sourceId: "src_1", startedAt: at });
      await repo.finish("ws_1", {
        runId,
        status: "succeeded",
        finishedAt: at,
        summary: summary({
          runId,
          cursor: { lastModified: at, lastDocumentId: id, policyHash: "ph" },
        }),
      });
    }
    await repo.start({
      runId: "run_c",
      workspaceId: "ws_1",
      sourceId: "src_1",
      startedAt: "2026-04-03T00:00:00Z",
    });
    await repo.finish("ws_1", {
      runId: "run_c",
      status: "failed",
      finishedAt: "2026-04-03T00:00:01Z",
      summary: summary({ runId: "run_c", cursor: undefined }),
    });
    expect(await repo.latestCursor({ workspaceId: "ws_1", sourceId: "src_1" })).toEqual({
      lastModified: "2026-04-02T00:00:00Z",
      lastDocumentId: 2,
      policyHash: "ph",
    });
    expect((await repo.get("ws_1", "run_c"))?.cursor).toBeUndefined();
  });

  it("isolates workspaces and binds the store to one workspace", async () => {
    await repo.start({
      runId: "run_1",
      workspaceId: "ws_1",
      sourceId: "src_1",
      startedAt: "2026-04-01T00:00:00Z",
    });
    expect(await repo.get("ws_2", "run_1")).toBeUndefined();
    await expect(
      repo.finish("ws_2", {
        runId: "run_1",
        status: "succeeded",
        finishedAt: "2026-04-01T00:00:01Z",
        summary: summary(),
      }),
    ).rejects.toThrow(/not found in workspace/);
    expect(await repo.latestCursor({ workspaceId: "ws_2", sourceId: "src_1" })).toBeUndefined();

    const store = createWorkspacePaperlessSyncRunStore(repo, "ws_2");
    await expect(
      store.start({
        runId: "run_x",
        workspaceId: "ws_1",
        sourceId: "src_1",
        startedAt: "2026-04-01T00:00:00Z",
      }),
    ).rejects.toThrow(/workspace mismatch/);
    await expect(store.latestCursor({ workspaceId: "ws_1", sourceId: "src_1" })).rejects.toThrow(
      /workspace mismatch/,
    );
  });
});
