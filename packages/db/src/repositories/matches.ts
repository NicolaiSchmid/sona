import type { MatchCandidate, MatchDecision } from "@sona/receipts";
import type { DbClient } from "../runner.js";
import { optionalString, parseJson, requiredString, row, rows, stringifyJson } from "./helpers.js";

export class SqliteMatchCandidateRepository {
  readonly #db: DbClient;

  constructor(db: DbClient) {
    this.#db = db;
  }

  async save(candidate: MatchCandidate): Promise<void> {
    this.#db
      .prepare(
        "INSERT INTO match_candidates (id, workspace_id, document_id, extraction_id, transaction_account_ref, transaction_ref, scorer_version, score, reasons_json, blockers_json, warnings_json, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id, id) DO UPDATE SET document_id = excluded.document_id, extraction_id = excluded.extraction_id, transaction_account_ref = excluded.transaction_account_ref, transaction_ref = excluded.transaction_ref, scorer_version = excluded.scorer_version, score = excluded.score, reasons_json = excluded.reasons_json, blockers_json = excluded.blockers_json, warnings_json = excluded.warnings_json, outcome = excluded.outcome",
      )
      .run(
        candidate.id,
        candidate.workspaceId,
        candidate.documentId,
        candidate.extractionId ?? null,
        candidate.transactionAccountId,
        candidate.transactionId,
        candidate.scorerVersion,
        String(candidate.score),
        stringifyJson(candidate.reasons),
        stringifyJson(candidate.blockers),
        stringifyJson(candidate.warnings),
        candidate.outcome,
        candidate.createdAt,
      );
  }

  async getById(workspaceId: string, id: string): Promise<MatchCandidate | undefined> {
    const result = row(
      this.#db
        .prepare("SELECT * FROM match_candidates WHERE workspace_id = ? AND id = ?")
        .get(workspaceId, id),
    );
    return result === undefined ? undefined : candidateFromRow(result);
  }

  async listForDocument(workspaceId: string, documentId: string): Promise<MatchCandidate[]> {
    return rows(
      this.#db
        .prepare(
          "SELECT * FROM match_candidates WHERE workspace_id = ? AND document_id = ? ORDER BY created_at, id",
        )
        .all(workspaceId, documentId),
    ).map(candidateFromRow);
  }

  async recordDecision(decision: MatchDecision): Promise<void> {
    this.#db
      .prepare(
        "INSERT INTO match_decisions (id, workspace_id, candidate_id, decision, actor, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        decision.id,
        decision.workspaceId,
        decision.candidateId,
        decision.decision,
        decision.actor,
        decision.notes ?? null,
        decision.createdAt,
      );
  }

  async listDecisions(workspaceId: string, candidateId: string): Promise<MatchDecision[]> {
    return rows(
      this.#db
        .prepare(
          "SELECT * FROM match_decisions WHERE workspace_id = ? AND candidate_id = ? ORDER BY created_at, id",
        )
        .all(workspaceId, candidateId),
    ).map(decisionFromRow);
  }
}

function candidateFromRow(source: Record<string, unknown>): MatchCandidate {
  return {
    id: requiredString(source, "id"),
    workspaceId: requiredString(source, "workspace_id"),
    transactionId: requiredString(source, "transaction_ref"),
    transactionAccountId: requiredString(source, "transaction_account_ref"),
    documentId: requiredString(source, "document_id"),
    extractionId: optionalString(source, "extraction_id"),
    scorerVersion: requiredString(source, "scorer_version"),
    score: Number(requiredString(source, "score")),
    reasons: parseJson(requiredString(source, "reasons_json")),
    blockers: parseJson(requiredString(source, "blockers_json")),
    warnings: parseJson(requiredString(source, "warnings_json")),
    outcome: requiredString(source, "outcome") as MatchCandidate["outcome"],
    createdAt: requiredString(source, "created_at"),
  };
}

function decisionFromRow(source: Record<string, unknown>): MatchDecision {
  return {
    id: requiredString(source, "id"),
    workspaceId: requiredString(source, "workspace_id"),
    candidateId: requiredString(source, "candidate_id"),
    decision: requiredString(source, "decision") as MatchDecision["decision"],
    actor: requiredString(source, "actor"),
    notes: optionalString(source, "notes"),
    createdAt: requiredString(source, "created_at"),
  };
}
