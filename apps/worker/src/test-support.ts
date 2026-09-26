/**
 * Test harness: a real in-memory SQLite database with every migration, two
 * seeded workspaces, in-memory document storage, a fake Enable Banking client
 * with synthetic payloads, a swappable extraction provider, and a
 * deterministic clock/id sequence. No real account, IBAN, or credential data.
 */
import { createRequire } from "node:module";
import type { email, enableBanking } from "@sona/connectors";
import {
  createWorkspaceContext,
  InMemoryDocumentStorage,
  type Source,
  type WorkspaceContext,
} from "@sona/core";
import {
  applyMigrations,
  CORE_MIGRATIONS,
  createSqliteDbClient,
  type DbClient,
  type SqliteDatabase,
} from "@sona/db";
import {
  type DocumentExtraction,
  type ExtractionProvider,
  type ExtractionProviderInput,
  FakeExtractionProvider,
} from "@sona/receipts";
import type { SourceSyncGateway } from "./jobs/source-sync.js";
import { createWorker, type WorkerRuntime, type WorkerRuntimeOptions } from "./worker.js";

// node:sqlite is a newer built-in the bundled Vite version does not recognize as
// external, so a static import gets bundled and fails; require keeps it opaque.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export const WS_1 = "ws_1";
export const WS_2 = "ws_2";
export const SRC_1 = "src_1";
export const SRC_2 = "src_2";
export const SESSION_1 = "sess_synthetic_1";
export const SESSION_2 = "sess_synthetic_2";

export const T0 = "2026-02-01T00:00:00.000Z";

export interface FakeBankAccount {
  uid: string;
  identificationHash: string;
  name: string;
  currency: string;
  transactions: enableBanking.EbTransaction[];
  /** Transactions per page; the fake hands out continuation keys until exhausted. */
  pageSize?: number;
  /** Simulates an ASPSP account failure: every account-level call throws. */
  failWith?: string;
}

export interface FakeBankSession {
  status: string;
  accounts: FakeBankAccount[];
}

export const SYNTHETIC_TRANSACTIONS = {
  handwerk: {
    entry_reference: "txn_synth_handwerk",
    transaction_amount: { amount: "84.23", currency: "EUR" },
    credit_debit_indicator: "DBIT",
    booking_date: "2026-01-15",
    value_date: "2026-01-15",
    status: "BOOK",
    creditor: { name: "Example Handwerk GmbH" },
    remittance_information: ["Rechnung 2026-0042"],
  },
  rent: {
    entry_reference: "txn_synth_rent",
    transaction_amount: { amount: "2500.00", currency: "EUR" },
    credit_debit_indicator: "CRDT",
    booking_date: "2026-01-28",
    value_date: "2026-01-28",
    status: "BOOK",
    debtor: { name: "Tenant Mietzahlung" },
    remittance_information: ["Miete Februar"],
  },
  pending: {
    entry_reference: "txn_synth_pending",
    transaction_amount: { amount: "12.00", currency: "EUR" },
    credit_debit_indicator: "DBIT",
    booking_date: "2026-01-30",
    status: "PDNG",
    creditor: { name: "Pending Merchant" },
  },
} as const satisfies Record<string, enableBanking.EbTransaction>;

export function syntheticAccount(overrides: Partial<FakeBankAccount> = {}): FakeBankAccount {
  return {
    uid: "acc_synth_1",
    identificationHash: "idhash_synth_1",
    name: "Synthetic Giro",
    currency: "EUR",
    transactions: [SYNTHETIC_TRANSACTIONS.handwerk, SYNTHETIC_TRANSACTIONS.rent],
    ...overrides,
  };
}

/** Enable Banking client over mutable in-memory sessions; tests edit `sessions` between syncs. */
export class FakeEnableBankingClient implements enableBanking.EnableBankingClient {
  readonly sessions = new Map<string, FakeBankSession>();
  readonly calls: string[] = [];
  /** Every `getTransactions` input, so tests can assert the query the worker passed through. */
  readonly transactionRequests: Array<{
    accountUid: string;
    continuationKey?: string;
    dateFrom?: string;
    dateTo?: string;
    strategy?: string;
  }> = [];

  constructor(sessions: Record<string, FakeBankSession> = {}) {
    for (const [id, session] of Object.entries(sessions)) {
      this.sessions.set(id, session);
    }
  }

  async getApplication(): Promise<enableBanking.EbApplication> {
    return { name: "synthetic" };
  }

  async listAspsps(): Promise<enableBanking.EbAspspList> {
    return { aspsps: [] };
  }

