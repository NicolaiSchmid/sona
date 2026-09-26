import { email, type enableBanking } from "@sona/connectors";
import { createSecretValue, createWorkspaceContext, InMemorySecretStore } from "@sona/core";
import { SqliteSourceRepository } from "@sona/db";
import { describe, expect, it } from "vitest";
import { NonRetryableJobError } from "./jobs/runner.js";
import { createSecretStoreSourceSyncGateway } from "./source-sync-gateway.js";
import { createTestHarness, syntheticSource, WS_1, WS_2 } from "./test-support.js";

const client = { marker: "client" } as unknown as enableBanking.EnableBankingClient;

describe("createSecretStoreSourceSyncGateway for email sources", () => {
  it("builds an IMAP client from the stored connection and hands the password ref to the connector", async () => {
    const h = await createTestHarness();
    try {
      const sources = new SqliteSourceRepository(h.db);
      const secrets = new InMemorySecretStore();
      const context = createWorkspaceContext({ workspaceId: WS_1 });
      const password = await secrets.putSecret({
        context,
        label: "mailbox password",
        value: createSecretValue("app-password-synthetic"),
      });
      const connection = await secrets.putSecret({
        context,
        label: "imap connection",
        value: createSecretValue(
          JSON.stringify({
            imap: {
              host: "imap.example.test",
              username: "bills@example.test",
              passwordSecret: password,
            },
            policy: { allowedSenders: ["vendor.example"] },
          }),
        ),
      });
      await sources.create({ ...syntheticSource(WS_1, "src_mail"), kind: "email" });
      await sources.saveCredential(WS_1, {
        id: "cred_mail",
        sourceId: "src_mail",
        secretRef: connection,
        createdAt: h.clock.now(),
      });
      const inputs: email.ImapFlowClientInput[] = [];
      const fake = new email.FakeImapClient({ workspaceId: WS_1, folders: {} });
      const gateway = createSecretStoreSourceSyncGateway({
        sources,
        secrets,
        createEnableBankingClient: () => client,
        createImapClient: (input) => {
          inputs.push(input);
          return fake;
        },
      });
      const session = await gateway.resolveEmail(context, "src_mail");
      expect(session.client).toBe(fake);
      expect(session.policy).toEqual({ allowedSenders: ["vendor.example"] });
      expect(inputs).toHaveLength(1);
      expect(inputs[0]?.connection).toEqual({
        host: "imap.example.test",
        username: "bills@example.test",
        passwordSecret: password,
      });
      expect(inputs[0]?.context.workspaceId).toBe(WS_1);
      // The password itself was never read by the gateway.
      expect(JSON.stringify(inputs)).not.toContain("app-password-synthetic");
    } finally {
      h.close();
    }
  });

  it("rejects a connection whose password ref belongs to another workspace, or an unknown shape", async () => {
    const h = await createTestHarness();
    try {
      const sources = new SqliteSourceRepository(h.db);
      const secrets = new InMemorySecretStore();
      const context = createWorkspaceContext({ workspaceId: WS_1 });
      const foreign = await secrets.putSecret({
        context: createWorkspaceContext({ workspaceId: WS_2 }),
        label: "other mailbox",
        value: createSecretValue("x"),
      });
      const store = async (sourceId: string, value: unknown): Promise<void> => {
        await sources.create({ ...syntheticSource(WS_1, sourceId), kind: "email" });
        const ref = await secrets.putSecret({
          context,
          label: sourceId,
          value: createSecretValue(JSON.stringify(value)),
        });
        await sources.saveCredential(WS_1, {
          id: `cred_${sourceId}`,
          sourceId,
          secretRef: ref,
          createdAt: h.clock.now(),
        });
      };
      await store("src_foreign", {
        imap: { host: "imap.example.test", username: "u", passwordSecret: foreign },
      });
      await store("src_shape", { sessionId: "not-an-imap-credential" });
      const gateway = createSecretStoreSourceSyncGateway({
        sources,
        secrets,
        createEnableBankingClient: () => client,
        createImapClient: () => new email.FakeImapClient({ workspaceId: WS_1, folders: {} }),
      });
      await expect(gateway.resolveEmail(context, "src_foreign")).rejects.toThrow(
        /another workspace/,
      );
      await expect(gateway.resolveEmail(context, "src_shape")).rejects.toBeInstanceOf(
        NonRetryableJobError,
      );
      await expect(gateway.resolveEmail(context, "src_missing")).rejects.toThrow(
        /no stored credential/,
      );
    } finally {
      h.close();
    }
  });
});
