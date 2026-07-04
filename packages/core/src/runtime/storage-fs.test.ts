import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../util/hash";
import { FileSystemDocumentStorage } from "./storage-fs";
import { createWorkspaceContext } from "./tenancy";

const workspace = createWorkspaceContext({ workspaceId: "ws_1" });
const otherWorkspace = createWorkspaceContext({ workspaceId: "ws_2" });

describe("filesystem document storage", () => {
  it("roundtrips document bytes and mime metadata", async () => {
    const root = await createTempRoot();
    const storage = new FileSystemDocumentStorage({ root });
    const bytes = new TextEncoder().encode("synthetic receipt pdf bytes");

    const stored = await storage.put({
      context: workspace,
      id: "doc_1",
      bytes,
      contentType: "application/pdf",
      originalFilename: "synthetic-receipt.pdf",
      createdAt: "2026-01-01T00:00:00Z",
      metadata: { source: "upload" },
    });

    const stream = await storage.get({ context: workspace, id: "doc_1" });

    expect(new TextDecoder().decode(stream.bytes)).toBe("synthetic receipt pdf bytes");
    expect(stream.document).toEqual(stored);
    expect(stream.document.contentType).toBe("application/pdf");
    expect(stream.document.originalFilename).toBe("synthetic-receipt.pdf");
    expect(stream.document.metadata).toEqual({ source: "upload" });
  });

  it("verifies content hash and fails without including document bytes in the error", async () => {
    const root = await createTempRoot();
    const storage = new FileSystemDocumentStorage({ root });
    const bytes = new TextEncoder().encode("tamper-sensitive synthetic bytes");
    const stored = await storage.put({
      context: workspace,
      id: "doc_1",
      bytes,
      contentType: "application/pdf",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const documentPath = join(root, "ws_1", stored.contentHash.slice(0, 2), stored.contentHash);

    await writeFile(documentPath, new TextEncoder().encode("altered synthetic bytes"));

    await expect(storage.get({ context: workspace, id: "doc_1" })).rejects.toThrow(
      /hash verification/,
    );
    await expect(storage.get({ context: workspace, id: "doc_1" })).rejects.not.toThrow(
      /tamper-sensitive synthetic bytes|altered synthetic bytes/,
    );
  });

  it("stores duplicate identical content once per workspace", async () => {
    const root = await createTempRoot();
    const storage = new FileSystemDocumentStorage({ root });
    const bytes = new TextEncoder().encode("duplicate synthetic document");
    const expectedHash = sha256Hex(bytes);

    const first = await storage.put({
      context: workspace,
      id: "doc_1",
      bytes,
      contentType: "application/pdf",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const second = await storage.put({
      context: workspace,
      id: "doc_2",
      bytes,
      contentType: "application/pdf",
      createdAt: "2026-01-01T00:00:00Z",
    });

    expect(first.contentHash).toBe(expectedHash);
    expect(second.contentHash).toBe(expectedHash);
    await expect(
      stat(join(root, "ws_1", expectedHash.slice(0, 2), expectedHash)),
    ).resolves.toMatchObject({ size: bytes.byteLength });
  });

  it("deletes a document and fails cleanly on later get", async () => {
    const root = await createTempRoot();
    const storage = new FileSystemDocumentStorage({ root });
    const bytes = new TextEncoder().encode("delete synthetic document");
    const stored = await storage.put({
      context: workspace,
      id: "doc_1",
      bytes,
      contentType: "application/pdf",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const documentPath = join(root, "ws_1", stored.contentHash.slice(0, 2), stored.contentHash);

    await storage.delete({ context: workspace, id: "doc_1" });

    await expect(storage.get({ context: workspace, id: "doc_1" })).rejects.toThrow(
      /Stored document not found/,
    );
    await expect(readFile(documentPath)).rejects.toThrow();
  });

  it("keeps workspace document paths isolated", async () => {
    const root = await createTempRoot();
    const storage = new FileSystemDocumentStorage({ root });

    await storage.put({
      context: workspace,
      id: "doc_1",
      bytes: new TextEncoder().encode("workspace one bytes"),
      contentType: "application/pdf",
      createdAt: "2026-01-01T00:00:00Z",
    });
    await storage.put({
      context: otherWorkspace,
      id: "doc_1",
      bytes: new TextEncoder().encode("workspace two bytes"),
      contentType: "application/pdf",
      createdAt: "2026-01-01T00:00:00Z",
    });

    const first = await storage.get({ context: workspace, id: "doc_1" });
    const second = await storage.get({ context: otherWorkspace, id: "doc_1" });

    expect(new TextDecoder().decode(first.bytes)).toBe("workspace one bytes");
    expect(new TextDecoder().decode(second.bytes)).toBe("workspace two bytes");
    await expect(
      storage.put({
        context: createWorkspaceContext({ workspaceId: "../ws_2" }),
        id: "doc_2",
        bytes: new Uint8Array([1]),
        contentType: "application/octet-stream",
        createdAt: "2026-01-01T00:00:00Z",
      }),
    ).rejects.toThrow(/path segment/);
  });
});

async function createTempRoot(): Promise<string> {
  const root = join(tmpdir(), `sona-documents-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  return root;
}
