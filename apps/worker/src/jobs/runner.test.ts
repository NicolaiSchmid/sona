import { createWorkspaceContext } from "@sona/core";
import { SqliteAuditEventRepository, SqliteJobRepository } from "@sona/db";
import { describe, expect, it } from "vitest";
import { createTestHarness, WS_1 } from "../test-support.js";
import { JobQueue } from "./queue.js";
import {
  backoffMs,
  DEFAULT_BACKOFF_POLICY,
  type JobHandlers,
  JobRunner,
  NonRetryableJobError,
} from "./runner.js";

const context = createWorkspaceContext({ workspaceId: WS_1 });

/** A runner whose handlers are test doubles, over the harness database. */
async function createRunnerHarness(handlers: Partial<JobHandlers>) {
  const harness = await createTestHarness({ seedSources: false });
  const jobs = new SqliteJobRepository(harness.db);
  const auditEvents = new SqliteAuditEventRepository(harness.db);
  const queue = new JobQueue(jobs, {
    ids: harness.ids,
    now: harness.clock.now,
    defaultMaxAttempts: 3,
  });
  const unused = async () => {
    throw new Error("handler not under test");
  };
  const runner = new JobRunner(
    {
      db: harness.db,
      jobs,
      auditEvents,
      queue,
      handlers: {
        source_sync: unused,
        document_ingest: unused,
        extraction: unused,
        reconciliation: unused,
        export_generation: unused,
        portal_fetch: unused,
        ...handlers,
      },
    },
    {
      workerId: "worker-test",
      now: harness.clock.now,
      leaseMs: 60_000,
      backoff: { baseMs: 1_000, factor: 2, maxMs: 3_000 },
    },
  );
  return { harness, jobs, auditEvents, queue, runner };
}

describe("backoffMs", () => {
  it("grows exponentially and is capped", () => {
    const policy = { baseMs: 1_000, factor: 2, maxMs: 5_000 };
    expect([1, 2, 3, 4].map((n) => backoffMs(policy, n))).toEqual([1_000, 2_000, 4_000, 5_000]);
    expect(backoffMs(DEFAULT_BACKOFF_POLICY, 1)).toBe(30_000);
    expect(() => backoffMs(policy, 0)).toThrow(/positive integer/);
  });
});

