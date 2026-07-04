import { inspect } from "node:util";
import { sha256Hex } from "../util/hash";
import { requireWorkspaceContext, type WorkspaceContext } from "./tenancy";

export interface PutDocumentInput {
  context: WorkspaceContext;
  id: string;
  bytes: Uint8Array;
  contentType: string;
  originalFilename?: string;
  createdAt: string;
  metadata?: Readonly<Record<string, string>>;
}

export interface GetDocumentInput {
  context: WorkspaceContext;
  id: string;
}

export interface DeleteDocumentInput {
  context: WorkspaceContext;
  id: string;
}

export interface StoredDocument {
  id: string;
  workspaceId: string;
  contentHash: string;
  byteLength: number;
  contentType: string;
  originalFilename: string | undefined;
  createdAt: string;
  metadata: Readonly<Record<string, string>>;
}

export interface DocumentStream {
  document: StoredDocument;
  bytes: Uint8Array;
}

export interface DocumentStorage {
  put(input: PutDocumentInput): Promise<StoredDocument>;
  get(input: GetDocumentInput): Promise<DocumentStream>;
  delete(input: DeleteDocumentInput): Promise<void>;
}

export interface SecretRef {
  id: string;
  workspaceId: string;
  label: string;
  version: number;
}

export interface PutSecretInput {
  context: WorkspaceContext;
  id?: string;
  label: string;
  value: SecretValue;
}

export interface GetSecretInput {
  context: WorkspaceContext;
  ref: SecretRef;
}

export interface RotateSecretInput {
  context: WorkspaceContext;
  ref: SecretRef;
  label?: string;
  value: SecretValue;
}

export interface ListSecretsInput {
  context: WorkspaceContext;
}

export interface SecretStore {
  putSecret(input: PutSecretInput): Promise<SecretRef>;
  getSecret(input: GetSecretInput): Promise<SecretValue>;
  rotateSecret(input: RotateSecretInput): Promise<SecretRef>;
  listSecrets(input: ListSecretsInput): Promise<SecretRef[]>;
}

const redactedSecretValue = "[SecretValue redacted]" as const;

export class SecretValue {
  readonly #plaintext: string;

  private constructor(plaintext: string) {
    this.#plaintext = plaintext;
    Object.freeze(this);
  }

  static fromPlaintext(plaintext: string): SecretValue {
    if (plaintext.length === 0) {
      throw new Error("Secret value cannot be empty");
    }
    return new SecretValue(plaintext);
  }

  reveal(): string {
    return this.#plaintext;
  }

  toString(): string {
    return redactedSecretValue;
  }

  toJSON(): string {
    return redactedSecretValue;
  }

  [Symbol.toPrimitive](): string {
    return redactedSecretValue;
  }

  [inspect.custom](): string {
    return redactedSecretValue;
  }
}

export function createSecretValue(plaintext: string): SecretValue {
  return SecretValue.fromPlaintext(plaintext);
}

interface StoredDocumentRecord {
  document: StoredDocument;
  bytes: Uint8Array;
}

export class InMemoryDocumentStorage implements DocumentStorage {
  readonly #documents = new Map<string, StoredDocumentRecord>();

  async put(input: PutDocumentInput): Promise<StoredDocument> {
    const context = requireWorkspaceContext(input.context);
    assertNonEmpty(input.id, "document id");
    assertNonEmpty(input.contentType, "document contentType");
    assertNonEmpty(input.createdAt, "document createdAt");

    const bytes = cloneBytes(input.bytes);
    const document = freezeStoredDocument({
      id: input.id,
      workspaceId: context.workspaceId,
      contentHash: sha256Hex(bytes),
      byteLength: bytes.byteLength,
      contentType: input.contentType,
      originalFilename: input.originalFilename,
      createdAt: input.createdAt,
      metadata: Object.freeze({ ...(input.metadata ?? {}) }),
    });

    this.#documents.set(documentKey(context.workspaceId, input.id), {
      document,
      bytes,
    });

    return document;
  }

  async get(input: GetDocumentInput): Promise<DocumentStream> {
    const context = requireWorkspaceContext(input.context);
    assertNonEmpty(input.id, "document id");

    const record = this.#documents.get(documentKey(context.workspaceId, input.id));
    if (record === undefined) {
      throw new Error(`Stored document not found: ${input.id}`);
    }

    return {
      document: record.document,
      bytes: cloneBytes(record.bytes),
    };
  }

  async delete(input: DeleteDocumentInput): Promise<void> {
    const context = requireWorkspaceContext(input.context);
    assertNonEmpty(input.id, "document id");
    this.#documents.delete(documentKey(context.workspaceId, input.id));
  }
}

interface StoredSecretRecord {
  ref: SecretRef;
  value: SecretValue;
}

export class InMemorySecretStore implements SecretStore {
  readonly #secrets = new Map<string, StoredSecretRecord>();
  #nextId = 1;

  async putSecret(input: PutSecretInput): Promise<SecretRef> {
    const context = requireWorkspaceContext(input.context);
    assertNonEmpty(input.label, "secret label");

    const id = input.id ?? `secret_${this.#nextId}`;
    this.#nextId += 1;
    assertNonEmpty(id, "secret id");

    const ref = freezeSecretRef({
      id,
      workspaceId: context.workspaceId,
      label: input.label,
      version: 1,
    });

    this.#secrets.set(secretKey(context.workspaceId, id), {
      ref,
      value: input.value,
    });

    return ref;
  }

  async getSecret(input: GetSecretInput): Promise<SecretValue> {
    const context = requireWorkspaceContext(input.context);
    assertSecretWorkspace(context, input.ref);

    const record = this.#secrets.get(secretKey(context.workspaceId, input.ref.id));
    if (record === undefined || record.ref.version !== input.ref.version) {
      throw new Error(`Secret not found: ${input.ref.id}`);
    }

    return createSecretValue(record.value.reveal());
  }

  async rotateSecret(input: RotateSecretInput): Promise<SecretRef> {
    const context = requireWorkspaceContext(input.context);
    assertSecretWorkspace(context, input.ref);

    const key = secretKey(context.workspaceId, input.ref.id);
    const record = this.#secrets.get(key);
    if (record === undefined || record.ref.version !== input.ref.version) {
      throw new Error(`Secret not found: ${input.ref.id}`);
    }

    const ref = freezeSecretRef({
      ...record.ref,
      label: input.label ?? record.ref.label,
      version: record.ref.version + 1,
    });

    this.#secrets.set(key, {
      ref,
      value: input.value,
    });

    return ref;
  }

  async listSecrets(input: ListSecretsInput): Promise<SecretRef[]> {
    const context = requireWorkspaceContext(input.context);
    const refs: SecretRef[] = [];

    for (const record of this.#secrets.values()) {
      if (record.ref.workspaceId === context.workspaceId) {
        refs.push(freezeSecretRef(record.ref));
      }
    }

    return refs;
  }
}

function documentKey(workspaceId: string, id: string): string {
  return `${workspaceId}:${id}`;
}

function secretKey(workspaceId: string, id: string): string {
  return `${workspaceId}:${id}`;
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} cannot be empty`);
  }
}

function assertSecretWorkspace(context: WorkspaceContext, ref: SecretRef): void {
  if (ref.workspaceId !== context.workspaceId) {
    throw new Error("Secret ref does not belong to the current workspace context");
  }
}

function freezeStoredDocument(document: StoredDocument): StoredDocument {
  return Object.freeze({
    ...document,
    metadata: Object.freeze({ ...document.metadata }),
  });
}

function freezeSecretRef(ref: SecretRef): SecretRef {
  return Object.freeze({ ...ref });
}
