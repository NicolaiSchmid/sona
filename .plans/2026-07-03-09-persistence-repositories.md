# Persistence Repositories Plan

## Purpose

Implement real SQLite-backed repositories behind the store interfaces that phases 04–06 defined and currently satisfy only with in-memory fakes. After this phase, connector syncs, receipt reconciliation, and portal task runs persist to the `@sona/db` schema.

## Goals

- Implement `SyncRunStore`, `RawRecordStore`, and `BankRecordStore` from `packages/connectors/src/enable-banking/sync.ts` on top of `@sona/db`.
- Implement document, extraction, match-candidate, and review-queue stores used by `@sona/receipts`.
- Implement a portal task run store for `@sona/agents` provenance records.
- Add any missing migrations (e.g. `0003_agents.sql` for portal task runs).
- Enforce workspace scoping on every query.
- Keep raw source records append-only at the repository layer.

## Non-Goals

- Postgres implementations (phase 20).
- Ledger posting generation from bank transactions (phase 11 composes this).
- Facade or worker wiring.
- Schema redesign; extend the existing migrations only where a store has no table.

## Required Reading

- `docs/data-model.md`
- `docs/architecture.md`
- `packages/db/src/runner.ts` (the `DbClient` abstraction over `node:sqlite`)
- `packages/connectors/src/enable-banking/sync.ts` store interfaces
- `AGENTS.md` data model principles

## Target Files

Likely create/modify:

```text
packages/db/src/repositories/sync-runs.ts
packages/db/src/repositories/raw-records.ts
packages/db/src/repositories/bank-records.ts
packages/db/src/repositories/documents.ts
packages/db/src/repositories/matches.ts
packages/db/src/repositories/review-queue.ts
packages/db/src/repositories/portal-task-runs.ts
packages/db/src/repositories/*.test.ts
packages/db/src/migrations/0003_agents.sql (if needed)
packages/db/src/index.ts
```

## Design Constraints

- Every repository constructor takes a `DbClient` and every method takes explicit `workspaceId` (or a workspace-bound repository is created per request); no hidden globals.
- Raw record repositories expose `append` and read methods only — no update, no delete. Supersession is a new row referencing the superseded one.
- Upserts must be idempotent on natural keys (e.g. `(workspaceId, sourceId, externalId)` for bank transactions, `(workspaceId, contentHash)` for documents).
- Use parameterized statements only; never interpolate values into SQL.
- Keep repository methods thin: no business logic, no scoring, no policy.

## TDD Steps

### Task 1: Bank record stores

Write tests first against in-memory SQLite with real migrations:

- sync run start/finish/error roundtrip,
- raw record append is immutable (no update path exists),
- saving the same transaction twice by external ID does not duplicate,
- transactions from workspace A are invisible to workspace B.

### Task 2: Document and match stores

- document insert with duplicate `contentHash` in the same workspace is rejected or returns the existing row (match phase-05 dedup semantics),
- match candidates and review queue items roundtrip with provenance fields intact,
- review state transitions persist (`suggested` → `user_reviewed`).

### Task 3: Portal task run store

- run provenance rows persist with redacted-log guarantees (no credential fields in schema),
- run rows are append-only.

## Acceptance Criteria

- `pnpm check` passes.
- All fake stores used in phase 04–06 tests have a SQLite twin passing the same behavioral test suite (share test suites where practical).
- Cross-workspace isolation is tested for every repository.
- No raw record update/delete API exists.
- Commit uses Conventional Commits, e.g. `feat(db): add sqlite repositories for sync, receipts, and portal runs`.

## Follow-Up

- Postgres implementations behind the same interfaces (phase 20).
- Ledger posting repositories used by worker jobs (phase 11).