  async startAuth(): Promise<enableBanking.EbAuthResponse> {
    return { url: "https://auth.example.invalid" };
  }

  async exchangeCode(): Promise<enableBanking.EbSession> {
    throw new Error("not supported by the fake");
  }

  async getSession(input: { sessionId: string }): Promise<enableBanking.EbSession> {
    this.calls.push(`session:${input.sessionId}`);
    const session = this.sessions.get(input.sessionId);
    if (session === undefined) {
      throw new Error("unknown session");
    }
    return {
      session_id: input.sessionId,
      status: session.status,
      accounts: session.accounts.map((account) => ({ uid: account.uid })),
    };
  }

  async getAccountDetails(input: { accountUid: string }): Promise<enableBanking.EbAccountDetails> {
    const account = this.#account(input.accountUid);
    return {
      uid: account.uid,
      identification_hash: account.identificationHash,
      name: account.name,
      currency: account.currency,
      product: "Current Account",
      cash_account_type: "CACC",
    };
  }

  async getBalances(input: { accountUid: string }): Promise<enableBanking.EbBalancesResponse> {
    const account = this.#account(input.accountUid);
    return {
      balances: [
        {
          balance_amount: { amount: "1000.00", currency: account.currency },
          balance_type: "CLBD",
          reference_date: "2026-01-31",
        },
      ],
    };
  }

  async getTransactions(input: {
    accountUid: string;
    continuationKey?: string;
    dateFrom?: string;
    dateTo?: string;
    strategy?: string;
  }): Promise<enableBanking.EbTransactionsResponse> {
    this.calls.push(`transactions:${input.accountUid}`);
    this.transactionRequests.push({
      accountUid: input.accountUid,
      continuationKey: input.continuationKey,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      strategy: input.strategy,
    });
    const account = this.#account(input.accountUid);
    const pageSize = account.pageSize ?? account.transactions.length;
    const offset =
      input.continuationKey === undefined ? 0 : Number.parseInt(input.continuationKey, 10);
    if (Number.isNaN(offset) || offset < 0 || offset > account.transactions.length) {
      throw new Error(`invalid continuation key ${String(input.continuationKey)}`);
    }
    const end = Math.min(offset + pageSize, account.transactions.length);
    const page = account.transactions.slice(offset, end);
    return {
      transactions: page,
      continuation_key: end < account.transactions.length ? String(end) : null,
    };
  }

  #account(uid: string): FakeBankAccount {
    for (const session of this.sessions.values()) {
      const account = session.accounts.find((candidate) => candidate.uid === uid);
      if (account !== undefined) {
        if (account.failWith !== undefined) {
          throw new Error(account.failWith);
        }
        return account;
      }
    }
    throw new Error(`unknown account ${uid}`);
  }
}

/** Delegates to a swappable provider so one worker can be exercised with several. */
export class SwappableExtractionProvider implements ExtractionProvider {
  readonly name = "swappable";
  readonly version = "1";
  current: ExtractionProvider;
  readonly calls: string[] = [];

  constructor(initial: ExtractionProvider = new FakeExtractionProvider()) {
    this.current = initial;
  }

  async extract(input: ExtractionProviderInput): Promise<DocumentExtraction> {
    this.calls.push(input.metadata.documentId);
    return this.current.extract(input);
  }
}

export interface TestClock {
  now(): string;
  set(iso: string): void;
  advance(ms: number): void;
}

export function createTestClock(start = T0): TestClock {
  let current = Date.parse(start);
  return {
    now: () => new Date(current).toISOString(),
    set: (iso) => {
      current = Date.parse(iso);
    },
    advance: (ms) => {
      current += ms;
    },
  };
}

export interface TestHarness {
  db: DbClient;
  worker: WorkerRuntime;
  storage: InMemoryDocumentStorage;
  bank: FakeEnableBankingClient;
  provider: SwappableExtractionProvider;
  clock: TestClock;
  ids: () => string;
  context: WorkspaceContext;
  otherContext: WorkspaceContext;
  /** Gateway calls, for asserting the worker never resolves credentials for the wrong workspace. */
  gatewayCalls: Array<{ workspaceId: string; sourceId: string }>;
  close(): void;
}

export interface FakeMailbox {
  client: email.ImapClient;
  policy?: email.EmailSourcePolicy;
}

export interface TestHarnessOptions {
  worker?: Partial<Omit<WorkerRuntimeOptions, "db" | "storage" | "sourceSync" | "extraction">>;
  bankSessions?: Record<string, FakeBankSession>;
  /** Fake IMAP mailboxes by email source id. */
  mailboxes?: Record<string, FakeMailbox>;
  /** Seed both workspaces with an Enable Banking source (default true). */
  seedSources?: boolean;
}

