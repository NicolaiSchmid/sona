import { describe, expect, it } from "vitest";
import { type EnqueueJobInput, JobLeaseLostError, SqliteJobRepository } from "./jobs.js";
import { createTestDatabase } from "./test-support.js";

const T0 = "2026-02-01T00:00:00.000Z";
const T1 = "2026-02-01T00:05:00.000Z";
const T2 = "2026-02-01T01:00:00.000Z";

function enqueueInput(overrides: Partial<EnqueueJobInput> = {}): EnqueueJobInput {
  return {
    id: "job_1",
    workspaceId: "ws_1",
    kind: "source_sync",
    payload: { sourceId: "src_1" },
    idempotencyKey: "source_sync:src_1",
    maxAttempts: 3,
    runAfter: T0,
    createdAt: T0,
    ...overrides,
  };
}

function claimOne(repo: SqliteJobRepository, workerId: string, now = T0) {
  return repo.claim({
    workerId,
    now,
    leaseMs: 60_000,
    limit: 1,
    runIdFor: (job, attempt) => `${job.id}:run:${attempt}`,
  });
}

describe("SqliteJobRepository", () => {
  it("enqueues once per idempotency key and returns the existing job on repeats", async () => {
    const t = createTestDatabase();
    try {
      const repo = new SqliteJobRepository(t.db);
      const first = await repo.enqueue(enqueueInput());
      const second = await repo.enqueue(enqueueInput({ id: "job_2", createdAt: T1 }));

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.job.id).toBe("job_1");
      expect(await repo.list("ws_1")).toHaveLength(1);

      // The same key in another workspace is a different job.
      const other = await repo.enqueue(enqueueInput({ id: "job_ws2", workspaceId: "ws_2" }));
      expect(other.created).toBe(true);
      expect(await repo.getById("ws_1", "job_ws2")).toBeUndefined();
      expect(await repo.getByIdempotencyKey("ws_2", "source_sync:src_1")).toMatchObject({
        id: "job_ws2",
      });
    } finally {
      t.close();
    }
  });

  it("rejects a non-positive maxAttempts", async () => {
    const t = createTestDatabase();
    try {
      const repo = new SqliteJobRepository(t.db);
      await expect(repo.enqueue(enqueueInput({ maxAttempts: 0 }))).rejects.toThrow(/maxAttempts/);
    } finally {
      t.close();
    }
  });

  it("walks a job through claim, run, and success with provenance", async () => {
    const t = createTestDatabase();
    try {
      const repo = new SqliteJobRepository(t.db);
      await repo.enqueue(enqueueInput());

      const claimed = await claimOne(repo, "w1");
      expect(claimed).toHaveLength(1);
      const { job, run } = claimed[0] ?? fail("no claim");
      expect(job).toMatchObject({ status: "running", attempts: 1, leaseOwner: "w1" });
      expect(job.leaseUntil).toBe("2026-02-01T00:01:00.000Z");
      expect(run).toMatchObject({ id: "job_1:run:1", attempt: 1, status: "running" });

      // A second worker cannot claim the leased job.
      expect(await claimOne(repo, "w2")).toHaveLength(0);

      const done = await repo.succeed({
        workspaceId: "ws_1",
        jobId: "job_1",
        runId: run.id,
        workerId: "w1",
        finishedAt: T1,
        result: { drafts: 2 },
        produced: [{ type: "ledger_transaction", id: "tx_1" }],
      });
      expect(done).toMatchObject({
        status: "succeeded",
        leaseOwner: undefined,
        leaseUntil: undefined,
        lastError: undefined,
      });
      const runs = await repo.listRuns("ws_1", "job_1");
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        status: "succeeded",
        finishedAt: T1,
        result: { drafts: 2 },
        produced: [{ type: "ledger_transaction", id: "tx_1" }],
      });
      // Nothing left to claim.
      expect(await claimOne(repo, "w1", T2)).toHaveLength(0);
    } finally {
      t.close();
    }
  });

  it("re-queues a failed job for its retry time and dead-letters without one", async () => {
    const t = createTestDatabase();
    try {
      const repo = new SqliteJobRepository(t.db);
      await repo.enqueue(enqueueInput({ maxAttempts: 2 }));

      const [first] = await claimOne(repo, "w1");
      const retried = await repo.fail({
        workspaceId: "ws_1",
        jobId: "job_1",
        runId: first?.run.id ?? "",
        workerId: "w1",
        finishedAt: T0,
        error: "Error: transient",
        retryAt: T1,
      });
      expect(retried).toMatchObject({
        status: "queued",
        attempts: 1,
        runAfter: T1,
        lastError: "Error: transient",
        leaseOwner: undefined,
      });
      // Not before its retry time...
      expect(await claimOne(repo, "w1", T0)).toHaveLength(0);
      // ...but claimable once it has passed.
      const [second] = await claimOne(repo, "w1", T1);
      expect(second?.job.attempts).toBe(2);
      expect(second?.run.attempt).toBe(2);

      const dead = await repo.fail({
        workspaceId: "ws_1",
        jobId: "job_1",
        runId: second?.run.id ?? "",
        workerId: "w1",
        finishedAt: T2,
        error: "Error: still failing",
        retryAt: undefined,
      });
      expect(dead.status).toBe("dead");
      expect(await claimOne(repo, "w1", "2026-03-01T00:00:00.000Z")).toHaveLength(0);
      expect((await repo.listRuns("ws_1", "job_1")).map((run) => run.status)).toEqual([
        "failed",
        "failed",
      ]);
    } finally {
      t.close();
    }
  });

  it("lets another worker take over an expired lease and closes the orphaned run", async () => {
    const t = createTestDatabase();
    try {
      const repo = new SqliteJobRepository(t.db);
      await repo.enqueue(enqueueInput());
      const [first] = await claimOne(repo, "w1", T0);

      // Lease of 60s: still held at +5min? No — expired, so w2 may take over.
      const [takeover] = await claimOne(repo, "w2", T1);
      expect(takeover?.job).toMatchObject({ leaseOwner: "w2", attempts: 2 });
      expect(takeover?.run.attempt).toBe(2);

      const runs = await repo.listRuns("ws_1", "job_1");
      expect(runs.map((run) => [run.attempt, run.status])).toEqual([
        [1, "failed"],
        [2, "running"],
      ]);
      expect(runs[0]?.error).toMatch(/lease expired/);

      // The slow first worker can no longer write an outcome.
      await expect(
        repo.succeed({
          workspaceId: "ws_1",
          jobId: "job_1",
          runId: first?.run.id ?? "",
          workerId: "w1",
          finishedAt: T2,
          produced: [],
        }),
      ).rejects.toBeInstanceOf(JobLeaseLostError);
      expect((await repo.getById("ws_1", "job_1"))?.status).toBe("running");
    } finally {
      t.close();
    }
  });

  it("rejects outcome writes for a job that already settled", async () => {
    const t = createTestDatabase();
    try {
      const repo = new SqliteJobRepository(t.db);
      await repo.enqueue(enqueueInput());
      const [claimed] = await claimOne(repo, "w1");
      const outcome = {
        workspaceId: "ws_1",
        jobId: "job_1",
        runId: claimed?.run.id ?? "",
        workerId: "w1",
        finishedAt: T1,
        produced: [],
      };
      await repo.succeed(outcome);
      await expect(repo.succeed(outcome)).rejects.toThrow(/not running/);
      await expect(
        repo.fail({ ...outcome, error: "late", retryAt: undefined }),
      ).rejects.toBeInstanceOf(JobLeaseLostError);
    } finally {
      t.close();
    }
  });

  it("claims oldest-first, honours kind filters and limits, and never mixes workspaces into one job", async () => {
    const t = createTestDatabase();
    try {
      const repo = new SqliteJobRepository(t.db);
      await repo.enqueue(
        enqueueInput({ id: "late", idempotencyKey: "k_late", createdAt: T1, runAfter: T1 }),
      );
      await repo.enqueue(enqueueInput({ id: "early", idempotencyKey: "k_early" }));
      await repo.enqueue(
        enqueueInput({
          id: "extract",
          kind: "extraction",
          idempotencyKey: "k_extract",
          payload: { documentId: "doc" },
        }),
      );
      await repo.enqueue(
        enqueueInput({ id: "other_ws", workspaceId: "ws_2", idempotencyKey: "k_other" }),
      );

      const onlyExtraction = await repo.claim({
        workerId: "w1",
        now: T2,
        leaseMs: 1000,
        limit: 5,
        kinds: ["extraction"],
        runIdFor: (job, attempt) => `${job.id}:${attempt}`,
      });
      expect(onlyExtraction.map((c) => c.job.id)).toEqual(["extract"]);

      const rest = await repo.claim({
        workerId: "w1",
        now: T2,
        leaseMs: 1000,
        limit: 2,
        runIdFor: (job, attempt) => `${job.id}:${attempt}`,
      });
      expect(rest.map((c) => c.job.id)).toEqual(["early", "other_ws"]);
      expect(rest.map((c) => c.job.workspaceId)).toEqual(["ws_1", "ws_2"]);

      expect((await repo.list("ws_1", { statuses: ["queued"] })).map((j) => j.id)).toEqual([
        "late",
      ]);
      expect(await repo.list("ws_1", { kinds: [] })).toEqual([]);
      expect(await repo.list("ws_2")).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  it("validates claim and list arguments and returns nothing for an empty kind filter", async () => {
    const t = createTestDatabase();
    try {
      const repo = new SqliteJobRepository(t.db);
      await repo.enqueue(enqueueInput());
      const base = { workerId: "w1", now: T0, leaseMs: 1000, runIdFor: () => "run" };

      expect(await repo.claim({ ...base, limit: 5, kinds: [] })).toEqual([]);
      // The job is still untouched and claimable.
      expect((await repo.getById("ws_1", "job_1"))?.status).toBe("queued");
      await expect(repo.claim({ ...base, limit: 0 })).rejects.toThrow(/positive integer/);
      await expect(repo.claim({ ...base, limit: 2.5 })).rejects.toThrow(/positive integer/);

      await expect(repo.list("ws_1", { limit: 0 })).rejects.toThrow(/positive integer/);
      await repo.enqueue(enqueueInput({ id: "job_2", idempotencyKey: "k2", createdAt: T1 }));
      expect((await repo.list("ws_1", { limit: 1 })).map((j) => j.id)).toEqual(["job_1"]);
      expect(await repo.list("ws_1", { statuses: [] })).toEqual([]);
      expect(await repo.list("ws_1", { statuses: ["dead"] })).toEqual([]);
    } finally {
      t.close();
    }
  });

  it("does not claim a job before its runAfter, even when queued", async () => {
    const t = createTestDatabase();
    try {
      const repo = new SqliteJobRepository(t.db);
      await repo.enqueue(enqueueInput({ runAfter: T2 }));
      expect(await claimOne(repo, "w1", T0)).toHaveLength(0);
      expect(await claimOne(repo, "w1", T1)).toHaveLength(0);
      // Boundary: runAfter <= now is claimable.
      expect((await claimOne(repo, "w1", T2)).map((c) => c.job.id)).toEqual(["job_1"]);
    } finally {
      t.close();
    }
  });

  it("keeps a lease that ends exactly now and only hands it over once it has lapsed", async () => {
    const t = createTestDatabase();
    try {
      const repo = new SqliteJobRepository(t.db);
      await repo.enqueue(enqueueInput());
      const [first] = await claimOne(repo, "w1", T0);
      const leaseUntil = first?.job.leaseUntil ?? fail("no lease");
      expect(leaseUntil).toBe("2026-02-01T00:01:00.000Z");

      // lease_until < now is the takeover condition; equality is still held.
      expect(await claimOne(repo, "w2", leaseUntil)).toHaveLength(0);
      expect((await repo.getById("ws_1", "job_1"))?.leaseOwner).toBe("w1");

      const oneMsLater = new Date(Date.parse(leaseUntil) + 1).toISOString();
      const [takeover] = await claimOne(repo, "w2", oneMsLater);
      expect(takeover?.job).toMatchObject({ leaseOwner: "w2", attempts: 2 });
    } finally {
      t.close();
    }
  });

  it("stores a null result when a run succeeds without one and reads runs back by id per workspace", async () => {
    const t = createTestDatabase();
    try {
      const repo = new SqliteJobRepository(t.db);
      await repo.enqueue(enqueueInput());
      const [claimed] = await claimOne(repo, "w1");
      const runId = claimed?.run.id ?? fail("no claim");

      expect(await repo.getRun("ws_1", runId)).toMatchObject({
        id: runId,
        jobId: "job_1",
        status: "running",
        result: undefined,
        produced: [],
      });
      expect(await repo.getRun("ws_2", runId)).toBeUndefined();
      expect(await repo.getRun("ws_1", "missing")).toBeUndefined();

      await repo.succeed({
        workspaceId: "ws_1",
        jobId: "job_1",
        runId,
        workerId: "w1",
        finishedAt: T1,
        produced: [],
      });
      const run = await repo.getRun("ws_1", runId);
      expect(run).toMatchObject({ status: "succeeded", finishedAt: T1, result: undefined });
      const raw = t.db
        .prepare("SELECT result_json, produced_json FROM job_runs WHERE id = ?")
        .get(runId) as { result_json: string | null; produced_json: string };
      expect(raw.result_json).toBeNull();
      expect(raw.produced_json).toBe("[]");
    } finally {
      t.close();
    }
  });

  it("rejects outcome writes with a run id that is not the current attempt", async () => {
    const t = createTestDatabase();
    try {
      const repo = new SqliteJobRepository(t.db);
      await repo.enqueue(enqueueInput());
      const [first] = await claimOne(repo, "w1", T0);
      await repo.fail({
        workspaceId: "ws_1",
        jobId: "job_1",
        runId: first?.run.id ?? "",
        workerId: "w1",
        finishedAt: T0,
        error: "transient",
        retryAt: T1,
      });
      const [second] = await claimOne(repo, "w1", T1);
      expect(second?.run.attempt).toBe(2);

      // Same worker, but the stale run id from attempt 1.
      await expect(
        repo.succeed({
          workspaceId: "ws_1",
          jobId: "job_1",
          runId: first?.run.id ?? "",
          workerId: "w1",
          finishedAt: T2,
          produced: [],
        }),
      ).rejects.toThrow(/not the current attempt/);
      // A run id that does not exist at all.
      await expect(
        repo.succeed({
          workspaceId: "ws_1",
          jobId: "job_1",
          runId: "job_1:run:99",
          workerId: "w1",
          finishedAt: T2,
          produced: [],
        }),
      ).rejects.toThrow(/not found/);
      expect((await repo.getById("ws_1", "job_1"))?.status).toBe("running");
    } finally {
      t.close();
    }
  });

  it("surfaces malformed provenance instead of silently dropping it", async () => {
    const t = createTestDatabase();
    try {
      const repo = new SqliteJobRepository(t.db);
      await repo.enqueue(enqueueInput());
      const [claimed] = await claimOne(repo, "w1");
      const runId = claimed?.run.id ?? fail("no claim");
      for (const produced of ['{"type":"x"}', '[{"type":"document"}]', "[1]"]) {
        t.db.prepare("UPDATE job_runs SET produced_json = ? WHERE id = ?").run(produced, runId);
        await expect(repo.getRun("ws_1", runId)).rejects.toThrow(/produced/);
      }
    } finally {
      t.close();
    }
  });

  it("refuses a run row that points at a job of another workspace", async () => {
    const t = createTestDatabase();
    try {
      const repo = new SqliteJobRepository(t.db);
      await repo.enqueue(enqueueInput());
      // The composite foreign key (workspace_id, job_id) → jobs(workspace_id, id)
      // makes a cross-tenant run row impossible even for raw SQL.
      expect(() =>
        t.db
          .prepare(
            "INSERT INTO job_runs (id, workspace_id, job_id, attempt, worker_id, status, started_at, produced_json) VALUES ('run_x', 'ws_2', 'job_1', 1, 'w1', 'running', ?, '[]')",
          )
          .run(T0),
      ).toThrow(/FOREIGN KEY/i);
      expect(await repo.listRuns("ws_2", "job_1")).toEqual([]);
    } finally {
      t.close();
    }
  });
});

function fail(message: string): never {
  throw new Error(message);
}
