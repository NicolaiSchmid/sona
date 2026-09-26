import { createRequire } from "node:module";
import { createRawSourceRecord } from "@sona/core";
import { describe, expect, it } from "vitest";
import { CORE_MIGRATIONS } from "../migrations/index.js";
import {
  applyMigrations,
  createSqliteDbClient,
  type DbClient,
  type SqliteDatabase,
} from "../runner.js";
import {
  createWorkspaceEmailSyncRunStore,
  SqliteEmailSyncRunRepository,
} from "./email-sync-runs.js";
import { SqliteRawRecordRepository } from "./raw-records.js";
import type { EmailSyncSummary } from "./types.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

function createTestDatabase(): { db: DbClient; close: () => void } {
  const sqlite = new DatabaseSync(":memory:") as SqliteDatabase;
  sqlite.exec("PRAGMA foreign_keys = ON");
  const db = createSqliteDbClient(sqlite);
  applyMigrations(db, CORE_MIGRATIONS);
  for (const [workspaceId, sourceId] of [
    ["ws_1", "src_1"],
    ["ws_2", "src_2"],
  ] as const) {
    db.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)").run(
      workspaceId,
      workspaceId,
      "2026-01-01T00:00:00Z",
    );
    db.prepare(
      "INSERT INTO sources (id, workspace_id, kind, display_name, status, created_at) VALUES (?, ?, 'email', ?, 'active', ?)",
    ).run(sourceId, workspaceId, sourceId, "2026-01-01T00:00:00Z");
  }
  return { db, close: () => sqlite.close() };
}

function summary(runId: string, lastUid: number): EmailSyncSummary {
  return {
    runId,
    messagesSeen: 3,
    messagesIngested: 2,
    messagesSkippedNotAllowlisted: 1,
    messagesSkippedDuplicate: 0,
    messagesWithoutDocuments: 0,
    attachmentsStored: 2,
    attachmentsDeduplicated: 0,
    attachmentsSkipped: 1,
    cursorReset: undefined,
    cursor: { folder: "INBOX", uidValidity: "1710000000", lastUid, policyHash: "policy_a" },
    errors: [{ uid: 5, message: "download failed" }],
  };
}

