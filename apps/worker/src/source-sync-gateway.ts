/**
 * Resolves a source's Enable Banking consent from its stored credential
 * reference. The secret store holds a JSON object `{ "sessionId": "..." }`
 * under the source's `SecretRef`; the worker never persists or logs it.
 */

import type { enableBanking } from "@sona/connectors";
import type { SecretStore, WorkspaceContext } from "@sona/core";
import type { SqliteSourceRepository } from "@sona/db";
import { z } from "zod";
import { NonRetryableJobError } from "./jobs/runner.js";
import type { EnableBankingSession, SourceSyncGateway } from "./jobs/source-sync.js";

const enableBankingCredentialSchema = z.object({ sessionId: z.string().trim().min(1) }).strict();

export interface SecretStoreSourceSyncGatewayOptions {
  sources: Pick<SqliteSourceRepository, "currentCredential">;
  secrets: Pick<SecretStore, "getSecret">;
  /**
   * One client per application; the consent (session) is per source. Given as
   * a factory so a worker with no bank sources never needs application
   * credentials; the first sync creates the client and it is reused after.
   */
  client: () => enableBanking.EnableBankingClient;
}

export function createSecretStoreSourceSyncGateway(
  options: SecretStoreSourceSyncGatewayOptions,
): SourceSyncGateway {
  let client: enableBanking.EnableBankingClient | undefined;
  return {
    async resolveEnableBanking(
      context: WorkspaceContext,
      sourceId: string,
    ): Promise<EnableBankingSession> {
      const credential = await options.sources.currentCredential(context.workspaceId, sourceId);
      if (credential === undefined) {
        throw new NonRetryableJobError(`source ${sourceId} has no stored credential`);
      }
      let secretJson: string;
      try {
        secretJson = (
          await options.secrets.getSecret({ context, ref: credential.secretRef })
        ).reveal();
      } catch {
        // A reference the store no longer resolves (rotated or deleted) needs
        // a new credential row, not another attempt.
        throw new NonRetryableJobError(`source ${sourceId} credential could not be resolved`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(secretJson);
      } catch {
        throw new NonRetryableJobError(`source ${sourceId} credential is not valid JSON`);
      }
      const result = enableBankingCredentialSchema.safeParse(parsed);
      if (!result.success) {
        throw new NonRetryableJobError(`source ${sourceId} credential is missing sessionId`);
      }
      client ??= options.client();
      return { client, sessionId: result.data.sessionId };
    },
  };
}
