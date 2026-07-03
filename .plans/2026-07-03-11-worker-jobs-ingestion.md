# Worker Jobs and Ingestion Pipeline Plan

## Purpose

Turn `apps/worker` from a placeholder into an idempotent background job runner that composes the existing domain logic into continuous pipelines: bank sync → draft ledger postings, document ingest → extraction → reconciliation, and export generation.

After this phase, Sona works end-to-end for a local workspace without manual orchestration.

## Goals

- Add a small typed job model: job kinds, payload schemas, idempotency keys, attempts, backoff.
- Implement job kinds: `source_sync`, `document_ingest`, `extraction`, `reconciliation`, `export_generation`.
- Generate draft double-entry postings from synced bank transactions into suspense accounts (`Suspense:Unclassified`).
- Persist job runs with provenance (which job produced which records).
- Add a scheduler entry point (interval-based is enough; no cron infrastructure).

## Non-Goals

- Distributed queue infrastructure (a SQLite-backed queue table is enough; hosted queue is phase 20).
- Extraction provider implementation (phase 12; use the fake here).
- UI progress reporting (phase 18).

## Required Reading

- `docs/architecture.md`
- `docs/data-model.md` posting rules
- `.plans/2026-07-03-09-persistence-repositories.md`
- `AGENTS.md` idempotency and double-entry rules

## Target Files

Likely create/modify:

```text
apps/worker/src/jobs/types.ts
apps/worker/src/jobs/queue.ts
apps/worker/src/jobs/source-sync.ts
apps/worker/src/jobs/document-ingest.ts
apps/worker/src/jobs/reconciliation.ts
apps/worker/src/jobs/export-generation.ts
apps/worker/src/jobs/*.test.ts
apps/worker/src/index.ts
packages/db/src/migrations/0004_jobs.sql
```

## Design Constraints

- Every job has an idempotency key derived from its payload (e.g. `source_sync:<sourceId>:<window>`); enqueueing a duplicate is a no-op.
- Jobs are safe to retry: re-running a completed job must not duplicate raw records, documents, postings, or review items (relies on phase-09 upsert semantics; test it here end-to-end).
- Draft postings must balance per commodity; the counter-leg goes to an explicit suspense account.
- Jobs record `startedAt`, `finishedAt`, `status`, `error` (redacted), and produced-record references.
- A failed job never leaves partial ledger transactions: posting writes happen in one DB transaction.

## TDD Steps

### Task 1: Queue semantics

Write tests first:

- enqueue/claim/complete lifecycle,
- duplicate idempotency key is a no-op,
- failed job retries with backoff up to max attempts, then lands in a dead-letter state,
- two workers cannot claim the same job.

### Task 2: Source sync job

- runs the Enable Banking sync against a fake client, persists via real SQLite repos,
- creates balanced draft postings into suspense accounts for new transactions,
- re-run produces zero new records.

### Task 3: Ingest and reconciliation jobs

- document ingest stores original, computes hash, enqueues extraction,
- extraction job (fake provider) writes extraction results and enqueues reconciliation,
- reconciliation job produces match candidates, auto-applies only within the conservative policy, queues the rest for review,
- full pipeline replay is idempotent.

### Task 4: Export generation job

- generates a phase-07 export package for a year from reviewed postings only.

## Acceptance Criteria

- `pnpm check` passes.
- End-to-end pipeline test: fixture bank data + fixture receipt → persisted, matched or queued, exportable — twice, with identical final state.
- All postings written by jobs balance (asserted in tests).
- Commit uses Conventional Commits, e.g. `feat(worker): add idempotent job queue and ingestion pipeline`.

## Follow-Up

- Hosted worker deployment and horizontal claim locking hardening (phase 20).
- Job visibility in the review UI (phase 18).