describe("SqliteEmailSyncRunRepository", () => {
  it("persists runs with redacted errors, summary, and the per-run cursor", async () => {
    const { db, close } = createTestDatabase();
    try {
      const repo = new SqliteEmailSyncRunRepository(db);
      await repo.start({
        runId: "run_1",
        workspaceId: "ws_1",
        sourceId: "src_1",
        startedAt: "2026-02-01T00:00:00Z",
      });
      expect(await repo.get("ws_1", "run_1")).toMatchObject({
        status: "running",
        finishedAt: undefined,
        errors: [],
        summary: undefined,
      });

      await repo.recordError("ws_1", {
        runId: "run_1",
        uid: 5,
        message: "download failed",
        at: "2026-02-01T00:00:01Z",
      });
      await repo.recordError("ws_1", {
        runId: "run_1",
        uid: undefined,
        message: "logout failed",
        at: "2026-02-01T00:00:02Z",
      });
      const finished = summary("run_1", 4);
      await repo.finish("ws_1", {
        runId: "run_1",
        status: "completed_with_errors",
        finishedAt: "2026-02-01T00:00:03Z",
        summary: finished,
      });

      const run = await repo.get("ws_1", "run_1");
      expect(run).toEqual({
        runId: "run_1",
        workspaceId: "ws_1",
        sourceId: "src_1",
        status: "completed_with_errors",
        startedAt: "2026-02-01T00:00:00Z",
        finishedAt: "2026-02-01T00:00:03Z",
        errors: [
          { uid: 5, message: "download failed", at: "2026-02-01T00:00:01Z" },
          { uid: undefined, message: "logout failed", at: "2026-02-01T00:00:02Z" },
        ],
        summary: finished,
        cursor: { folder: "INBOX", uidValidity: "1710000000", lastUid: 4, policyHash: "policy_a" },
      });
    } finally {
      close();
    }
  });

  it("returns the most recent cursor per source and folder, isolated by workspace", async () => {
    const { db, close } = createTestDatabase();
    try {
      const repo = new SqliteEmailSyncRunRepository(db);
      const key = { workspaceId: "ws_1", sourceId: "src_1", folder: "INBOX" };
      expect(await repo.latestCursor(key)).toBeUndefined();

      for (const [runId, lastUid, at] of [
        ["run_1", 10, "2026-02-01T00:00:00Z"],
        ["run_2", 25, "2026-02-02T00:00:00Z"],
      ] as const) {
        await repo.start({ runId, workspaceId: "ws_1", sourceId: "src_1", startedAt: at });
        await repo.finish("ws_1", {
          runId,
          status: "succeeded",
          finishedAt: at,
          summary: summary(runId, lastUid),
        });
      }
      // A failed run records no cursor and must not shadow the previous one.
      await repo.start({
        runId: "run_3",
        workspaceId: "ws_1",
        sourceId: "src_1",
        startedAt: "2026-02-03T00:00:00Z",
      });
      await repo.finish("ws_1", {
        runId: "run_3",
        status: "failed",
        finishedAt: "2026-02-03T00:00:00Z",
        summary: { ...summary("run_3", 0), cursor: undefined },
      });

      expect(await repo.latestCursor(key)).toEqual({
        folder: "INBOX",
        uidValidity: "1710000000",
        lastUid: 25,
        policyHash: "policy_a",
      });
      expect(await repo.latestCursor({ ...key, folder: "Archive" })).toBeUndefined();
      expect(await repo.latestCursor({ ...key, workspaceId: "ws_2" })).toBeUndefined();
      expect(await repo.get("ws_2", "run_1")).toBeUndefined();
    } finally {
      close();
    }
  });

  it("keeps cursors per folder and reads back a finished run that recorded none", async () => {
    const { db, close } = createTestDatabase();
    try {
      const repo = new SqliteEmailSyncRunRepository(db);
      const inbox = { workspaceId: "ws_1", sourceId: "src_1", folder: "INBOX" };
      await repo.start({
        runId: "run_inbox",
        workspaceId: "ws_1",
        sourceId: "src_1",
        startedAt: "2026-02-01T00:00:00Z",
      });
      await repo.finish("ws_1", {
        runId: "run_inbox",
        status: "succeeded",
        finishedAt: "2026-02-01T00:00:01Z",
        summary: summary("run_inbox", 10),
      });
      // A later run on another folder must not shadow the INBOX cursor.
      await repo.start({
        runId: "run_archive",
        workspaceId: "ws_1",
        sourceId: "src_1",
        startedAt: "2026-02-02T00:00:00Z",
      });
      const archiveCursor = {
        folder: "Archive",
        uidValidity: "99",
        lastUid: 3,
        policyHash: "policy_b",
      };
      await repo.finish("ws_1", {
        runId: "run_archive",
        status: "succeeded",
        finishedAt: "2026-02-02T00:00:01Z",
        summary: { ...summary("run_archive", 3), cursor: archiveCursor },
      });
      // A failed run finishes without a cursor.
      await repo.start({
        runId: "run_failed",
        workspaceId: "ws_1",
        sourceId: "src_1",
        startedAt: "2026-02-03T00:00:00Z",
      });
      await repo.recordError("ws_1", {
        runId: "run_failed",
        uid: undefined,
        message: "AUTHENTICATIONFAILED for [email]",
        at: "2026-02-03T00:00:00Z",
      });
      await repo.finish("ws_1", {
        runId: "run_failed",
        status: "failed",
        finishedAt: "2026-02-03T00:00:01Z",
        summary: { ...summary("run_failed", 0), cursor: undefined, errors: [] },
      });

      expect(await repo.latestCursor(inbox)).toEqual({
        folder: "INBOX",
        uidValidity: "1710000000",
        lastUid: 10,
        policyHash: "policy_a",
      });
      expect(await repo.latestCursor({ ...inbox, folder: "Archive" })).toEqual(archiveCursor);
      expect(await repo.latestCursor({ ...inbox, sourceId: "src_2" })).toBeUndefined();

      const failed = await repo.get("ws_1", "run_failed");
      expect(failed).toMatchObject({
        status: "failed",
        finishedAt: "2026-02-03T00:00:01Z",
        cursor: undefined,
        errors: [{ uid: undefined, message: "AUTHENTICATIONFAILED for [email]" }],
      });
      expect(failed?.summary?.cursor).toBeUndefined();
      expect(db.prepare("SELECT COUNT(*) AS n FROM email_sync_cursors").get()).toEqual({ n: 2 });
    } finally {
      close();
    }
  });

  it("tolerates runs whose error_json is NULL and still appends errors to them", async () => {
    const { db, close } = createTestDatabase();
    try {
      const repo = new SqliteEmailSyncRunRepository(db);
      db.prepare(
        "INSERT INTO source_sync_runs (id, workspace_id, source_id, status, started_at, finished_at, error_json) VALUES ('run_legacy', 'ws_1', 'src_1', 'succeeded', '2026-01-01T00:00:00Z', NULL, NULL)",
      ).run();

      expect(await repo.get("ws_1", "run_legacy")).toEqual({
        runId: "run_legacy",
        workspaceId: "ws_1",
        sourceId: "src_1",
        status: "succeeded",
        startedAt: "2026-01-01T00:00:00Z",
        finishedAt: undefined,
        errors: [],
        summary: undefined,
      });

      await repo.recordError("ws_1", {
        runId: "run_legacy",
        uid: 7,
        message: "late error",
        at: "2026-01-01T00:00:05Z",
      });
      expect((await repo.get("ws_1", "run_legacy"))?.errors).toEqual([
        { uid: 7, message: "late error", at: "2026-01-01T00:00:05Z" },
      ]);
    } finally {
      close();
    }
  });

  it("rejects malformed persisted metadata instead of returning partial data", async () => {
    const { db, close } = createTestDatabase();
    try {
      const repo = new SqliteEmailSyncRunRepository(db);
      db.prepare(
        "INSERT INTO source_sync_runs (id, workspace_id, source_id, status, started_at, error_json) VALUES ('run_bad', 'ws_1', 'src_1', 'succeeded', 't', ?)",
      ).run(JSON.stringify({ errors: [{ uid: 1 }] }));
      await expect(repo.get("ws_1", "run_bad")).rejects.toThrow(/malformed/);

      db.prepare(
        "INSERT INTO source_sync_runs (id, workspace_id, source_id, status, started_at, error_json) VALUES ('run_bad_summary', 'ws_1', 'src_1', 'succeeded', 't', ?)",
      ).run(JSON.stringify({ errors: [], summary: { runId: "run_bad_summary" } }));
      await expect(repo.get("ws_1", "run_bad_summary")).rejects.toThrow(/summary was malformed/);
    } finally {
      close();
    }
  });

  it("rejects a persisted cursorReset reason it does not know", async () => {
    const { db, close } = createTestDatabase();
    try {
      const repo = new SqliteEmailSyncRunRepository(db);
      const insert = db.prepare(
        "INSERT INTO source_sync_runs (id, workspace_id, source_id, status, started_at, error_json) VALUES (?, 'ws_1', 'src_1', 'succeeded', 't', ?)",
      );
      const persisted = (runId: string, cursorReset: unknown) =>
        JSON.stringify({
          errors: [],
          summary: { ...summary(runId, 4), cursor: null, errors: [], cursorReset },
        });

      insert.run("run_bogus_reset", persisted("run_bogus_reset", "bogus"));
      await expect(repo.get("ws_1", "run_bogus_reset")).rejects.toThrow(
        /cursorReset was malformed/,
      );
      insert.run("run_numeric_reset", persisted("run_numeric_reset", 1));
      await expect(repo.get("ws_1", "run_numeric_reset")).rejects.toThrow(
        /cursorReset was malformed/,
      );

      // Both known reasons and the null spelling of "no reset" round-trip.
      insert.run("run_uidv", persisted("run_uidv", "uid_validity_changed"));
      insert.run("run_policy", persisted("run_policy", "policy_changed"));
      insert.run("run_none", persisted("run_none", null));
      expect((await repo.get("ws_1", "run_uidv"))?.summary?.cursorReset).toBe(
        "uid_validity_changed",
      );
      expect((await repo.get("ws_1", "run_policy"))?.summary?.cursorReset).toBe("policy_changed");
      expect((await repo.get("ws_1", "run_none"))?.summary?.cursorReset).toBeUndefined();
    } finally {
      close();
    }
  });

  it("stores the policy hash and full 32-bit UIDs on the cursor table", async () => {
    const { db, close } = createTestDatabase();
    try {
      const columns = db.prepare("PRAGMA table_info(email_sync_cursors)").all() as Array<{
        name: string;
        type: string;
        notnull: number;
      }>;
      expect(columns.find((c) => c.name === "policy_hash")).toMatchObject({
        type: "TEXT",
        notnull: 1,
      });
      expect(columns.find((c) => c.name === "last_uid")).toMatchObject({
        type: "BIGINT",
        notnull: 1,
      });

      const repo = new SqliteEmailSyncRunRepository(db);
      const maxUid = 4_294_967_295;
      const cursor = {
        folder: "INBOX",
        uidValidity: "4294967295",
        lastUid: maxUid,
        policyHash: "a".repeat(64),
      };
      await repo.start({
        runId: "run_max",
        workspaceId: "ws_1",
        sourceId: "src_1",
        startedAt: "2026-02-01T00:00:00Z",
      });
      await repo.finish("ws_1", {
        runId: "run_max",
        status: "succeeded",
        finishedAt: "2026-02-01T00:00:01Z",
        summary: { ...summary("run_max", maxUid), cursor, errors: [] },
      });

      const latest = await repo.latestCursor({
        workspaceId: "ws_1",
        sourceId: "src_1",
        folder: "INBOX",
      });
      expect(latest).toEqual(cursor);
      expect(typeof latest?.lastUid).toBe("number");
      expect(latest?.lastUid).toBe(maxUid);
      expect((await repo.get("ws_1", "run_max"))?.cursor).toEqual(cursor);
      expect(
        db
          .prepare("SELECT last_uid, policy_hash FROM email_sync_cursors WHERE run_id = ?")
          .get("run_max"),
      ).toEqual({ last_uid: maxUid, policy_hash: "a".repeat(64) });
    } finally {
      close();
    }
  });

  it("rejects updates to runs outside the workspace and cursors without a run", async () => {
    const { db, close } = createTestDatabase();
    try {
      const repo = new SqliteEmailSyncRunRepository(db);
      await repo.start({
        runId: "run_1",
        workspaceId: "ws_1",
        sourceId: "src_1",
        startedAt: "2026-02-01T00:00:00Z",
      });
      await expect(
        repo.recordError("ws_2", { runId: "run_1", uid: 1, message: "x", at: "t" }),
      ).rejects.toThrow(/not found in workspace/);
      await expect(
        repo.finish("ws_2", {
          runId: "run_1",
          status: "succeeded",
          finishedAt: "t",
          summary: summary("run_1", 1),
        }),
      ).rejects.toThrow(/not found in workspace/);

      // Schema-level: a cursor cannot reference a run from another workspace.
      expect(() =>
        db
          .prepare(
            "INSERT INTO email_sync_cursors (run_id, workspace_id, source_id, folder, uid_validity, last_uid, policy_hash, recorded_at) VALUES ('run_1', 'ws_2', 'src_2', 'INBOX', '1', 1, 'p', 't')",
          )
          .run(),
      ).toThrow(/FOREIGN KEY constraint failed/);
    } finally {
      close();
    }
  });

  it("binds the store to one workspace", async () => {
    const { db, close } = createTestDatabase();
    try {
      const repo = new SqliteEmailSyncRunRepository(db);
      const store = createWorkspaceEmailSyncRunStore(repo, "ws_1");
      await expect(
        store.start({ runId: "r", workspaceId: "ws_2", sourceId: "src_2", startedAt: "t" }),
      ).rejects.toThrow(/workspace mismatch/);
      await expect(
        store.latestCursor({ workspaceId: "ws_2", sourceId: "src_2", folder: "INBOX" }),
      ).rejects.toThrow(/workspace mismatch/);

      await store.start({ runId: "r", workspaceId: "ws_1", sourceId: "src_1", startedAt: "t" });
      await store.finish({
        runId: "r",
        status: "succeeded",
        finishedAt: "t",
        summary: summary("r", 3),
      });
      expect(
        await store.latestCursor({ workspaceId: "ws_1", sourceId: "src_1", folder: "INBOX" }),
      ).toEqual({ folder: "INBOX", uidValidity: "1710000000", lastUid: 3, policyHash: "policy_a" });
    } finally {
      close();
    }
  });
});

