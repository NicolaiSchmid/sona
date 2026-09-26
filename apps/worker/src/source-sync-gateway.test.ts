import type { enableBanking } from "@sona/connectors";
import { createSecretValue, createWorkspaceContext, InMemorySecretStore } from "@sona/core";
import { SqliteSourceRepository } from "@sona/db";
import { describe, expect, it } from "vitest";
import { NonRetryableJobError } from "./jobs/runner.js";
import { createSecretStoreSourceSyncGateway } from "./source-sync-gateway.js";
import { createTestHarness, SRC_1, WS_1, WS_2 } from "./test-support.js";

const client = { marker: "client" } as unknown as enableBanking.EnableBankingClient;

describe("createSecretStoreSourceSyncGateway", () => {
  it("resolves the session id from the source's current credential secret", async () => {
    const h = await createTestHarness();
    try {
      const sources = new SqliteSourceRepository(h.db);
      const secrets = new InMemorySecretStore();
      const context = createWorkspaceContext({ workspaceId: WS_1 });
      const ref = await secrets.putSecret({
        context,
        label: "enable banking consent",
        value: createSecretValue(JSON.stringify({ sessionId: "sess_from_secret" })),
      });
      await sources.saveCredential(WS_1, {
        id: "cred_1",
        sourceId: SRC_1,
        secretRef: ref,
        createdAt: h.clock.now(),
      });
      const gateway = createSecretStoreSourceSyncGateway({
        sources,
        secrets,
        enableBankingClient: () => client,
      });
      await expect(gateway.resolveEnableBanking(context, SRC_1)).resolves.toEqual({
        client,
        sessionId: "sess_from_secret",
      });
      // Another workspace cannot resolve this source's consent.
      await expect(
        gateway.resolveEnableBanking(createWorkspaceContext({ workspaceId: WS_2 }), SRC_1),
      ).rejects.toBeInstanceOf(NonRetryableJobError);
    } finally {
      h.close();
    }
  });

  it("cannot resolve a credential whose secret was rotated underneath it, and leaks neither version", async () => {
    const h = await createTestHarness();
    try {
      const sources = new SqliteSourceRepository(h.db);
      const secrets = new InMemorySecretStore();
      const context = createWorkspaceContext({ workspaceId: WS_1 });
      const v1 = await secrets.putSecret({
        context,
        label: "enable banking consent",
        value: createSecretValue(JSON.stringify({ sessionId: "sess_v1_synthetic" })),
      });
      await sources.saveCredential(WS_1, {
        id: "cred_v1",
        sourceId: SRC_1,
        secretRef: v1,
        createdAt: h.clock.now(),
      });
      // The secret is rotated but the source still points at the v1 reference.
      await secrets.rotateSecret({
        context,
        ref: v1,
        value: createSecretValue(JSON.stringify({ sessionId: "sess_v2_synthetic" })),
      });
      const gateway = createSecretStoreSourceSyncGateway({
        sources,
        secrets,
        enableBankingClient: () => client,
      });
      const error = await gateway.resolveEnableBanking(context, SRC_1).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toMatch(/sess_v[12]_synthetic/);
    } finally {
      h.close();
    }
  });

  // A stale credential reference cannot heal by retrying: the source needs a
  // new credential row. Today the secret store's plain `Secret not found`
  // error propagates as retryable, so the sync job burns every attempt before
  // it dead-letters. Flip to `it` once the gateway maps it to NonRetryableJobError.
  it("fails non-retryably when the credential reference is stale", async () => {
    const h = await createTestHarness();
    try {
      const sources = new SqliteSourceRepository(h.db);
      const secrets = new InMemorySecretStore();
      const context = createWorkspaceContext({ workspaceId: WS_1 });
      const v1 = await secrets.putSecret({
        context,
        label: "enable banking consent",
        value: createSecretValue(JSON.stringify({ sessionId: "sess_v1_synthetic" })),
      });
      await sources.saveCredential(WS_1, {
        id: "cred_v1",
        sourceId: SRC_1,
        secretRef: v1,
        createdAt: h.clock.now(),
      });
      await secrets.rotateSecret({
        context,
        ref: v1,
        value: createSecretValue(JSON.stringify({ sessionId: "sess_v2_synthetic" })),
      });
      const gateway = createSecretStoreSourceSyncGateway({
        sources,
        secrets,
        enableBankingClient: () => client,
      });
      await expect(gateway.resolveEnableBanking(context, SRC_1)).rejects.toBeInstanceOf(
        NonRetryableJobError,
      );
    } finally {
      h.close();
    }
  });

  it("fails non-retryably on missing or malformed credentials without leaking the secret", async () => {
    const h = await createTestHarness();
    try {
      const sources = new SqliteSourceRepository(h.db);
      const secrets = new InMemorySecretStore();
      const context = createWorkspaceContext({ workspaceId: WS_1 });
      const gateway = createSecretStoreSourceSyncGateway({
        sources,
        secrets,
        enableBankingClient: () => client,
      });
      await expect(gateway.resolveEnableBanking(context, SRC_1)).rejects.toThrow(
        /no stored credential/,
      );

      const ref = await secrets.putSecret({
        context,
        label: "bad",
        value: createSecretValue("plaintext-token-do-not-leak"),
      });
      await sources.saveCredential(WS_1, {
        id: "cred_bad",
        sourceId: SRC_1,
        secretRef: ref,
        createdAt: h.clock.now(),
      });
      const error = await gateway.resolveEnableBanking(context, SRC_1).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NonRetryableJobError);
      expect(String(error)).not.toContain("plaintext-token");
    } finally {
      h.close();
    }
  });
});
