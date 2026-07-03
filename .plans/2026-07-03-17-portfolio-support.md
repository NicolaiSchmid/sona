# Portfolio Support Plan

## Purpose

Add portfolio/broker support: import Portfolio Performance exports, model broker cash and security transactions, keep valuation snapshots, and reconcile broker cash movements against bank transactions. This covers the "self-managed wealth" half of the ICP.

## Goals

- Import Portfolio Performance exports (CSV first; XML if needed) as raw source records.
- Model securities, broker accounts, security transactions (buy/sell/dividend/fee/tax), and cash movements.
- Generate balanced draft postings for portfolio events (fees, dividends, withholding tax) into the ledger.
- Store periodic valuation snapshots (informational, not ledger postings).
- Match broker cash movements ↔ bank transactions (transfer legs) via the existing reconciliation engine.
- Expose capital-income-relevant events to the tax-de export (investment fees, foreign withholding evidence).

## Non-Goals

- Live broker API connections (follow-up adapters).
- Performance analytics/returns math (Portfolio Performance already does this).
- Computing German capital gains tax (Abgeltungsteuer is bank-withheld; Sona collects evidence and flags exceptions for review, it does not compute tax).

## Required Reading

- `docs/product-spec.md` portfolio workflows
- `docs/data-model.md`
- `packages/receipts/src/reconciliation/` matching model
- `AGENTS.md` tax boundaries

## Target Files

Likely create/modify:

```text
packages/connectors/src/portfolio-performance/types.ts
packages/connectors/src/portfolio-performance/parse.ts
packages/connectors/src/portfolio-performance/normalize.ts
packages/connectors/src/portfolio-performance/*.test.ts
packages/connectors/src/portfolio-performance/fixtures.ts
packages/core/src/portfolio/types.ts
packages/db/src/migrations/0007_portfolio.sql
packages/db/src/repositories/portfolio.ts
apps/worker/src/jobs/portfolio-import.ts
```

## Design Constraints

- Follow the connector pattern: pure parse/normalize, sync composed with injected stores, synthetic fixtures only (no real ISINs tied to real holdings; use test ISINs).
- Import is idempotent on `(workspaceId, sourceId, externalId)`; Portfolio Performance re-exports overlap, so dedup is essential.
- Security quantities and prices use exact decimal types; multi-currency postings balance per commodity.
- A dividend event produces one balanced ledger transaction: gross dividend, withholding tax, fee, net cash — each leg explicit.
- Valuation snapshots are append-only reference data, clearly separated from double-entry postings.

## TDD Steps

### Task 1: Parsing and normalization

Write tests first with synthetic fixtures:

- buy/sell/dividend/fee rows parse into typed events,
- German number/date formats parse correctly,
- malformed rows are rejected with row-level errors, not silent skips.

### Task 2: Ledger integration

- dividend with withholding produces a balanced multi-leg draft transaction,
- fees map to `Expenses:Investment:Fees` (configurable),
- re-import of an overlapping export creates zero new records.

### Task 3: Cash reconciliation

- broker deposit matches the corresponding bank outflow as a transfer pair,
- unmatched broker cash movement lands in the review queue.

### Task 4: Export hooks

- investment fee postings appear in the tax export's investment section with evidence links,
- foreign withholding events appear in a review-required export section.

## Acceptance Criteria

- `pnpm check` passes.
- End-to-end: fixture export → events → balanced drafts → matched transfers → export lines, idempotent on re-run.
- Commit uses Conventional Commits, e.g. `feat(connectors): add portfolio performance import and portfolio ledger events`.

## Follow-Up

- Broker API/CSV adapters (comdirect, IBKR flex queries).
- Vorabpauschale evidence collection as a configurable template.
- Lot tracking for disposal review support.
