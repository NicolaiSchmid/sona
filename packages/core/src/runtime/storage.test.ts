import { describe, expect, it } from "vitest";
import { createSecretValue, InMemoryDocumentStorage, InMemorySecretStore } from "./storage";
import { createWorkspaceContext } from "./tenancy";

const workspace = createWorkspaceContext({ workspaceId: "ws_1" });
const otherWorkspace = createWorkspaceContext({ workspaceId: "ws_2" });

describe("in-memory document storage", () => {
  it("stores and reads document bytes within a workspace", async () => {
    const storage = new InMemoryDocumentStorage();
    const bytes = new TextEncoder().encode("receipt pdf bytes");

    const stored = await storage.put({
      context: workspace,
      id: "doc_1",
      bytes,
      contentType: "application/pdf",
      originalFilename: "receipt.pdf",
      createdAt: "2026-01-01T00:00:00Z",
    });

    expect(stored.workspaceId).toBe("ws_1");
    expect(stored.byteLength).toBe(bytes.byteLength);

    bytes[0] = 0;
    const stream = await storage.get({ context: workspace, id: "doc_1" });
    expect(new TextDecoder().decode(stream.bytes)).toBe("receipt pdf bytes");
    expect(stream.document.contentHash).toBe(stored.contentHash);
  });

  it("does not leak documents across workspaces", async () => {
    const storage = new InMemoryDocumentStorage();

    await storage.put({
      context: workspace,
      id: "doc_1",
      bytes: new TextEncoder().encode("private receipt"),
      contentType: "application/pdf",
      createdAt: "2026-01-01T00:00:00Z",
    });

    await expect(storage.get({ context: otherWorkspace, id: "doc_1" })).rejects.toThrow(/document/);
  });

  it("deletes documents within the scoped workspace", async () => {
    const storage = new InMemoryDocumentStorage();

    await storage.put({
      context: workspace,
      id: "doc_1",
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "application/octet-stream",
      createdAt: "2026-01-01T00:00:00Z",
    });
    await storage.delete({ context: workspace, id: "doc_1" });

    await expect(storage.get({ context: workspace, id: "doc_1" })).rejects.toThrow(/document/);
  });
});

describe("in-memory secret store", () => {
  it("stores secrets but lists only refs and labels", async () => {
    const store = new InMemorySecretStore();
    const secret = createSecretValue("portal-password");

    const ref = await store.putSecret({
      context: workspace,
      label: "merchant portal",
      value: secret,
    });

    expect(ref.label).toBe("merchant portal");
    const refs = await store.listSecrets({ context: workspace });
    expect(refs).toEqual([ref]);
    expect(JSON.stringify(refs)).not.toContain("portal-password");
  });

  it("keeps secret values redacted during string and JSON coercion", () => {
    const value = createSecretValue("bank-session-token");

    expect(String(value)).not.toContain("bank-session-token");
    expect(`${value}`).not.toContain("bank-session-token");
    expect(JSON.stringify(value)).not.toContain("bank-session-token");
    expect(JSON.stringify({ value })).not.toContain("bank-session-token");
    expect(value.reveal()).toBe("bank-session-token");
  });

  it("rotates secrets without exposing prior values through refs", async () => {
    const store = new InMemorySecretStore();
    const ref = await store.putSecret({
      context: workspace,
      label: "bank oauth",
      value: createSecretValue("old-token"),
    });

    const rotated = await store.rotateSecret({
      context: workspace,
      ref,
      value: createSecretValue("new-token"),
    });
    const value = await store.getSecret({ context: workspace, ref: rotated });

    expect(rotated.version).toBe(2);
    expect(value.reveal()).toBe("new-token");
    expect(JSON.stringify(rotated)).not.toContain("new-token");
    expect(JSON.stringify(rotated)).not.toContain("old-token");
  });

  it("does not leak secrets across workspaces", async () => {
    const store = new InMemorySecretStore();
    const ref = await store.putSecret({
      context: workspace,
      label: "email inbox",
      value: createSecretValue("email-secret"),
    });

    await expect(store.getSecret({ context: otherWorkspace, ref })).rejects.toThrow(/workspace/);
    await expect(store.listSecrets({ context: otherWorkspace })).resolves.toEqual([]);
  });
});
