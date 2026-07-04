import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  createSecretValue,
  type GetSecretInput,
  type ListSecretsInput,
  type PutSecretInput,
  type RotateSecretInput,
  type SecretRef,
  type SecretStore,
  type SecretValue,
} from "./storage";
import { requireWorkspaceContext, type WorkspaceContext } from "./tenancy";

export interface LocalEncryptedSecretStoreOptions {
  path: string;
  key: Uint8Array;
}

export interface LocalSecretKeySourceOptions {
  env?: Readonly<Record<string, string | undefined>>;
  keyFile?: string;
}

const secretFileVersion = 1 as const;
const ciphertextVersion = 1 as const;
const nonceLength = 12;
const authTagLength = 16;
const secretKeyLength = 32;

const secretRefSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    label: z.string().min(1),
    version: z.number().int().positive(),
  })
  .strict();

const encryptedSecretRecordSchema = z
  .object({
    ref: secretRefSchema,
    ciphertext: z.string().min(1),
  })
  .strict();

const secretFileSchema = z
  .object({
    version: z.literal(secretFileVersion),
    records: z.array(encryptedSecretRecordSchema),
  })
  .strict();

type EncryptedSecretRecord = z.infer<typeof encryptedSecretRecordSchema>;
type SecretFile = z.infer<typeof secretFileSchema>;

export class LocalEncryptedSecretStore implements SecretStore {
  readonly #path: string;
  readonly #key: Buffer;

  constructor(options: LocalEncryptedSecretStoreOptions) {
    assertNonEmpty(options.path, "secret store path");
    if (options.key.byteLength !== secretKeyLength) {
      throw new Error("Local secret store key must be 32 bytes for AES-256-GCM");
    }
    this.#path = resolve(options.path);
    this.#key = Buffer.from(options.key);
  }

  async putSecret(input: PutSecretInput): Promise<SecretRef> {
    const context = requireWorkspaceContext(input.context);
    assertNonEmpty(input.label, "secret label");
    const id = input.id ?? `secret_${randomUUID()}`;
    assertNonEmpty(id, "secret id");

    const file = await this.readFile();
    const ref = freezeSecretRef({
      id,
      workspaceId: context.workspaceId,
      label: input.label,
      version: 1,
    });
    const withoutExisting = file.records.filter((record) => !isSameSecret(record.ref, context, id));

    await this.writeFile({
      version: secretFileVersion,
      records: [
        ...withoutExisting,
        {
          ref,
          ciphertext: this.encrypt(input.value),
        },
      ],
    });

    return ref;
  }

  async getSecret(input: GetSecretInput): Promise<SecretValue> {
    const context = requireWorkspaceContext(input.context);
    assertSecretWorkspace(context, input.ref);

    const record = await this.findCurrentRecord(context, input.ref);
    return createSecretValue(this.decrypt(record.ciphertext));
  }

  async rotateSecret(input: RotateSecretInput): Promise<SecretRef> {
    const context = requireWorkspaceContext(input.context);
    assertSecretWorkspace(context, input.ref);

    const file = await this.readFile();
    const existing = file.records.find(
      (record) =>
        isSameSecret(record.ref, context, input.ref.id) && record.ref.version === input.ref.version,
    );
    if (existing === undefined) {
      throw new Error(`Secret not found: ${input.ref.id}`);
    }

    const ref = freezeSecretRef({
      id: existing.ref.id,
      workspaceId: existing.ref.workspaceId,
      label: input.label ?? existing.ref.label,
      version: existing.ref.version + 1,
    });

    await this.writeFile({
      version: secretFileVersion,
      records: file.records.map((record) =>
        record === existing
          ? {
              ref,
              ciphertext: this.encrypt(input.value),
            }
          : record,
      ),
    });

    return ref;
  }

  async listSecrets(input: ListSecretsInput): Promise<SecretRef[]> {
    const context = requireWorkspaceContext(input.context);
    const file = await this.readFile();
    return file.records
      .filter((record) => record.ref.workspaceId === context.workspaceId)
      .map((record) => freezeSecretRef(record.ref));
  }

