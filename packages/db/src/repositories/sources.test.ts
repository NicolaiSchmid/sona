import type { Source } from "@sona/core";
import { describe, expect, it } from "vitest";
import { SqliteSourceRepository } from "./sources.js";
import { createTestDatabase } from "./test-support.js";

const T0 = "2026-02-01T00:00:00.000Z";

function source(overrides: Partial<Source> = {}): Source {
  return {
    id: "src_email",
    workspaceId: "ws_1",
    kind: "email",
    displayName: "Synthetic Mailbox",
    status: "active",
    createdAt: T0,
    ...overrides,
  };
}

describe("SqliteSourceRepository", () => {
  it("creates, lists, and updates sources within a workspace", async () => {
    const t = createTestDatabase();
    try {
      const repo = new SqliteSourceRepository(t.db);
      // The test database seeds src_1 (ws_1) and src_2 (ws_2).
      expect((await repo.list("ws_1")).map((s) => s.id)).toEqual(["src_1"]);

      const created = await repo.create(source());
      expect(created).toMatchObject({ id: "src_email", kind: "email", status: "active" });
      // Re-creating leaves the existing row alone.
      await repo.create(source({ displayName: "Renamed" }));
      expect((await repo.getById("ws_1", "src_email"))?.displayName).toBe("Synthetic Mailbox");

      await repo.setStatus("ws_1", "src_email", "paused");
      expect((await repo.getById("ws_1", "src_email"))?.status).toBe("paused");
      expect(await repo.getById("ws_2", "src_email")).toBeUndefined();
    } finally {
      t.close();
    }
  });

  it("lists only active sources of the requested kinds for the scheduler, tagged with their workspace", async () => {
    const t = createTestDatabase();
    try {
      const repo = new SqliteSourceRepository(t.db);
      await repo.create(source());
      await repo.setStatus("ws_2", "src_2", "revoked");

      expect(await repo.listActiveForScheduler(["enable_banking"])).toEqual([
        { workspaceId: "ws_1", sourceId: "src_1", kind: "enable_banking" },
      ]);
      expect(await repo.listActiveForScheduler(["email", "enable_banking"])).toHaveLength(2);
      expect(await repo.listActiveForScheduler([])).toEqual([]);
    } finally {
      t.close();
    }
  });

  it("stores credential references as serialized secret refs and returns the newest", async () => {
    const t = createTestDatabase();
    try {
      const repo = new SqliteSourceRepository(t.db);
      const v1 = { id: "secret_1", workspaceId: "ws_1", label: "eb session", version: 1 };
      await repo.saveCredential("ws_1", {
        id: "cred_1",
        sourceId: "src_1",
        secretRef: v1,
        createdAt: T0,
      });
      const v2 = { ...v1, version: 2 };
      const latest = await repo.saveCredential("ws_1", {
        id: "cred_2",
        sourceId: "src_1",
        secretRef: v2,
        createdAt: "2026-02-02T00:00:00.000Z",
      });
      expect(latest.secretRef).toEqual(v2);
      expect((await repo.currentCredential("ws_1", "src_1"))?.id).toBe("cred_2");
      expect(await repo.currentCredential("ws_2", "src_1")).toBeUndefined();

      // A ref from another workspace is refused at the write boundary.
      await expect(
        repo.saveCredential("ws_1", {
          id: "cred_x",
          sourceId: "src_1",
          secretRef: { ...v1, workspaceId: "ws_2" },
          createdAt: T0,
        }),
      ).rejects.toThrow(/workspace/);
      // The raw row never contains a secret value, only the reference.
      const raw = t.db
        .prepare("SELECT secret_ref FROM source_credentials WHERE id = 'cred_2'")
        .get() as { secret_ref: string };
      expect(JSON.parse(raw.secret_ref)).toEqual(v2);
    } finally {
      t.close();
    }
  });

  it("orders scheduler sources by workspace, then creation time, then id", async () => {
    const t = createTestDatabase();
    try {
      const repo = new SqliteSourceRepository(t.db);
      // Newer than the seeded src_2 in ws_2, but ws_1 rows still come first.
      await repo.create(
        source({ id: "src_b", workspaceId: "ws_2", kind: "enable_banking", createdAt: T0 }),
      );
      await repo.create(
        source({ id: "src_a", workspaceId: "ws_2", kind: "enable_banking", createdAt: T0 }),
      );
      await repo.create(
        source({
          id: "src_0",
          workspaceId: "ws_1",
          kind: "enable_banking",
          createdAt: "2026-03-01T00:00:00.000Z",
        }),
      );
      expect(
        (await repo.listActiveForScheduler(["enable_banking"])).map((s) => [
          s.workspaceId,
          s.sourceId,
        ]),
      ).toEqual([
        ["ws_1", "src_1"],
        ["ws_1", "src_0"],
        ["ws_2", "src_2"],
        ["ws_2", "src_a"],
        ["ws_2", "src_b"],
      ]);
    } finally {
      t.close();
    }
  });

  it("breaks a created_at tie between credentials by the higher secret version, not the id", async () => {
    const t = createTestDatabase();
    try {
      const repo = new SqliteSourceRepository(t.db);
      const ref = (version: number) => ({
        id: "secret_1",
        workspaceId: "ws_1",
        label: "eb session",
        version,
      });
      // The rotation with the higher version has the lower id: version wins.
      await repo.saveCredential("ws_1", {
        id: "cred_a",
        sourceId: "src_1",
        secretRef: ref(2),
        createdAt: T0,
      });
      await repo.saveCredential("ws_1", {
        id: "cred_b",
        sourceId: "src_1",
        secretRef: ref(1),
        createdAt: T0,
      });
      expect(await repo.currentCredential("ws_1", "src_1")).toMatchObject({
        id: "cred_a",
        secretRef: ref(2),
      });
      // A later row always wins regardless of version.
      await repo.saveCredential("ws_1", {
        id: "cred_c",
        sourceId: "src_1",
        secretRef: ref(1),
        createdAt: "2026-02-02T00:00:00.000Z",
      });
      expect((await repo.currentCredential("ws_1", "src_1"))?.id).toBe("cred_c");
      // Credentials are per source: another source in the workspace has none.
      expect(await repo.currentCredential("ws_1", "src_other")).toBeUndefined();
    } finally {
      t.close();
    }
  });
});
