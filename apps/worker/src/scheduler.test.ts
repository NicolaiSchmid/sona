import type { WorkspaceContext } from "@sona/core";
import { describe, expect, it } from "vitest";
import { type EnqueueOptions, type EnqueueResult, JobQueue } from "./jobs/queue.js";
import { type JobKind, type JobPayloadInput, narrowJob } from "./jobs/types.js";
import { enqueueScheduledSyncs, runScheduler, syncWindowFor, tick } from "./scheduler.js";
import { countRows, createTestHarness, SRC_1, SRC_2, WS_1, WS_2 } from "./test-support.js";

describe("syncWindowFor", () => {
  it("buckets timestamps to the window start", () => {
    expect(syncWindowFor("2026-02-01T10:17:42.000Z", 15 * 60_000)).toBe("2026-02-01T10:15:00.000Z");
    expect(syncWindowFor("2026-02-01T10:29:59.999Z", 15 * 60_000)).toBe("2026-02-01T10:15:00.000Z");
    expect(syncWindowFor("2026-02-01T10:30:00.000Z", 15 * 60_000)).toBe("2026-02-01T10:30:00.000Z");
    expect(() => syncWindowFor("nope", 1000)).toThrow(/invalid timestamp/);
    expect(() => syncWindowFor("2026-02-01T00:00:00Z", 0)).toThrow(/positive integer/);
  });
});

