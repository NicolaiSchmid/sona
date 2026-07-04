import { z } from "zod";

export const RUNTIME_MODES = ["local_dev", "self_hosted", "hosted_cloud"] as const;

export type RuntimeMode = (typeof RUNTIME_MODES)[number];

const nonEmptyString = z.string().min(1);

const filesystemDocumentStorageConfigSchema = z
  .object({
    provider: z.literal("filesystem"),
    path: nonEmptyString,
  })
  .strict();

const objectDocumentStorageConfigSchema = z
  .object({
    provider: z.literal("object_storage"),
    bucket: nonEmptyString,
    endpoint: nonEmptyString.optional(),
    region: nonEmptyString.optional(),
  })
  .strict();

export const documentStorageConfigSchema = z.discriminatedUnion("provider", [
  filesystemDocumentStorageConfigSchema,
  objectDocumentStorageConfigSchema,
]);

export type DocumentStorageBackendConfig = z.infer<typeof documentStorageConfigSchema>;

const sqliteDatabaseConfigSchema = z
  .object({
    provider: z.literal("sqlite"),
    path: nonEmptyString,
  })
  .strict();

const postgresDatabaseConfigSchema = z
  .object({
    provider: z.literal("postgres"),
    url: nonEmptyString,
  })
  .strict();

export const databaseConfigSchema = z.discriminatedUnion("provider", [
  sqliteDatabaseConfigSchema,
  postgresDatabaseConfigSchema,
]);

export type DatabaseBackendConfig = z.infer<typeof databaseConfigSchema>;

const envSecretBackendConfigSchema = z
  .object({
    provider: z.literal("env"),
    prefix: nonEmptyString.optional(),
  })
  .strict();

const localEncryptedFileSecretBackendConfigSchema = z
  .object({
    provider: z.literal("local_encrypted_file"),
    path: nonEmptyString,
    keyFile: nonEmptyString.optional(),
  })
  .strict();

const plaintextFileSecretBackendConfigSchema = z
  .object({
    provider: z.literal("plaintext_file"),
    path: nonEmptyString,
  })
  .strict();

const managedVaultSecretBackendConfigSchema = z
  .object({
    provider: z.literal("managed_vault"),
    namespace: nonEmptyString,
    keyId: nonEmptyString.optional(),
  })
  .strict();

export const secretBackendConfigSchema = z.discriminatedUnion("provider", [
  envSecretBackendConfigSchema,
  localEncryptedFileSecretBackendConfigSchema,
  plaintextFileSecretBackendConfigSchema,
  managedVaultSecretBackendConfigSchema,
]);

export type SecretBackendConfig = z.infer<typeof secretBackendConfigSchema>;

const aiPolicyConfigSchema = z
  .object({
    suggestClassifications: z.boolean().default(true),
    submitTaxReturns: z.boolean().default(false),
    initiatePayments: z.boolean().default(false),
  })
  .strict();

const receiptPolicyConfigSchema = z
  .object({
    requireFor: z.array(nonEmptyString).default([]),
  })
  .strict();

const policyConfigSchema = z
  .object({
    aiCan: aiPolicyConfigSchema.default({}),
    receipts: receiptPolicyConfigSchema.default({}),
  })
  .strict();

export type RuntimePolicyConfig = z.infer<typeof policyConfigSchema>;

const runtimeStorageInputConfigSchema = z
  .object({
    documents: documentStorageConfigSchema,
    database: databaseConfigSchema,
    secrets: secretBackendConfigSchema.optional(),
  })
  .strict();

const runtimeStorageConfigSchema = z
  .object({
    documents: documentStorageConfigSchema,
    database: databaseConfigSchema,
    secrets: secretBackendConfigSchema,
  })
  .strict();

export type RuntimeStorageConfig = z.infer<typeof runtimeStorageConfigSchema>;

const runtimeConfigInputSchema = z
  .object({
    runtime: z.enum(RUNTIME_MODES),
    locale: nonEmptyString,
    currency: z.string().regex(/^[A-Z]{3}$/),
    storage: runtimeStorageInputConfigSchema,
    policies: policyConfigSchema.default({}),
  })
  .strict();

const runtimeConfigSchema = z
  .object({
    runtime: z.enum(RUNTIME_MODES),
    locale: nonEmptyString,
    currency: z.string().regex(/^[A-Z]{3}$/),
    storage: runtimeStorageConfigSchema,
    policies: policyConfigSchema,
  })
  .strict()
  .superRefine((config, context) => {
    if (config.policies.aiCan.submitTaxReturns) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "policies.aiCan.submitTaxReturns is not supported; no feature flag exists yet",
        path: ["policies", "aiCan", "submitTaxReturns"],
      });
    }

    if (config.policies.aiCan.initiatePayments) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "policies.aiCan.initiatePayments is rejected by default",
        path: ["policies", "aiCan", "initiatePayments"],
      });
    }

    if (config.runtime !== "hosted_cloud") {
      return;
    }

    if (config.storage.documents.provider === "filesystem") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "hosted_cloud mode requires non-filesystem document storage",
        path: ["storage", "documents"],
      });
    }

    if (config.storage.secrets.provider !== "managed_vault") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "hosted_cloud mode requires non-plaintext secret backend settings",
        path: ["storage", "secrets"],
      });
    }
  });

export type SonaRuntimeConfig = z.infer<typeof runtimeConfigSchema>;

function defaultSecretBackendForRuntime(mode: RuntimeMode): SecretBackendConfig {
  switch (mode) {
    case "local_dev":
    case "self_hosted":
      return {
        provider: "local_encrypted_file",
        path: "./data/secrets.json",
      };
    case "hosted_cloud":
      return { provider: "env" };
  }
}

/**
 * Parses already-decoded config objects. Core intentionally does not parse YAML:
 * `config/sona.example.yaml` is documentation, and adding a YAML parser just for
 * this boundary would expand dependencies without changing the typed contract.
 */
export function parseSonaRuntimeConfig(input: unknown): SonaRuntimeConfig {
  const parsed = runtimeConfigInputSchema.parse(input);
  return runtimeConfigSchema.parse({
    ...parsed,
    storage: {
      ...parsed.storage,
      secrets: parsed.storage.secrets ?? defaultSecretBackendForRuntime(parsed.runtime),
    },
  });
}