describe("JobRunner", () => {
  it("runs an idempotent job once, records provenance and one audit event per run", async () => {
    const calls: string[] = [];
    const { harness, queue, runner, auditEvents } = await createRunnerHarness({
      extraction: async ({ job, produced }) => {
        calls.push(job.payload.documentId);
        produced({ type: "document_extraction", id: `ex:${job.payload.documentId}` });
        produced({ type: "document_extraction", id: `ex:${job.payload.documentId}` });
        return { ok: true };
      },
    });
    try {
      const first = await queue.enqueue(context, "extraction", { documentId: "doc_1" });
      const dup = await queue.enqueue(context, "extraction", { documentId: "doc_1" });
      expect(dup.created).toBe(false);
      expect(dup.job.id).toBe(first.job.id);

      const outcomes = await runner.runOnce();
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({
        jobId: first.job.id,
        kind: "extraction",
        attempt: 1,
        state: "succeeded",
        produced: [{ type: "document_extraction", id: "ex:doc_1" }],
      });
      expect(calls).toEqual(["doc_1"]);

      // Nothing left; re-enqueueing the same key after success is still a no-op.
      expect(await runner.runOnce()).toEqual([]);
      expect((await queue.enqueue(context, "extraction", { documentId: "doc_1" })).created).toBe(
        false,
      );
      expect(calls).toEqual(["doc_1"]);

      const runs = await queue.listRuns(context, first.job.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        status: "succeeded",
        result: { ok: true },
        produced: [{ type: "document_extraction", id: "ex:doc_1" }],
      });
      const audit = await auditEvents.list(WS_1);
      expect(audit.events).toHaveLength(1);
      expect(audit.events[0]).toMatchObject({
        action: "job.run.succeeded",
        actor: "worker:worker-test",
        targetType: "job",
        targetId: first.job.id,
        metadata: { kind: "extraction", attempt: 1, runId: runs[0]?.id },
      });
    } finally {
      harness.close();
    }
  });

  it("retries with exponential backoff and dead-letters after max attempts", async () => {
    let attempts = 0;
    const { harness, queue, runner, auditEvents } = await createRunnerHarness({
      reconciliation: async () => {
        attempts += 1;
        throw new Error(`boom ${attempts} Bearer secrettoken123`);
      },
    });
    try {
      const { job } = await queue.enqueue(
        context,
        "reconciliation",
        { documentId: "doc_1" },
        {
          maxAttempts: 3,
        },
      );

      const first = await runner.runOnce();
      expect(first[0]).toMatchObject({
        state: "retry_scheduled",
        attempt: 1,
        runAfter: "2026-02-01T00:00:01.000Z",
      });
      expect(first[0]?.error).toBe("Error: boom 1 Bearer [redacted]");
      let persisted = await queue.get(context, job.id);
      expect(persisted).toMatchObject({ status: "queued", attempts: 1 });
      expect(persisted?.lastError).not.toContain("secrettoken123");

      // Not due yet.
      expect(await runner.runOnce()).toEqual([]);
      harness.clock.advance(1_000);
      const second = await runner.runOnce();
      expect(second[0]).toMatchObject({
        state: "retry_scheduled",
        attempt: 2,
        runAfter: "2026-02-01T00:00:03.000Z",
      });

      harness.clock.advance(2_000);
      const third = await runner.runOnce();
      expect(third[0]).toMatchObject({ state: "dead", attempt: 3, runAfter: undefined });
      persisted = await queue.get(context, job.id);
      expect(persisted?.status).toBe("dead");
      expect(attempts).toBe(3);

      harness.clock.advance(60_000);
      expect(await runner.runOnce()).toEqual([]);

      const runs = await queue.listRuns(context, job.id);
      expect(runs.map((run) => run.status)).toEqual(["failed", "failed", "failed"]);
      const audit = await auditEvents.list(WS_1);
      expect(audit.events.map((event) => event.action)).toEqual([
        "job.run.failed",
        "job.run.failed",
        "job.run.failed",
      ]);
      expect(audit.events[2]?.metadata).toMatchObject({ dead: true, retryAt: null });
    } finally {
      harness.close();
    }
  });

  it("dead-letters immediately on NonRetryableJobError and keeps produced refs", async () => {
    const { harness, queue, runner } = await createRunnerHarness({
      source_sync: async ({ produced }) => {
        produced({ type: "source_sync_run", id: "run_1" });
        throw new NonRetryableJobError("source missing");
      },
    });
    try {
      const { job } = await queue.enqueue(context, "source_sync", { sourceId: "nope" });
      const [outcome] = await runner.runOnce();
      expect(outcome).toMatchObject({
        state: "dead",
        attempt: 1,
        error: "NonRetryableJobError: source missing",
        produced: [{ type: "source_sync_run", id: "run_1" }],
      });
      expect((await queue.get(context, job.id))?.status).toBe("dead");
      expect((await queue.listRuns(context, job.id))[0]?.produced).toEqual([
        { type: "source_sync_run", id: "run_1" },
      ]);
    } finally {
      harness.close();
    }
  });

  it("lets handlers enqueue follow-up jobs in the job's own workspace only", async () => {
    const { harness, queue, runner } = await createRunnerHarness({
      document_ingest: async ({ enqueue, job }) => {
        const follow = await enqueue("extraction", { documentId: `doc:${job.payload.uploadId}` });
        return { extractionJobId: follow.job.id };
      },
      extraction: async () => undefined,
    });
    try {
      const other = createWorkspaceContext({ workspaceId: "ws_2" });
      await queue.enqueue(context, "document_ingest", { uploadId: "up_1" });
      await queue.enqueue(other, "document_ingest", { uploadId: "up_2" });

      const outcomes = await runner.runOnce({ kinds: ["document_ingest"] });
      expect(outcomes.map((o) => [o.workspaceId, o.state])).toEqual([
        ["ws_1", "succeeded"],
        ["ws_2", "succeeded"],
      ]);
      const ws1Jobs = await queue.list(context, { kinds: ["extraction"] });
      const ws2Jobs = await queue.list(other, { kinds: ["extraction"] });
      expect(ws1Jobs.map((j) => j.payload)).toEqual([{ documentId: "doc:up_1" }]);
      expect(ws2Jobs.map((j) => j.payload)).toEqual([{ documentId: "doc:up_2" }]);
      // A workspace cannot read another workspace's job by id.
      expect(await queue.get(other, ws1Jobs[0]?.id ?? "")).toBeUndefined();

      expect((await runner.runOnce()).map((o) => o.kind)).toEqual(["extraction", "extraction"]);
    } finally {
      harness.close();
    }
  });

  it("stores a null result for handlers that return nothing and dedupes produced refs", async () => {
    const { harness, queue, runner } = await createRunnerHarness({
      reconciliation: async ({ produced }) => {
        produced({ type: "match_candidate", id: "m_1" });
        produced({ type: "match_candidate", id: "m_1" });
        produced({ type: "review_item", id: "m_1" });
        return undefined;
      },
    });
    try {
      const { job } = await queue.enqueue(context, "reconciliation", { documentId: "doc_1" });
      const [outcome] = await runner.runOnce();
      expect(outcome?.produced).toEqual([
        { type: "match_candidate", id: "m_1" },
        { type: "review_item", id: "m_1" },
      ]);
      const [run] = await queue.listRuns(context, job.id);
      expect(run).toMatchObject({ status: "succeeded", result: undefined });
      expect(run?.produced).toEqual(outcome?.produced);
    } finally {
      harness.close();
    }
  });

  it("lets callers schedule a job for later and cap its attempts", async () => {
    const { harness, queue, runner } = await createRunnerHarness({
      extraction: async () => {
        throw new Error("always");
      },
    });
    try {
      const later = "2026-02-01T00:10:00.000Z";
      const { job } = await queue.enqueue(
        context,
        "extraction",
        { documentId: "doc_1" },
        { runAfter: later, maxAttempts: 1 },
      );
      expect(job).toMatchObject({ runAfter: later, maxAttempts: 1, status: "queued" });
      expect(await runner.runOnce()).toEqual([]);
      expect(await queue.list(context, { statuses: ["queued"] })).toHaveLength(1);
      expect(await queue.list(context, { statuses: ["running", "dead"] })).toEqual([]);

      harness.clock.set(later);
      const [outcome] = await runner.runOnce();
      // One allowed attempt: the first failure dead-letters.
      expect(outcome).toMatchObject({ state: "dead", attempt: 1 });
      expect(await queue.list(context, { statuses: ["dead"], kinds: ["extraction"] })).toHaveLength(
        1,
      );
      expect(await queue.list(context, { statuses: ["dead"], kinds: ["source_sync"] })).toEqual([]);
    } finally {
      harness.close();
    }
  });

  it("dead-letters a persisted job of a kind this worker does not know", async () => {
    const { harness, jobs, queue, runner, auditEvents } = await createRunnerHarness({});
    try {
      // A newer writer (or a manual insert) can leave a kind this worker
      // version has no handler for; the typed queue never produces one.
      harness.db
        .prepare(
          "INSERT INTO jobs (id, workspace_id, kind, payload_json, idempotency_key, status, attempts, max_attempts, run_after, created_at, updated_at) VALUES ('job_legacy', ?, 'portal_fetch_v0', '{}', 'legacy', 'queued', 0, 3, ?, ?, ?)",
        )
        .run(WS_1, harness.clock.now(), harness.clock.now(), harness.clock.now());

      const [outcome] = await runner.runOnce();
      expect(outcome).toMatchObject({
        jobId: "job_legacy",
        kind: "portal_fetch_v0",
        state: "dead",
        error: 'NonRetryableJobError: unknown job kind "portal_fetch_v0"',
      });
      expect((await jobs.getById(WS_1, "job_legacy"))?.status).toBe("dead");
      expect((await auditEvents.list(WS_1)).events.map((e) => e.action)).toEqual([
        "job.run.failed",
      ]);
      // The typed facade refuses to narrow it rather than guessing a payload shape.
      await expect(queue.get(context, "job_legacy")).rejects.toThrow(/unknown kind/);
    } finally {
      harness.close();
    }
  });

  it("never overwrites a newer attempt when its own lease lapsed mid-handler", async () => {
    let attempts = 0;
    const { harness, jobs, queue, runner, auditEvents } = await createRunnerHarness({
      extraction: async () => {
        attempts += 1;
        if (attempts > 1) {
          return { attempt: attempts };
        }
        // The handler outlives its 60s lease and another worker takes the job over.
        harness.clock.advance(61_000);
        const takeover = await jobs.claim({
          workerId: "worker-other",
          now: harness.clock.now(),
          leaseMs: 60_000,
          limit: 1,
          runIdFor: (job, attempt) => `${job.id}:other:${attempt}`,
        });
        expect(takeover.map((c) => c.job.id)).toEqual([slowJobId]);
        return { attempt: attempts };
      },
    });
    let slowJobId = "";
    try {
      const slow = await queue.enqueue(
        context,
        "extraction",
        { documentId: "slow" },
        { idempotencyKey: "slow" },
      );
      slowJobId = slow.job.id;
      const next = await queue.enqueue(
        context,
        "extraction",
        { documentId: "next" },
        { idempotencyKey: "next" },
      );

      // The terminal write is refused: the slow worker's result never lands,
      // but the lost lease is an outcome, not an exception, so the rest of the
      // batch still runs.
      const outcomes = await runner.runOnce();
      expect(outcomes.map((o) => [o.jobId, o.attempt, o.state])).toEqual([
        [slow.job.id, 1, "lease_lost"],
        [next.job.id, 1, "succeeded"],
      ]);
      expect(outcomes[0]?.error).toMatch(/lease is held by worker-other/);

      expect(await jobs.getById(WS_1, slow.job.id)).toMatchObject({
        status: "running",
        leaseOwner: "worker-other",
        attempts: 2,
      });
      const runs = await jobs.listRuns(WS_1, slow.job.id);
      expect(runs.map((run) => [run.attempt, run.status, run.workerId])).toEqual([
        [1, "failed", "worker-test"],
        [2, "running", "worker-other"],
      ]);
      expect(runs[0]?.result).toBeUndefined();
      // Only the job that actually settled has an audit event.
      expect((await auditEvents.list(WS_1)).events.map((e) => e.targetId)).toEqual([next.job.id]);

      // `slow` stays with worker-other until that lease lapses too.
      expect(await runner.runOnce()).toEqual([]);
      harness.clock.advance(61_000);
      expect((await runner.runOnce()).map((o) => [o.jobId, o.attempt, o.state])).toEqual([
        [slow.job.id, 3, "succeeded"],
      ]);
    } finally {
      harness.close();
    }
  });

  it("starts each lease when its job starts, so a slow job cannot expire the ones behind it", async () => {
    const { harness, queue, runner } = await createRunnerHarness({
      extraction: async ({ job }) => {
        if (job.payload.documentId === "slow") {
          // Longer than the 60s lease.
          harness.clock.advance(90_000);
        }
        return { documentId: job.payload.documentId };
      },
    });
    try {
      const slow = await queue.enqueue(context, "extraction", { documentId: "slow" });
      const quick = await queue.enqueue(context, "extraction", { documentId: "quick" });
      const outcomes = await runner.runOnce();
      expect(outcomes.map((o) => [o.jobId, o.state])).toEqual([
        [slow.job.id, "succeeded"],
        [quick.job.id, "succeeded"],
      ]);
      // `quick` was claimed only after `slow` finished, so its lease and run
      // start 90s later rather than at batch time.
      const slowRun = (await queue.listRuns(context, slow.job.id))[0];
      const quickRun = (await queue.listRuns(context, quick.job.id))[0];
      expect(slowRun?.startedAt).toBe("2026-02-01T00:00:00.000Z");
      expect(quickRun?.startedAt).toBe("2026-02-01T00:01:30.000Z");
    } finally {
      harness.close();
    }
  });

  it("refuses invalid payloads at enqueue time before anything is persisted", async () => {
    const { harness, queue } = await createRunnerHarness({});
    try {
      await expect(
        queue.enqueue(context, "export_generation", { year: Number.NaN }),
      ).rejects.toThrow(/export_generation/);
      expect(await queue.list(context)).toEqual([]);
    } finally {
      harness.close();
    }
  });
});
