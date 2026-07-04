import { isAbsolute, resolve } from "node:path";
import type { SonaRuntimeConfig } from "./config";
import { LocalEncryptedSecretStore, loadLocalSecretKey } from "./secrets-local";
import type { DocumentStorage, SecretStore } from "./storage";
import { FileSystemDocumentStorage } from "./storage-fs";

export interface RuntimeStorageBackends {
  documents: DocumentStorage;
  secrets: SecretStore;
}

export interface RuntimeStorageBackendOptions {
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
}

export async function createRuntimeStorageBackends(
  config: SonaRuntimeConfig,
  options: RuntimeStorageBackendOptions = {},
): Promise<RuntimeStorageBackends> {
  return {
    documents: createDocumentStorageBackend(config, options),
    secrets: await createSecretStoreBackend(config, options),
  };
}

function createDocumentStorageBackend(
  config: SonaRuntimeConfig,
  options: RuntimeStorageBackendOptions,
): DocumentStorage {
  switch (config.storage.documents.provider) {
    case "filesystem":
      return new FileSystemDocumentStorage({
        root: resolveConfigPath(config.storage.documents.path, options.cwd),
      });
    case "object_storage":
      throw new Error("Object storage document backend is not implemented in @sona/core");
  }
}

async function createSecretStoreBackend(
  config: SonaRuntimeConfig,
  options: RuntimeStorageBackendOptions,
): Promise<SecretStore> {
  switch (config.storage.secrets.provider) {
    case "local_encrypted_file":
      return new LocalEncryptedSecretStore({
        path: resolveConfigPath(config.storage.secrets.path, options.cwd),
        key: await loadLocalSecretKey({
          env: options.env,
          keyFile:
            config.storage.secrets.keyFile === undefined
              ? undefined
              : resolveConfigPath(config.storage.secrets.keyFile, options.cwd),
        }),
      });
    case "env":
      throw new Error(
        "Environment-only secret backend cannot persist mutable secrets; use local_encrypted_file",
      );
    case "plaintext_file":
      throw new Error("Plaintext file secret backend is not supported");
    case "managed_vault":
      throw new Error("Managed vault secret backend is not implemented in @sona/core");
  }
}

function resolveConfigPath(path: string, cwd = process.cwd()): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}