describe("SqliteRawRecordRepository.findByExternalId", () => {
  it("finds records by provider identity scoped to workspace and source", async () => {
    const { db, close } = createTestDatabase();
    try {
      const repo = new SqliteRawRecordRepository(db);
      const record = (id: string, workspaceId: string, sourceId: string, externalId: string) =>
        createRawSourceRecord({
          id,
          workspaceId,
          sourceId,
          externalId,
          recordType: "document",
          payloadJson: { id },
          observedAt: "2026-02-01T00:00:00Z",
          createdAt: "2026-02-01T00:00:00Z",
        });
      await repo.append(record("raw_1", "ws_1", "src_1", "msgid:a@vendor.example"));
      await repo.append(record("raw_2", "ws_2", "src_2", "msgid:a@vendor.example"));

      expect((await repo.findByExternalId("ws_1", "src_1", "msgid:a@vendor.example"))?.id).toBe(
        "raw_1",
      );
      expect((await repo.findByExternalId("ws_2", "src_2", "msgid:a@vendor.example"))?.id).toBe(
        "raw_2",
      );
      expect(await repo.findByExternalId("ws_1", "src_1", "msgid:other")).toBeUndefined();
      expect(
        await repo.findByExternalId("ws_1", "src_2", "msgid:a@vendor.example"),
      ).toBeUndefined();

      // When the same external id was appended again (supersession), the newest wins.
      await repo.append({
        ...record("raw_3", "ws_1", "src_1", "msgid:a@vendor.example"),
        observedAt: "2026-02-02T00:00:00Z",
        createdAt: "2026-02-02T00:00:00Z",
      });
      expect((await repo.findByExternalId("ws_1", "src_1", "msgid:a@vendor.example"))?.id).toBe(
        "raw_3",
      );
    } finally {
      close();
    }
  });
});
