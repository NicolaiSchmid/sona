# Core Ledger and Data Model Plan

## Purpose

Implement the first test-backed domain model for Sona: raw source records, double-entry ledger primitives, evidence links, and review states.

This is the foundation for banking, receipt reconciliation, tax exports, and browser-fetched documents.

## Goals

- Define TypeScript domain types in `packages/core`.
- Implement pure validation helpers for double-entry balancing.
- Define DB schema/migrations in `packages/db` for the core tables.
- Add tests for balancing, source immutability assumptions, and evidence linking.
- Keep the model private-tax-backoffice oriented, not GmbH/UG accounting oriented.

## Non-Goals

- Real database connection pooling for cloud.
- Hosted auth/tenancy implementation.
- Connectors or importers.
- Tax law calculations.

## Required Reading

- `README.md`
- `docs/data-model.md`
- `docs/architecture.md`
- `AGENTS.md`

## Target Files

Likely create/modify:

```text
packages/core/src/ledger/types.ts
packages/core/src/ledger/balance.ts
packages/core/src/ledger/accounts.ts
packages/core/src/evidence/types.ts
packages/core/src/review/types.ts
packages/core/src/source/types.ts
packages/core/src/index.ts
packages/core/src/ledger/balance.test.ts
packages/core/src/evidence/types.test.ts
packages/db/src/schema.ts
packages/db/src/migrations/0001_core.sql or equivalent migration file
packages/db/src/index.ts
```

## Domain Types

Start with literal union types rather than enums:

```ts
export type AccountKind =
  | "asset"
  | "liability"
  | "equity"
  | "income"
  | "expense"
  | "suspense";

export type ReviewState =
  | "draft"
  | "suggested"
  | "user_reviewed"
  | "advisor_reviewed"
  | "exported"
  | "superseded";
```

Amounts should not be JavaScript floats. Use decimal strings initially:

```ts
export interface MoneyAmount {
  amount: string;
  commodity: string;
}
```

## Core Tables

Implement an initial schema for:

```text
workspaces
sources
source_credentials
source_sync_runs
raw_source_records
ledger_accounts
ledger_transactions
ledger_postings
evidence_links
review_events
audit_events
```

If choosing Drizzle, create typed table definitions. If choosing raw SQL first, include a migration and minimal typed row interfaces.

## TDD Steps

### Task 1: Ledger balance validation

Write tests first for:

- two EUR postings summing to zero passes,
- non-zero EUR sum fails,
- mixed EUR/USD balances independently,
- invalid decimal strings fail clearly.

Then implement `validateBalancedTransaction(postings)`.

### Task 2: Account path validation

Write tests for account paths:

- `Assets:Bank:DKB:Giro` valid,
- empty segment invalid,
- lowercase/space policy whatever the agent chooses, but document it,
- default suspense accounts are valid.

Implement path parser/validator.

### Task 3: Evidence link type safety

Write tests for allowed evidence link kinds:

```text
imported_as
substantiates
classified_by
reviewed_by
generated_from
exported_as
```

Implement TypeScript types and a runtime schema.

### Task 4: DB schema smoke test

If using SQLite for tests, apply migration in an in-memory DB and assert tables exist. If using Drizzle, assert schema exports compile and a migration snapshot exists.

## Acceptance Criteria

- `pnpm check` passes.
- Double-entry balance validation is covered by tests.
- Core schema exists and matches `docs/data-model.md` at a first-pass level.
- No connector-specific logic leaks into core.
- No real financial data fixtures are added.
- Commit uses Conventional Commits, e.g. `feat(core): add ledger and evidence model`.

## Notes for T3 Agents

Keep this minimal but real. The purpose is to unblock parallel work, not to design every future table. Prefer a small model with good tests over a giant speculative schema.