describe("scheduler", () => {
  it("enqueues one sync per active source per window and processes the batch", async () => {
    const h = await createTestHarness();
    try {
      await h.worker.repositories.sources.create({
        id: "src_paused",
        workspaceId: WS_1,
        kind: "enable_banking",
        displayName: "Paused",
        status: "paused",
        createdAt: h.clock.now(),
      });
      const deps = { worker: h.worker, sources: h.worker.repositories.sources };
      const options = { intervalMs: 15 * 60_000, now: h.clock.now };

      const first = await tick(deps, options);
      expect(first.window).toBe("2026-02-01T00:00:00.000Z");
      expect(first.enqueuedSyncJobIds).toHaveLength(2);
      expect(first.outcomes.map((o) => [o.workspaceId, o.kind, o.state])).toEqual([
        [WS_1, "source_sync", "succeeded"],
        [WS_2, "source_sync", "succeeded"],
      ]);
      expect(h.gatewayCalls).toEqual([
        { workspaceId: WS_1, sourceId: SRC_1 },
        { workspaceId: WS_2, sourceId: SRC_2 },
      ]);

      // Same window: nothing new is enqueued or run.
      h.clock.advance(5 * 60_000);
      const second = await tick(deps, options);
      expect(second.enqueuedSyncJobIds).toEqual([]);
      expect(second.outcomes).toEqual([]);
      expect(countRows(h.db, "jobs")).toBe(2);

      // Next window: one more sync per source, and still no duplicate ledger rows.
      h.clock.advance(15 * 60_000);
      const third = await tick(deps, options);
      expect(third.window).toBe("2026-02-01T00:15:00.000Z");
      expect(third.enqueuedSyncJobIds).toHaveLength(2);
      expect(third.outcomes.map((o) => o.state)).toEqual(["succeeded", "succeeded"]);
      expect(countRows(h.db, "ledger_transactions", WS_1)).toBe(2);
      expect(countRows(h.db, "ledger_transactions", WS_2)).toBe(1);
    } finally {
      h.close();
    }
  });

  it("only schedules syncable kinds and honours the batch size", async () => {
    const h = await createTestHarness();
    try {
      await h.worker.repositories.sources.create({
        id: "src_mail",
        workspaceId: WS_1,
        kind: "email",
        displayName: "Mailbox",
        status: "active",
        createdAt: h.clock.now(),
      });
      const deps = { worker: h.worker, sources: h.worker.repositories.sources };
      const { enqueuedJobIds: enqueued } = await enqueueScheduledSyncs(deps, "w1");
      expect(enqueued).toHaveLength(2);
      const jobs = await h.worker.queue.list(h.context, { kinds: ["source_sync"] });
      expect(jobs.map((j) => narrowJob(j, "source_sync").payload.sourceId)).toEqual([SRC_1]);

      // A tick for the current window adds two more syncs but processes only one.
      const result = await tick(deps, { intervalMs: 60_000, batchSize: 1, now: h.clock.now });
      expect(result.enqueuedSyncJobIds).toHaveLength(2);
      expect(result.outcomes).toHaveLength(1);
      expect((await h.worker.runOnce({ limit: 2 })).length).toBe(2);
      expect((await h.worker.runOnce()).length).toBe(1);
    } finally {
      h.close();
    }
  });

  it("buckets syncs by syncWindowMs independently of the tick interval", async () => {
    const h = await createTestHarness();
    try {
      const deps = { worker: h.worker, sources: h.worker.repositories.sources };
      // Ticks every minute, but one sync per source per 15-minute window.
      const options = { intervalMs: 60_000, syncWindowMs: 15 * 60_000, now: h.clock.now };
      h.clock.set("2026-02-01T00:07:00.000Z");
      const first = await tick(deps, options);
      expect(first.window).toBe("2026-02-01T00:00:00.000Z");
      expect(first.enqueuedSyncJobIds).toHaveLength(2);

      for (let minute = 0; minute < 7; minute += 1) {
        h.clock.advance(60_000);
        const result = await tick(deps, options);
        expect(result.window).toBe("2026-02-01T00:00:00.000Z");
        expect(result.enqueuedSyncJobIds).toEqual([]);
      }
      expect(countRows(h.db, "jobs")).toBe(2);

      h.clock.advance(60_000);
      const next = await tick(deps, options);
      expect(next.window).toBe("2026-02-01T00:15:00.000Z");
      expect(next.enqueuedSyncJobIds).toHaveLength(2);
      expect(countRows(h.db, "jobs")).toBe(4);

      // Explicit enqueue for a window that already has jobs reports nothing new.
      expect(
        (await enqueueScheduledSyncs(deps, "2026-02-01T00:15:00.000Z")).enqueuedJobIds,
      ).toEqual([]);
      expect(
        (await enqueueScheduledSyncs(deps, "2026-02-01T00:30:00.000Z")).enqueuedJobIds,
      ).toHaveLength(2);
    } finally {
      h.close();
    }
  });

  it("keeps scheduling and processing when one source cannot be enqueued", async () => {
    const h = await createTestHarness();
    try {
      class FailingQueue extends JobQueue {
        override async enqueue<K extends JobKind>(
          context: WorkspaceContext,
          kind: K,
          payload: JobPayloadInput<K>,
          options?: EnqueueOptions,
        ): Promise<EnqueueResult<K>> {
          if (context.workspaceId === WS_2) {
            throw new Error("FOREIGN KEY constraint failed for session_id=leaky");
          }
          return super.enqueue(context, kind, payload, options);
        }
      }
      const queue = new FailingQueue(h.worker.repositories.jobs, {
        ids: h.ids,
        now: h.clock.now,
        defaultMaxAttempts: 3,
      });
      const errors: string[] = [];
      const deps = { worker: { ...h.worker, queue }, sources: h.worker.repositories.sources };
      const result = await tick(deps, { intervalMs: 60_000, now: h.clock.now });
      expect(result.enqueuedSyncJobIds).toHaveLength(1);
      expect(result.enqueueFailures).toEqual([
        { workspaceId: WS_2, sourceId: SRC_2, error: expect.stringContaining("FOREIGN KEY") },
      ]);
      expect(result.enqueueFailures[0]?.error).not.toContain("leaky");
      // The healthy source's sync still ran in the same tick.
      expect(result.outcomes.map((o) => [o.workspaceId, o.state])).toEqual([[WS_1, "succeeded"]]);

      const controller = new AbortController();
      await runScheduler(deps, {
        intervalMs: 60_000,
        now: h.clock.now,
        sleep: async () => controller.abort(),
        signal: controller.signal,
        onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
      });
      expect(errors).toEqual([expect.stringMatching(/could not enqueue sync for source src_2/)]);
    } finally {
      h.close();
    }
  });

  it("loops until aborted and reports tick errors without stopping", async () => {
    const h = await createTestHarness();
    try {
      const controller = new AbortController();
      const ticks: string[] = [];
      const errors: string[] = [];
      let sleeps = 0;
      const failingSources = {
        listActiveForScheduler: async () => {
          if (sleeps === 0) {
            throw new Error("database hiccup");
          }
          return h.worker.repositories.sources.listActiveForScheduler(["enable_banking"]);
        },
      };
      await runScheduler(
        { worker: h.worker, sources: failingSources },
        {
          intervalMs: 1000,
          now: h.clock.now,
          sleep: async (ms) => {
            expect(ms).toBe(1000);
            sleeps += 1;
            h.clock.advance(ms);
            if (sleeps === 3) {
              controller.abort();
            }
          },
          signal: controller.signal,
          onTick: (result) => ticks.push(result.window),
          onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
        },
      );
      expect(errors).toEqual(["database hiccup"]);
      expect(ticks).toEqual(["2026-02-01T00:00:01.000Z", "2026-02-01T00:00:02.000Z"]);
      expect(sleeps).toBe(3);
    } finally {
      h.close();
    }
  });
});
