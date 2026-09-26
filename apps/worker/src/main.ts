/**
 * CLI entry point for a local/self-hosted worker:
 *
 *   SONA_CONFIG_PATH=./config/sona.json pnpm --filter @sona/worker start
 *
 * Reads the runtime config (JSON with the shape of `config/sona.example.yaml`),
 * opens the SQLite database, applies migrations, and runs the interval
 * scheduler until SIGINT/SIGTERM. Enable Banking credentials come from the
 * environment (`.env.example`); per-source consents come from the secret store.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { enableBanking } from "@sona/connectors";
import { createRuntimeStorageBackends, parseSonaRuntimeConfig } from "@sona/core";
import {
  applyMigrations,
  CORE_MIGRATIONS,
  createSqliteDbClient,
  type SqliteDatabase,
} from "@sona/db";
import { PdfTextExtractionProvider } from "@sona/receipts";
import { runScheduler } from "./scheduler.js";
import { createSecretStoreSourceSyncGateway } from "./source-sync-gateway.js";
import { createWorker, createWorkerRepositories } from "./worker.js";

// node:sqlite is loaded through require so bundlers that predate it leave it alone.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

const DEFAULT_INTERVAL_MS = 15 * 60_000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function intervalFromEnv(): number {
  const raw = process.env["SONA_WORKER_INTERVAL_MS"];
  if (raw === undefined) {
    return DEFAULT_INTERVAL_MS;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1000) {
    throw new Error("SONA_WORKER_INTERVAL_MS must be an integer >= 1000");
  }
  return parsed;
}

async function main(): Promise<void> {
  const configPath = resolve(process.env["SONA_CONFIG_PATH"] ?? "./config/sona.json");
  const config = parseSonaRuntimeConfig(JSON.parse(readFileSync(configPath, "utf8")));
  if (config.storage.database.provider !== "sqlite") {
    throw new Error("the local worker supports the sqlite database provider only");
  }
  const databasePath = isAbsolute(config.storage.database.path)
    ? config.storage.database.path
    : resolve(process.cwd(), config.storage.database.path);

  const sqlite = new DatabaseSync(databasePath) as SqliteDatabase;
  sqlite.exec("PRAGMA foreign_keys = ON");
  const db = createSqliteDbClient(sqlite);
  applyMigrations(db, CORE_MIGRATIONS);

  const backends = await createRuntimeStorageBackends(config, { env: process.env });
  // Application credentials are only read once a bank source actually syncs,
  // so a workspace without bank sources can run ingest/extraction/export alone.
  const client = (): enableBanking.EnableBankingClient =>
    enableBanking.createEnableBankingClient({
      applicationId: requireEnv("ENABLE_BANKING_APP_ID"),
      privateKeyPem: readFileSync(requireEnv("ENABLE_BANKING_PRIVATE_KEY_PATH"), "utf8"),
      apiBase: process.env["ENABLE_BANKING_API_BASE"],
    });

  const repositories = createWorkerRepositories(db);
  const worker = createWorker({
    db,
    storage: backends.documents,
    sourceSync: createSecretStoreSourceSyncGateway({
      sources: repositories.sources,
      secrets: backends.secrets,
      client,
    }),
    // Provider selection through runtime config is deferred to a later phase;
    // the local text-layer extractor needs no credentials.
    extraction: { provider: new PdfTextExtractionProvider() },
    repositories,
  });

  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => controller.abort());
  }
  const intervalMs = intervalFromEnv();
  console.log(`sona worker: scheduler running every ${intervalMs}ms (${configPath})`);
  await runScheduler(
    { worker, sources: repositories.sources },
    {
      intervalMs,
      signal: controller.signal,
      onTick: (result) => {
        console.log(
          `tick ${result.at}: ${result.enqueuedSyncJobIds.length} sync job(s) enqueued, ${result.outcomes.length} job(s) processed`,
        );
        for (const outcome of result.outcomes) {
          if (outcome.state !== "succeeded") {
            console.error(
              `job ${outcome.jobId} (${outcome.kind}) ${outcome.state}: ${outcome.error}`,
            );
          }
        }
      },
      onError: (error) => {
        console.error("scheduler tick failed:", error instanceof Error ? error.message : error);
      },
    },
  );
  sqlite.close();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
