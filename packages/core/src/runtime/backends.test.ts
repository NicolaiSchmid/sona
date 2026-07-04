import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRuntimeStorageBackends } from "./backends";
import { parseSonaRuntimeConfig } from "./config";
import { createSecretValue } from "./storage";
import { createWorkspaceContext } from "./tenancy";

const workspace = createWorkspaceContext({ workspaceId: "ws_1" });

describe("runtime storage backends", () => {
  it("resolves filesystem documents and encrypted local secrets for self-hosted config", async () => {
    const root = await createTempRoot();
    const key = randomBytes(32).toString("base64");
    const config = parseSonaRuntimeConfig({
      runtime: "self_hosted",
      locale: "de-DE",
      currency: "EUR",
      storage: {
        documents: {
          provider: "filesystem",
          path: "./documents",
        },
        database: {
          provider: "sqlite",
          path: "./sona.sqlite",
        },
        secrets: {
          provider: "local_encrypted_file",
          path: "./secrets.json",
        },
      },
    });

    const backends = await createRuntimeStorageBackends(config, {
      cwd: root,
      env: { SONA_SECRET_KEY: key },
    });

    const document = await backends.documents.put({
      context: workspace,
      id: "doc_1",
      bytes: new TextEncoder().encode("runtime synthetic document"),
      contentType: "application/pdf",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const ref = await backends.secrets.putSecret({
      context: workspace,
      label: "runtime synthetic secret",
      value: createSecretValue("runtime-secret-value"),
    });

    await expect(backends.documents.get({ context: workspace, id: document.id })).resolves.toEqual(
      expect.objectContaining({ document }),
    );
    await expect(backends.secrets.getSecret({ context: workspace, ref })).resolves.toMatchObject(
      {},
    );
  });

  it("fails at startup when local encrypted secrets need SONA_SECRET_KEY", async () => {
    const root = await createTempRoot();
    const config = parseSonaRuntimeConfig({
      runtime: "local_dev",
      locale: "de-DE",
      currency: "EUR",
      storage: {
        documents: {
          provider: "filesystem",
          path: "./documents",
        },
        database: {
          provider: "sqlite",
          path: "./sona.sqlite",
        },
        secrets: {
          provider: "local_encrypted_file",
          path: "./secrets.json",
        },
      },
    });

    await expect(createRuntimeStorageBackends(config, { cwd: root, env: {} })).rejects.toThrow(
      /SONA_SECRET_KEY/,
    );
  });
});

async function createTempRoot(): Promise<string> {
  const root = join(tmpdir(), `sona-runtime-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  return root;
}
