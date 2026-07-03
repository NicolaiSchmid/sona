# Web Review UI Plan

## Purpose

Turn `apps/web` from a placeholder into the human control surface: review queue, document upload, source status, and export preview for a local single workspace. The review UI is where "AI suggests, humans approve" becomes real.

## Goals

- Pick and wire the web stack (server-rendered TypeScript app; decide framework at implementation start and record the decision in `docs/architecture.md`).
- Review queue: list uncertain matches/classifications/extractions, show evidence side-by-side (document preview vs transaction), approve/reject/reassign with one action.
- Mass upload dropzone feeding the ingest pipeline.
- Sources page: connection status, last sync, per-source counters, manual sync trigger.
- Export page: year selection, draft preview with review-state breakdown, missing-evidence list, package download.
- Ledger browsing: accounts, transactions, drill-down to postings, raw records, and evidence.

## Non-Goals

- Auth/multi-user (phase 19; v0 binds to one configured workspace, listens on localhost by default).
- Onboarding wizards and polish.
- Mobile apps.
- Charts/budgeting dashboards (explicitly secondary per product boundary).

## Required Reading

- `docs/product-spec.md` review workflows
- `docs/receipt-reconciliation.md` review queue semantics
- `AGENTS.md` review states and wording rules

## Target Files

Likely create/modify:

```text
apps/web/src/** (framework-dependent layout)
apps/web/src/routes/review/*
apps/web/src/routes/upload/*
apps/web/src/routes/sources/*
apps/web/src/routes/export/*
apps/web/src/routes/ledger/*
apps/web/src/server/api.ts
docs/architecture.md (stack decision record)
```

## Design Constraints

- The web server calls the same service layer as the MCP facade — no parallel business logic in route handlers; review approval goes through the identical review-event path.
- Every approval writes a review event with actor, timestamp, and prior state (append-only), so the audit trail covers UI actions too.
- Review actions are idempotent (double-submit safe) and require the item to still be in a reviewable state.
- Use the exact review-state vocabulary: `draft`, `suggested`, `user_reviewed`, `advisor_reviewed`, `exported`, `superseded`.
- Wording follows tax boundaries: "suggested category", "review required" — never deductibility claims.
- Document previews stream from `DocumentStorage` with hash verification; no external URLs.
- CSRF protection and localhost-only default binding even before auth lands.

## TDD Steps

### Task 1: Service-layer endpoints

Write tests first (API level, no browser):

- review list returns only the bound workspace's items,
- approve transitions `suggested` → `user_reviewed` and writes a review event,
- approving an already-approved item is a no-op with a clear response,
- upload endpoint stores the document and enqueues ingest.

### Task 2: Export preview

- preview shows draft vs reviewed line counts; final package generation from the UI excludes non-reviewed lines exactly like the phase-07 rules.

### Task 3: E2E smoke (Playwright)

- upload fixture receipt → appears in review queue with match suggestion → approve → shows in ledger with evidence link → appears in export preview.

## Acceptance Criteria

- `pnpm check` passes; e2e smoke runs in CI.
- No business logic forked from the service layer (review by inspection + shared-service tests).
- A user can complete upload → review → export without touching the CLI.
- Commit uses Conventional Commits, e.g. `feat(web): add review queue, upload, and export ui`.

## Follow-Up

- Keyboard-driven bulk review.
- Rule creation from a reviewed example ("always classify like this").
- Advisor read-only view (with phase 19/21).
