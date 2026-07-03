# Assets and Depreciation Plan

## Purpose

Add the asset registry and configurable depreciation schedules: real estate with building/land components, other depreciable assets, annual depreciation postings as drafts, and evidence links to purchase contracts and improvements. This feeds Anlage V preparation in the tax export.

## Goals

- Add asset model: kind, acquisition date/cost, components, useful life, residual handling.
- Support real estate specifics: building/land cost split, acquisition side-costs allocation, post-acquisition improvements (nachträgliche Herstellungskosten) extending the schedule.
- Configurable schedule methods: linear percentage (e.g. 2%, 2.5%, 3%) and linear over useful life — as user-configured data, not hardcoded legal claims.
- Generate annual depreciation postings as `draft` ledger transactions requiring review.
- Link assets to evidence documents (contracts, invoices for improvements).
- Extend the tax-de export with a depreciation schedule section.

## Non-Goals

- Deciding legally correct AfA rates for the user (they configure; Sona computes and labels as configured).
- Degressive/declining-balance methods (follow-up).
- Property valuation.

## Required Reading

- `docs/data-model.md`
- `docs/tax-exports.md`
- `.plans/2026-06-28-07-german-private-tax-export.md`
- `AGENTS.md` tax boundary wording rules

## Target Files

Likely create/modify:

```text
packages/core/src/assets/types.ts
packages/core/src/assets/schedule.ts
packages/core/src/assets/postings.ts
packages/core/src/assets/*.test.ts
packages/db/src/migrations/0006_assets.sql
packages/db/src/repositories/assets.ts
packages/tax-de/src/export/depreciation.ts
apps/worker/src/jobs/depreciation.ts
```

## Design Constraints

- Schedules are pure functions of asset config + date range; deterministic and unit-tested with money types, no floats.
- First/last year pro-rata by month (pro rata temporis) as configurable behavior.
- Depreciation postings balance: `Expenses:Depreciation:<asset>` against `Assets:<asset>:AccumulatedDepreciation`; both drafts until reviewed.
- Improvements append to the asset history (append-only); the schedule recomputes forward, never rewrites past posted years — corrections to already-reviewed years happen via explicit adjustment postings.
- Every schedule row references the asset, config version, and evidence documents.

## TDD Steps

### Task 1: Schedule math

Write tests first:

- linear 2% building schedule over sample years, mid-year acquisition pro-rata,
- land component depreciates nothing,
- improvement in year N raises basis from year N forward only,
- schedule never depreciates below zero book value.

### Task 2: Posting generation

- annual job creates balanced draft postings once per asset-year (idempotent),
- reviewed prior-year postings are never modified by recomputation.

### Task 3: Export integration

- depreciation section appears in the tax export with per-asset rows, config provenance, review state,
- missing evidence (no purchase contract linked) appears in the missing-evidence report.

## Acceptance Criteria

- `pnpm check` passes.
- All schedule outputs traceable to asset config version and evidence.
- Wording in export artifacts stays at "configured schedule", never "legally required rate".
- Commit uses Conventional Commits, e.g. `feat(core): add asset registry and depreciation schedules`.

## Follow-Up

- Degressive methods and § 7b-style options as configurable templates.
- Disposal/sale handling with gain/loss postings.
- Sonder-AfA scenarios as opt-in templates.