  private async findCurrentRecord(
    context: WorkspaceContext,
    ref: SecretRef,
  ): Promise<EncryptedSecretRecord> {
    const file = await this.readFile();
    const record = file.records.find(
      (candidate) =>
        isSameSecret(candidate.ref, context, ref.id) && candidate.ref.version === ref.version,
    );
    if (record === undefined) {
      throw new Error(`Secret not found: ${ref.id}`);
    }
    return record;
  }

  private encrypt(value: SecretValue): string {
    const nonce = randomBytes(nonceLength);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(value.reveal(), "utf8")),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([Buffer.from([ciphertextVersion]), nonce, authTag, ciphertext]).toString(
      "base64url",
    );
  }

  private decrypt(encoded: string): string {
    let packed: Buffer;
    try {
      packed = Buffer.from(encoded, "base64url");
    } catch {
      throw new Error("Secret ciphertext authentication failed");
    }

    const minimumLength = 1 + nonceLength + authTagLength + 1;
    if (packed.byteLength < minimumLength || packed[0] !== ciphertextVersion) {
      throw new Error("Secret ciphertext authentication failed");
    }

    const nonceStart = 1;
    const nonceEnd = nonceStart + nonceLength;
    const authTagEnd = nonceEnd + authTagLength;
    const nonce = packed.subarray(nonceStart, nonceEnd);
    const authTag = packed.subarray(nonceEnd, authTagEnd);
    const ciphertext = packed.subarray(authTagEnd);

    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#key, nonce);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw new Error("Secret ciphertext authentication failed");
    }
  }

  private async readFile(): Promise<SecretFile> {
    let raw: string;
    try {
      raw = await readFile(this.#path, "utf8");
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) {
        return {
          version: secretFileVersion,
          records: [],
        };
      }
      throw new Error("Secret store file could not be read");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Secret store file is invalid");
    }

    try {
      return secretFileSchema.parse(parsed);
    } catch {
      throw new Error("Secret store file is invalid");
    }
  }

  private async writeFile(file: SecretFile): Promise<void> {
    await writeFileAtomic(this.#path, new TextEncoder().encode(`${JSON.stringify(file)}\n`));
  }
}

export async function loadLocalSecretKey(
  options: LocalSecretKeySourceOptions = {},
): Promise<Uint8Array> {
  if (options.keyFile !== undefined) {
    try {
      return parseSecretKeyMaterial(await readFile(options.keyFile, "utf8"));
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) {
        throw new Error("Local secret key file could not be read");
      }
      if (error instanceof Error && error.message.startsWith("Local secret key")) {
        throw error;
      }
      throw new Error("Local secret key file could not be read");
    }
  }

  const env = options.env ?? process.env;
  const keyMaterial = env["SONA_SECRET_KEY"];
  if (keyMaterial === undefined || keyMaterial.trim().length === 0) {
    throw new Error(
      "SONA_SECRET_KEY is required for local encrypted secret storage unless keyFile is configured",
    );
  }

  return parseSecretKeyMaterial(keyMaterial);
}

async function writeFileAtomic(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const handle = await open(tempPath, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(tempPath, path);
    await fsyncDirectory(dirname(path));
  } catch (error) {
    await unlinkIfExists(tempPath);
    throw error;
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNodeErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
}

function isSameSecret(ref: SecretRef, context: WorkspaceContext, id: string): boolean {
  return ref.workspaceId === context.workspaceId && ref.id === id;
}

function assertSecretWorkspace(context: WorkspaceContext, ref: SecretRef): void {
  if (ref.workspaceId !== context.workspaceId) {
    throw new Error("Secret ref does not belong to the current workspace context");
  }
}

function freezeSecretRef(ref: SecretRef): SecretRef {
  return Object.freeze({ ...ref });
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} cannot be empty`);
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function parseSecretKeyMaterial(material: string): Uint8Array {
  const trimmed = material.trim();
  const key = /^[a-f0-9]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");

  if (key.byteLength !== secretKeyLength) {
    throw new Error("Local secret key must decode to 32 bytes for AES-256-GCM");
  }

  return new Uint8Array(key);
}
