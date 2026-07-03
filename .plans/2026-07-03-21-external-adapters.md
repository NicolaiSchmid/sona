# External Adapters Plan

## Purpose

Close the v1 loop with the outbound/interop adapters: ELSTER/ERiC-oriented draft export mapping (no submission), accountant collaboration exports, and a Paperless-ngx adapter for users with existing document archives.

## Goals

- ELSTER-oriented draft mapping: map tax-de export sections to Anlage-level line groupings (Anlage V, Sonderausgaben, etc.) as a reviewable draft document a user copies from — explicitly not a submission and clearly labeled as prepared values.
- Accountant package: a share-ready export (ZIP) with summary, category CSVs, receipt bundle, and evidence manifest; optionally an expiring read-only share link in hosted mode.
- Paperless-ngx adapter: import documents from an existing Paperless instance as an ingestion source (Paperless stays an adapter, originals are copied into Sona storage).
- Adapter registry docs: how third-party adapters plug into sources/exports.

## Non-Goals

- ELSTER/ERiC submission, certificates, or any transmission to tax authorities.
- Two-way Paperless sync (import only).
- Public adapter SDK/plugin marketplace.

## Required Reading

- `docs/tax-exports.md`
- `.plans/2026-06-28-07-german-private-tax-export.md` follow-ups
- `AGENTS.md` tax boundaries (wording rules are load-bearing here)

## Target Files

Likely create/modify:

```text
packages/tax-de/src/elster-draft/mapping.ts
packages/tax-de/src/elster-draft/render.ts
packages/tax-de/src/elster-draft/*.test.ts
packages/tax-de/src/accountant/package.ts
packages/connectors/src/paperless/client.ts
packages/connectors/src/paperless/sync.ts
packages/connectors/src/paperless/*.test.ts
apps/web/src/routes/export/* (share/download)
docs/tax-exports.md
```

## Design Constraints

- ELSTER draft mapping is configurable data (like tax templates): section → Anlage/line grouping, versioned per tax year; unmapped sections render into an explicit "unmapped — review" block rather than disappearing.
- Every draft value carries its trace: export lines → postings → evidence; the rendered draft includes review-state and a prominent "prepared values, verify before filing" banner.
- Only `user_reviewed`+ lines enter the ELSTER draft and accountant package (stricter than the phase-07 draft mode).
- Accountant share links (hosted): expiring, revocable, read-only, audited access, no account required; documents stream with hash verification.
- Paperless adapter follows the connector pattern: fake client + fixtures, idempotent by content hash, originals copied into Sona storage with provenance pointing back to the Paperless document ID.

## TDD Steps

### Task 1: ELSTER draft mapping

Write tests first:

- mapped sections aggregate reviewed lines per year with correct sums,
- unmapped section lands in the review block,
- non-reviewed lines never appear,
- rendered output contains the verification banner and no deductibility claims (string-level assertions).

### Task 2: Accountant package

- ZIP manifest matches phase-07 package plus receipt bundle,
- every included document referenced by at least one export line; orphans excluded,
- share link expiry/revocation enforced and access audited.

### Task 3: Paperless import

- fixture documents import with tags/correspondent mapped to metadata,
- re-sync imports nothing new (hash + external ID dedup),
- Paperless downtime yields a clean failed sync run, no partial state.

## Acceptance Criteria

- `pnpm check` passes.
- ELSTER draft artifacts are traceable end-to-end and contain zero submission code paths.
- Commit uses Conventional Commits, e.g. `feat(tax-de): add elster draft mapping and accountant export package`.

## Follow-Up

- ERiC-based validated draft files if/when submission is ever designed (explicit product/legal/security design first, per AGENTS.md).
- Additional receipt portals and open-banking providers.
- Steuerberater-facing DATEV-style export research.
