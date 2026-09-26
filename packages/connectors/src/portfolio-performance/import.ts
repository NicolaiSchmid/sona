/**
 * Portfolio Performance import orchestration. Each parsed row is written to the
 * append-only raw vault *before* its normalized event, with the file's content
 * hash recorded on the run for provenance. Stores are injected so the same
 * flow composes with real repositories or in-memory fakes.
 *
 * Idempotency: raw records dedup on payload hash, events on their
 * content-derived external id — re-importing an overlapping export creates no
 * new events or valuations (only the new file's own verbatim raw record, when
 * its bytes differ). Events are evidence only; draft postings are derived
 * separately and never approved here.
 */
import {
  type BrokerAccountKind,
  createRawSourceRecord,
  type PortfolioEvent,
  type RawSourceRecord,
  type SecurityRef,
  securityKey,
  sha256Hex,
  stableJsonHash,
  type ValuationSnapshot,
} from "@sona/core";
import type { RawLink, SyncEnv, SyncStatus } from "../shared.js";
import {
  holdingIdentity,
  normalizePortfolioPerformanceHolding,
  normalizePortfolioPerformanceRows,
} from "./normalize.js";
import {
  assertIsoDate,
  parsePortfolioPerformanceCsv,
  parsePortfolioPerformanceHoldingsCsv,
} from "./parse.js";
import type { PpParsedRow, PpParseOptions, PpRawHoldingPayload, PpRowError } from "./types.js";

/**
 * Whether a normalized record was newly created, already known with the same
 * identity, or rejected because a different record already occupies its key.
 */
export type PortfolioSaveResult = "created" | "unchanged" | "conflict";

export interface PortfolioBrokerAccountInput {
  externalId: string;
  name: string;
  kind: BrokerAccountKind;
  currency: string | undefined;
}

export interface PortfolioSecurityInput extends SecurityRef {
  key: string;
}

export interface PortfolioStore {
  saveBrokerAccount(account: PortfolioBrokerAccountInput): Promise<void>;
  saveSecurity(security: PortfolioSecurityInput): Promise<void>;
  /** MUST be idempotent on the event's external id within (workspace, source); never updates. */
  saveEvent(event: PortfolioEvent, link: RawLink): Promise<PortfolioSaveResult>;
  /**
   * MUST be append-only and idempotent on (account, security, asOf) within
   * (workspace, source); a differing snapshot for an occupied key is `conflict`.
   */
  saveValuation(snapshot: ValuationSnapshot): Promise<PortfolioSaveResult>;
}

export interface PortfolioRawRecordStore {
  /**
   * Appends a raw record idempotently on (workspace, source, payload hash) and
   * returns the stored record — the pre-existing one on a duplicate — so
   * normalized records always link to a raw record that exists.
   */
  append(record: RawSourceRecord): Promise<RawSourceRecord>;
}

export type PortfolioImportStatus = SyncStatus;

export interface PortfolioImportSummary {
  runId: string;
  /** SHA-256 of the imported file text. */
  fileHash: string;
  fileName: string | undefined;
  /**
   * Raw record holding the complete file verbatim, so rows the parser
   * rejected are still preserved in the vault. Undefined until the file has
   * been appended (a failed run may end before that).
   */
  fileRawRecordId: string | undefined;
  rowsParsed: number;
  /** Rows that were rejected or conflicted; each is also reflected in the run status. */
  rowErrors: PpRowError[];
  eventsCreated: number;
  eventsUnchanged: number;
  /** Rows whose stored event carries different gross/FX details for the same identity. */
  eventsConflicting: number;
  valuationsCreated: number;
  valuationsUnchanged: number;
  /** Holdings rows whose values differ from an already stored snapshot for the same point. */
  valuationsConflicting: number;
}

export interface PortfolioImportRunStore {
  start(run: {
    runId: string;
    workspaceId: string;
    sourceId: string;
    startedAt: string;
    fileHash: string;
    fileName: string | undefined;
  }): Promise<void>;
  finish(run: {
    runId: string;
    status: PortfolioImportStatus;
    finishedAt: string;
    summary: PortfolioImportSummary;
  }): Promise<void>;
}

