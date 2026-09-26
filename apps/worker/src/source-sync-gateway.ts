/**
 * Resolves a source's provider access from its stored credential reference.
 * The secret store holds one JSON object per source under the source's
 * `SecretRef`:
 *
 * - Enable Banking: `{ "sessionId": "<consent session id>" }`
 * - Email: `{ "imap": { host, port?, secure?, username, passwordSecret }, "policy"?: {...} }`
 *   where `passwordSecret` is the `SecretRef` of the mailbox password, which
 *   the IMAP client reveals only when it connects.
 *
 * The worker never persists or logs the revealed values.
 */

import { email, type enableBanking } from "@sona/connectors";
import type { SecretStore, WorkspaceContext } from "@sona/core";
import type { SqliteSourceRepository } from "@sona/db";
import { z } from "zod";
import { NonRetryableJobError } from "./jobs/runner.js";
import type { EmailSession, EnableBankingSession, SourceSyncGateway } from "./jobs/source-sync.js";

const nonEmpty = z.string().trim().min(1);

const secretRefSchema = z
  .object({
    id: nonEmpty,
    workspaceId: nonEmpty,
    label: nonEmpty,
    version: z.number().int().positive(),
  })
  .strict();

const enableBankingCredentialSchema = z.object({ sessionId: nonEmpty }).strict();

const emailPolicySchema = z
  .object({
    folder: nonEmpty.optional(),
    allowedSenders: z.array(nonEmpty).optional(),
    allowedMimeTypes: z.array(nonEmpty).optional(),
    minImageBytes: z.number().int().nonnegative().optional(),
    maxAttachmentBytes: z.number().int().positive().optional(),
  })
  .strict();

const emailCredentialSchema = z
  .object({
    imap: z
      .object({
        host: nonEmpty,
        port: z.number().int().min(1).max(65535).optional(),
        secure: z.boolean().optional(),
        username: nonEmpty,
        passwordSecret: secretRefSchema,
      })
      .strict(),
    policy: emailPolicySchema.optional(),
  })
  .strict();

export interface SecretStoreSourceSyncGatewayOptions {
  sources: Pick<SqliteSourceRepository, "currentCredential">;
  secrets: SecretStore;
  /**
   * One Enable Banking client per application; the consent (session) is per
   * source. Given as a factory so a worker with no bank sources never needs
   * application credentials; the first sync creates the client and reuses it.
   */
  enableBankingClient: () => enableBanking.EnableBankingClient;
  /** IMAP client factory; defaults to the connector's `imapflow` implementation. */
  createImapClient?: (input: email.ImapFlowClientInput) => email.ImapClient;
}

export function createSecretStoreSourceSyncGateway(
  options: SecretStoreSourceSyncGatewayOptions,
): SourceSyncGateway {
  let enableBankingClient: enableBanking.EnableBankingClient | undefined;
  const createImapClient = options.createImapClient ?? email.createImapFlowClient;

  async function credentialJson(context: WorkspaceContext, sourceId: string): Promise<unknown> {
    const credential = await options.sources.currentCredential(context.workspaceId, sourceId);
    if (credential === undefined) {
      throw new NonRetryableJobError(`source ${sourceId} has no stored credential`);
    }
    let revealed: string;
    try {
      revealed = (await options.secrets.getSecret({ context, ref: credential.secretRef })).reveal();
    } catch {
      // A reference the store no longer resolves (rotated or deleted) needs a
      // new credential row, not another attempt.
      throw new NonRetryableJobError(`source ${sourceId} credential could not be resolved`);
    }
    try {
      return JSON.parse(revealed);
    } catch {
      throw new NonRetryableJobError(`source ${sourceId} credential is not valid JSON`);
    }
  }

  return {
    async resolveEnableBanking(context, sourceId): Promise<EnableBankingSession> {
      const parsed = enableBankingCredentialSchema.safeParse(
        await credentialJson(context, sourceId),
      );
      if (!parsed.success) {
        throw new NonRetryableJobError(`source ${sourceId} credential is missing sessionId`);
      }
      enableBankingClient ??= options.enableBankingClient();
      return { client: enableBankingClient, sessionId: parsed.data.sessionId };
    },

    async resolveEmail(context, sourceId): Promise<EmailSession> {
      const parsed = emailCredentialSchema.safeParse(await credentialJson(context, sourceId));
      if (!parsed.success) {
        throw new NonRetryableJobError(
          `source ${sourceId} credential is not a valid IMAP connection`,
        );
      }
      if (parsed.data.imap.passwordSecret.workspaceId !== context.workspaceId) {
        throw new NonRetryableJobError(
          `source ${sourceId} mailbox password belongs to another workspace`,
        );
      }
      return {
        client: createImapClient({
          connection: parsed.data.imap,
          secrets: options.secrets,
          context,
        }),
        policy: parsed.data.policy,
      };
    },
  };
}
