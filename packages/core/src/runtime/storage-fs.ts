import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { sha256Hex } from "../util/hash";
import type {
  DeleteDocumentInput,
  DocumentStorage,
  DocumentStream,
  GetDocumentInput,
  PutDocumentInput,
  StoredDocument,
} from "./storage";
import { requireWorkspaceContext, type WorkspaceContext } from "./tenancy";

export interface FileSystemDocumentStorageOptions {
  root: string;
}

const contentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

const storedDocumentSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    contentHash: contentHashSchema,
    byteLength: z.number().int().nonnegative(),
    contentType: z.string().min(1),
    originalFilename: z.string().optional(),
    createdAt: z.string().min(1),
    metadata: z.record(z.string()),
  })
  .strict();

export class FileSystemDocumentStorage implements DocumentStorage {
  readonly #root: string;

  constructor(options: FileSystemDocumentStorageOptions) {
    assertNonEmpty(options.root, "document storage root");
    this.#root = resolve(options.root);
  }

  async put(input: PutDocumentInput): Promise<StoredDocument> {
    const context = requireWorkspaceContext(input.context);
    assertPathSegment(context.workspaceId, "workspaceId");
    assertPathSegment(input.id, "document id");
    assertNonEmpty(input.contentType, "document contentType");
    assertNonEmpty(input.createdAt, "document createdAt");

    const bytes = cloneBytes(input.bytes);
    const contentHash = sha256Hex(bytes);
    const document = freezeStoredDocument({
      id: input.id,
      workspaceId: context.workspaceId,
      contentHash,
      byteLength: bytes.byteLength,
      contentType: input.contentType,
      originalFilename: input.originalFilename,
      createdAt: input.createdAt,
      metadata: Object.freeze({ ...(input.metadata ?? {}) }),
    });

    await writeFileAtomic(this.contentPath(context, contentHash), bytes);
    await writeJsonAtomic(this.recordPath(context, input.id), document);

    return document;
  }

  async get(input: GetDocumentInput): Promise<DocumentStream> {
    const context = requireWorkspaceContext(input.context);
    assertPathSegment(context.workspaceId, "workspaceId");
    assertPathSegment(input.id, "document id");

    const document = await this.readRecord(context, input.id);
    const bytes = await readDocumentBytes(this.contentPath(context, document.contentHash));
    const actualHash = sha256Hex(bytes);
    if (actualHash !== document.contentHash) {
      throw new Error("Stored document failed content hash verification");
    }

    return {
      document,
      bytes,
    };
  }

  async delete(input: DeleteDocumentInput): Promise<void> {
    const context = requireWorkspaceContext(input.context);
    assertPathSegment(context.workspaceId, "workspaceId");
    assertPathSegment(input.id, "document id");

    const document = await this.readRecord(context, input.id);
    await unlinkIfExists(this.recordPath(context, input.id));

    const stillReferenced = await this.hasContentReference(context, document.contentHash);
    if (!stillReferenced) {
      await unlinkIfExists(this.contentPath(context, document.contentHash));
    }
  }

  private workspaceRoot(context: WorkspaceContext): string {
    return resolveUnder(this.#root, context.workspaceId);
  }

  private recordPath(context: WorkspaceContext, id: string): string {
    return resolveUnder(this.workspaceRoot(context), "records", `${id}.json`);
  }

  private recordsRoot(context: WorkspaceContext): string {
    return resolveUnder(this.workspaceRoot(context), "records");
  }

  private contentPath(context: WorkspaceContext, contentHash: string): string {
    const prefix = contentHash.slice(0, 2);
    return resolveUnder(this.workspaceRoot(context), prefix, contentHash);
  }

  private async readRecord(context: WorkspaceContext, id: string): Promise<StoredDocument> {
    const recordPath = this.recordPath(context, id);
    let raw: string;
    try {
      raw = await readFile(recordPath, "utf8");
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) {
        throw new Error(`Stored document not found: ${id}`);
      }
      throw new Error("Stored document metadata could not be read");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Stored document metadata is invalid");
    }

    const parsedDocument = storedDocumentSchema.parse(parsed);
    const document: StoredDocument = {
      ...parsedDocument,
      originalFilename: parsedDocument.originalFilename,
    };
    if (document.workspaceId !== context.workspaceId || document.id !== id) {
      throw new Error("Stored document metadata does not match the current workspace context");
    }

    return freezeStoredDocument(document);
  }

  private async hasContentReference(
    context: WorkspaceContext,
    contentHash: string,
  ): Promise<boolean> {
    let entries: string[];
    try {
      entries = await readdir(this.recordsRoot(context));
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) {
        return false;
      }
      throw new Error("Stored document metadata could not be listed");
    }

    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const id = entry.slice(0, -".json".length);
      const document = await this.readRecord(context, id);
      if (document.contentHash === contentHash) {
        return true;
      }
    }

    return false;
  }
}

async function readDocumentBytes(path: string): Promise<Uint8Array> {
  try {
    return await readFile(path);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      throw new Error("Stored document bytes not found");
    }
    throw new Error("Stored document bytes could not be read");
  }
}

async function writeJsonAtomic(path: string, value: StoredDocument): Promise<void> {
  const json = `${JSON.stringify(value)}\n`;
  await writeFileAtomic(path, new TextEncoder().encode(json));
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

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} cannot be empty`);
  }
}

function assertPathSegment(value: string, label: string): void {
  assertNonEmpty(value, label);
  if (value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
    throw new Error(`${label} must be a safe path segment`);
  }
}

function resolveUnder(root: string, ...segments: string[]): string {
  const resolvedRoot = resolve(root);
  const resolved = resolve(resolvedRoot, ...segments);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error("Resolved document storage path escaped its root");
  }
  return resolved;
}

function freezeStoredDocument(document: StoredDocument): StoredDocument {
  return Object.freeze({
    ...document,
    metadata: Object.freeze({ ...document.metadata }),
  });
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