export interface RunPortfolioPerformanceImportInput {
  workspaceId: string;
  sourceId: string;
  /** Export text: transactions, or holdings for the holdings import. */
  csv: string;
  fileName?: string;
  parseOptions?: PpParseOptions;
  /**
   * Broker account external id for rows without an account column. Transaction
   * rows always need an account and fall back to "default" when this is unset;
   * holdings rows without one stay unassigned (a portfolio-wide valuation).
   */
  defaultAccountExternalId?: string;
  rawStore: PortfolioRawRecordStore;
  portfolioStore: PortfolioStore;
  /**
   * Optional so library callers (tests, one-off CLI runs) can import without
   * run persistence; the raw vault still records the file and every row.
   */
  runStore?: PortfolioImportRunStore;
  env: SyncEnv;
}

export interface RunPortfolioPerformanceHoldingsImportInput
  extends RunPortfolioPerformanceImportInput {
  /** ISO YYYY-MM-DD the holdings were valued at. */
  asOf: string;
}

function emptySummary(
  runId: string,
  fileHash: string,
  fileName: string | undefined,
): PortfolioImportSummary {
  return {
    runId,
    fileHash,
    fileName,
    fileRawRecordId: undefined,
    rowsParsed: 0,
    rowErrors: [],
    eventsCreated: 0,
    eventsUnchanged: 0,
    eventsConflicting: 0,
    valuationsCreated: 0,
    valuationsUnchanged: 0,
    valuationsConflicting: 0,
  };
}

/**
 * Runs a parse-and-store step under run tracking: a parse failure closes the
 * run as `failed` and rethrows; row-level errors mark it `completed_with_errors`.
 */
async function withRun(
  input: RunPortfolioPerformanceImportInput,
  body: (summary: PortfolioImportSummary) => Promise<void>,
): Promise<PortfolioImportSummary> {
  const { env, runStore } = input;
  const runId = env.ids();
  const fileHash = sha256Hex(input.csv);
  const summary = emptySummary(runId, fileHash, input.fileName);
  await runStore?.start({
    runId,
    workspaceId: input.workspaceId,
    sourceId: input.sourceId,
    startedAt: env.nowIso(),
    fileHash,
    fileName: input.fileName,
  });
  try {
    // The complete file goes into the vault first, so rows the parser rejects
    // are still preserved verbatim and every derived record can be traced back
    // to the exact export it came from.
    const file = await appendRaw(input, "source_file", `pp_file_${fileHash}`, {
      format: "portfolio_performance_csv_file",
      text: input.csv,
    });
    summary.fileRawRecordId = file.id;
    await body(summary);
  } catch (error) {
    await runStore?.finish({ runId, status: "failed", finishedAt: env.nowIso(), summary });
    throw error;
  }
  const status: PortfolioImportStatus =
    summary.rowErrors.length > 0 ? "completed_with_errors" : "succeeded";
  await runStore?.finish({ runId, status, finishedAt: env.nowIso(), summary });
  return summary;
}

function appendRaw(
  input: RunPortfolioPerformanceImportInput,
  recordType: RawSourceRecord["recordType"],
  externalId: string,
  payloadJson: RawSourceRecord["payloadJson"],
): Promise<RawSourceRecord> {
  const at = input.env.nowIso();
  return input.rawStore.append(
    createRawSourceRecord({
      id: input.env.ids(),
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      externalId,
      recordType,
      payloadJson,
      observedAt: at,
      createdAt: at,
    }),
  );
}

/**
 * The account an event is booked on. Portfolio Performance exports carry only
 * the account label, which doubles as the external id and display name; the
 * kind follows from which column supplied the label, not from the event type.
 * Only the fallback account, which no column supplied, is typed by event kind.
 */
function brokerAccountFor(event: PortfolioEvent, row: PpParsedRow): PortfolioBrokerAccountInput {
  const label = event.brokerAccountExternalId;
  return {
    externalId: label,
    name: label,
    kind: brokerAccountKindFor(event, row),
    currency: event.amount.commodity,
  };
}

function brokerAccountKindFor(event: PortfolioEvent, row: PpParsedRow): BrokerAccountKind {
  if (event.brokerAccountExternalId === row.securitiesAccount) {
    return "securities";
  }
  if (event.brokerAccountExternalId === row.cashAccount) {
    return "cash";
  }
  return event.kind === "security_transaction" ? "securities" : "cash";
}

/**
 * Registers each broker account and security once per run. Both imports use
 * it: a position that only ever appears in holdings (bought before the
 * imported history) must still become a known security/account.
 */
