import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { LocalEncryptedSecretStore, loadLocalSecretKey } from "./secrets-local";
import { createSecretValue } from "./storage";
import { createWorkspaceContext } from "./tenancy";

const workspace = createWorkspaceContext({ workspaceId: "ws_1" });

describe("local encrypted secret store", () => {
  it("roundtrips secrets through explicit reveal only", async () => {
    const store = createStore();

    const ref = await store.putSecret({
      context: workspace,
      label: "synthetic portal",
      value: createSecretValue("synthetic-portal-password"),
    });
    const value = await store.getSecret({ context: workspace, ref });

    expect(value.reveal()).toBe("synthetic-portal-password");
    expect(String(value)).toBe("[SecretValue redacted]");
    expect(JSON.stringify(value)).toBe('"[SecretValue redacted]"');
    expect(inspect(value)).toBe("[SecretValue redacted]");
  });

  it("keeps ciphertext free of plaintext secret material", async () => {
    const path = createTempPath();
    const store = createStore({ path });
    const secret = "synthetic-bank-session-token";

    await store.putSecret({
      context: workspace,
      label: "synthetic bank",
      value: createSecretValue(secret),
    });

    const storedBytes = await readFile(path, "utf8");
    expect(storedBytes).not.toContain(secret);
  });

  it("lists refs and labels only", async () => {
    const store = createStore();
    const secret = "synthetic-email-secret";
    const ref = await store.putSecret({
      context: workspace,
      label: "synthetic email",
      value: createSecretValue(secret),
    });

    const refs = await store.listSecrets({ context: workspace });

    expect(refs).toEqual([ref]);
    expect(JSON.stringify(refs)).not.toContain(secret);
  });

  it("fails authentication with a wrong key without exposing plaintext", async () => {
    const path = createTempPath();
    const store = createStore({ path, key: randomBytes(32) });
    const secret = "synthetic-wrong-key-secret";
    const ref = await store.putSecret({
      context: workspace,
      label: "synthetic token",
      value: createSecretValue(secret),
    });
    const wrongKeyStore = createStore({ path, key: randomBytes(32) });

    await expect(wrongKeyStore.getSecret({ context: workspace, ref })).rejects.toThrow(
      /authentication failed/,
    );
    await expect(wrongKeyStore.getSecret({ context: workspace, ref })).rejects.not.toThrow(
      new RegExp(secret),
    );
  });

  it("rotates by re-encrypting and superseding the old ref", async () => {
    const path = createTempPath();
    const store = createStore({ path });
    const ref = await store.putSecret({
      context: workspace,
      label: "synthetic oauth",
      value: createSecretValue("old-synthetic-token"),
    });
    const before = await readFile(path, "utf8");

    const rotated = await store.rotateSecret({
      context: workspace,
      ref,
      value: createSecretValue("new-synthetic-token"),
    });
    const after = await readFile(path, "utf8");
    const value = await store.getSecret({ context: workspace, ref: rotated });

    expect(rotated.version).toBe(2);
    expect(value.reveal()).toBe("new-synthetic-token");
    expect(after).not.toBe(before);
    await expect(store.getSecret({ context: workspace, ref })).rejects.toThrow(/Secret not found/);
  });

  it("loads a 32-byte encryption key from env or key file", async () => {
    const envKey = randomBytes(32);
    const fileKey = randomBytes(32);
    const keyFile = createTempPath();
    await writeFile(keyFile, fileKey.toString("base64"));

    await expect(
      loadLocalSecretKey({
        env: { SONA_SECRET_KEY: envKey.toString("base64") },
      }),
    ).resolves.toEqual(new Uint8Array(envKey));
    await expect(
      loadLocalSecretKey({
        keyFile,
        env: {},
      }),
    ).resolves.toEqual(new Uint8Array(fileKey));
  });

  it("fails clearly when an encrypted local store has no key source", async () => {
    await expect(loadLocalSecretKey({ env: {} })).rejects.toThrow(/SONA_SECRET_KEY/);
  });
});

function createStore(options?: { path?: string; key?: Uint8Array }): LocalEncryptedSecretStore {
  return new LocalEncryptedSecretStore({
    path: options?.path ?? createTempPath(),
    key: options?.key ?? randomBytes(32),
  });
}

function createTempPath(): string {
  return join(tmpdir(), `sona-secrets-${crypto.randomUUID()}.json`);
}