function seedWorkspace(db: DbClient, workspaceId: string): void {
  db.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)").run(
    workspaceId,
    `Workspace ${workspaceId}`,
    T0,
  );
}

export function syntheticSource(workspaceId: string, sourceId: string): Source {
  return {
    id: sourceId,
    workspaceId,
    kind: "enable_banking",
    displayName: `Synthetic Bank ${sourceId}`,
    status: "active",
    createdAt: T0,
  };
}

export async function createTestHarness(options: TestHarnessOptions = {}): Promise<TestHarness> {
  const sqlite = new DatabaseSync(":memory:") as SqliteDatabase;
  sqlite.exec("PRAGMA foreign_keys = ON");
  const db = createSqliteDbClient(sqlite);
  applyMigrations(db, CORE_MIGRATIONS);
  seedWorkspace(db, WS_1);
  seedWorkspace(db, WS_2);

  let counter = 0;
  const ids = (): string => {
    counter += 1;
    return `id_${String(counter).padStart(4, "0")}`;
  };
  const clock = createTestClock();
  const storage = new InMemoryDocumentStorage();
  const bank = new FakeEnableBankingClient(
    options.bankSessions ?? {
      [SESSION_1]: { status: "AUTHORIZED", accounts: [syntheticAccount()] },
      [SESSION_2]: {
        status: "AUTHORIZED",
        accounts: [
          syntheticAccount({
            uid: "acc_synth_2",
            identificationHash: "idhash_synth_2",
            transactions: [SYNTHETIC_TRANSACTIONS.rent],
          }),
        ],
      },
    },
  );
  const gatewayCalls: TestHarness["gatewayCalls"] = [];
  const sourceSync: SourceSyncGateway = {
    async resolveEnableBanking(context, sourceId) {
      gatewayCalls.push({ workspaceId: context.workspaceId, sourceId });
      return { client: bank, sessionId: sourceId === SRC_1 ? SESSION_1 : SESSION_2 };
    },
    async resolveEmail(context, sourceId) {
      gatewayCalls.push({ workspaceId: context.workspaceId, sourceId });
      const mailbox = options.mailboxes?.[sourceId];
      if (mailbox === undefined) {
        throw new Error(`no fake mailbox configured for ${sourceId}`);
      }
      return { client: mailbox.client, policy: mailbox.policy };
    },
  };
  const provider = new SwappableExtractionProvider();

  const worker = createWorker({
    db,
    storage,
    sourceSync,
    extraction: { provider },
    workerId: "worker-test",
    ids,
    now: clock.now,
    leaseMs: 60_000,
    backoff: { baseMs: 1_000, factor: 2, maxMs: 8_000 },
    defaultMaxAttempts: 3,
    ...options.worker,
  });

  if (options.seedSources !== false) {
    await worker.repositories.sources.create(syntheticSource(WS_1, SRC_1));
    await worker.repositories.sources.create(syntheticSource(WS_2, SRC_2));
  }

  return {
    db,
    worker,
    storage,
    bank,
    provider,
    clock,
    ids,
    context: createWorkspaceContext({ workspaceId: WS_1 }),
    otherContext: createWorkspaceContext({ workspaceId: WS_2 }),
    gatewayCalls,
    close: () => sqlite.close(),
  };
}

/** Runs the queue until it is drained or `maxPasses` is hit. */
export async function drain(worker: WorkerRuntime, maxPasses = 10): Promise<number> {
  let processed = 0;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const outcomes = await worker.runOnce();
    if (outcomes.length === 0) {
      return processed;
    }
    processed += outcomes.length;
  }
  return processed;
}

export function countRows(db: DbClient, table: string, workspaceId?: string): number {
  const sql =
    workspaceId === undefined
      ? `SELECT COUNT(*) AS n FROM ${table}`
      : `SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`;
  const statement = db.prepare(sql);
  const result = (workspaceId === undefined ? statement.get() : statement.get(workspaceId)) as {
    n: number;
  };
  return result.n;
}

/** Stages bytes in document storage the way an upload endpoint would. */
export async function stageUpload(
  harness: TestHarness,
  context: WorkspaceContext,
  input: { id: string; bytes: Uint8Array; filename?: string; mimeType?: string },
): Promise<string> {
  await harness.storage.put({
    context,
    id: input.id,
    bytes: input.bytes,
    contentType: input.mimeType ?? "application/pdf",
    originalFilename: input.filename ?? `${input.id}.pdf`,
    createdAt: harness.clock.now(),
  });
  return input.id;
}