function onceRegistry(store: PortfolioStore) {
  const accounts = new Set<string>();
  const securities = new Set<string>();
  return {
    async account(account: PortfolioBrokerAccountInput): Promise<void> {
      if (!accounts.has(account.externalId)) {
        accounts.add(account.externalId);
        await store.saveBrokerAccount(account);
      }
    },
    async security(security: SecurityRef | undefined): Promise<void> {
      if (security === undefined) {
        return;
      }
      const key = securityKey(security);
      if (key === undefined || securities.has(key)) {
        return;
      }
      securities.add(key);
      await store.saveSecurity({ ...security, key });
    },
  };
}

export async function runPortfolioPerformanceImport(
  input: RunPortfolioPerformanceImportInput,
): Promise<PortfolioImportSummary> {
  return withRun(input, async (summary) => {
    const parsed = parsePortfolioPerformanceCsv(input.csv, input.parseOptions);
    summary.rowsParsed = parsed.rows.length;
    summary.rowErrors.push(...parsed.errors);

    const events = normalizePortfolioPerformanceRows(parsed.rows, {
      defaultAccountExternalId: input.defaultAccountExternalId,
    });
    const known = onceRegistry(input.portfolioStore);

    for (const [i, event] of events.entries()) {
      const row = parsed.rows[i];
      if (row === undefined) {
        throw new Error("normalized events and parsed rows are out of step");
      }
      const raw = await appendRaw(input, "portfolio_event", event.externalId, event.raw);
      await known.account(brokerAccountFor(event, row));
      await known.security(event.security);

      const result = await input.portfolioStore.saveEvent(event, { rawRecordId: raw.id });
      if (result === "created") {
        summary.eventsCreated += 1;
      } else if (result === "unchanged") {
        summary.eventsUnchanged += 1;
      } else {
        // Same economic identity, but the stored event carries different
        // gross/FX details (e.g. a corrected re-export). The first event stands
        // and both raw rows are in the vault; the difference is made visible.
        summary.eventsConflicting += 1;
        summary.rowErrors.push({
          line: row.line,
          message: `event ${event.externalId} conflicts with the stored event's gross/FX details; review required`,
        });
      }
    }
  });
}

export async function runPortfolioPerformanceHoldingsImport(
  input: RunPortfolioPerformanceHoldingsImportInput,
): Promise<PortfolioImportSummary> {
  assertIsoDate(input.asOf, "asOf");
  return withRun(input, async (summary) => {
    const parsed = parsePortfolioPerformanceHoldingsCsv(input.csv, input.parseOptions);
    summary.rowsParsed = parsed.rows.length;
    summary.rowErrors.push(...parsed.errors);
    const known = onceRegistry(input.portfolioStore);

    for (const holding of parsed.rows) {
      const identity = holdingIdentity(holding, input.asOf);
      const externalId = `pp_holding_${stableJsonHash(identity)}`;
      const payload: PpRawHoldingPayload = {
        format: "portfolio_performance_holdings_csv",
        asOf: input.asOf,
        columns: holding.columns,
      };
      const raw = await appendRaw(input, "portfolio_valuation", externalId, payload);
      const snapshot = normalizePortfolioPerformanceHolding(holding, {
        id: `valuation:${input.sourceId}:${externalId}`,
        workspaceId: input.workspaceId,
        sourceId: input.sourceId,
        asOf: input.asOf,
        rawRecordId: raw.id,
        createdAt: input.env.nowIso(),
        defaultAccountExternalId: input.defaultAccountExternalId,
      });
      if (snapshot.brokerAccountExternalId !== undefined) {
        await known.account({
          externalId: snapshot.brokerAccountExternalId,
          name: snapshot.brokerAccountExternalId,
          kind: "securities",
          currency: snapshot.marketValue.commodity,
        });
      }
      await known.security(snapshot.security);

      const result = await input.portfolioStore.saveValuation(snapshot);
      if (result === "created") {
        summary.valuationsCreated += 1;
      } else if (result === "unchanged") {
        summary.valuationsUnchanged += 1;
      } else {
        // Two exports for the same day disagree; keep the first snapshot (raw
        // rows of both are in the vault) and make the disagreement visible.
        summary.valuationsConflicting += 1;
        summary.rowErrors.push({
          line: holding.line,
          message: `valuation for ${input.asOf} conflicts with an already stored snapshot of the same account/security`,
        });
      }
    }
  });
}
