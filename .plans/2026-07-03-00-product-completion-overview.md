# Product Completion Overview

## Purpose

Index and sequencing for all Sona implementation plans, from foundation to a complete v1 product. Each plan is one PR-sized phase, implemented sequentially against `origin/main`.

"Complete v1" means: a user can connect sources, collect transactions and receipts continuously, reconcile them into an evidence-linked ledger, review uncertain decisions in a UI, maintain assets/depreciation and portfolio records, and generate a reviewable German private tax export package — locally self-hosted or on an invite-only hosted cloud. No ELSTER submission, no payment initiation, no tax advice.

## Status

| # | Plan | Status |
|---|------|--------|
| 01 | `2026-06-28-01-typescript-foundation.md` | done |
| 02 | `2026-06-28-02-core-ledger-data-model.md` | done |
| 03 | `2026-06-28-03-code-mode-mcp-skeleton.md` | done |
| 04 | `2026-06-28-04-enable-banking-connector.md` | done |
| 05 | `2026-06-28-05-receipt-storage-reconciliation.md` | done |
| 06 | `2026-06-28-06-agent-browser-receipt-fetching.md` | done |
| 07 | `2026-06-28-07-german-private-tax-export.md` | planned |
| 08 | `2026-06-28-08-cloud-self-hosting-boundary.md` | planned |
| 09 | `2026-07-03-09-persistence-repositories.md` | planned |
| 10 | `2026-07-03-10-document-storage-secret-store.md` | planned |
| 11 | `2026-07-03-11-worker-jobs-ingestion.md` | planned |
| 12 | `2026-07-03-12-receipt-extraction-pipeline.md` | planned |
| 13 | `2026-07-03-13-email-invoice-ingestion.md` | planned |
| 14 | `2026-07-03-14-browser-portal-runner.md` | planned |
| 15 | `2026-07-03-15-mcp-facade-wiring.md` | planned |
| 16 | `2026-07-03-16-assets-depreciation.md` | planned |
| 17 | `2026-07-03-17-portfolio-support.md` | planned |
| 18 | `2026-07-03-18-web-review-ui.md` | planned |
| 19 | `2026-07-03-19-auth-tenancy.md` | planned |
| 20 | `2026-07-03-20-hosted-cloud-mvp.md` | planned |
| 21 | `2026-07-03-21-external-adapters.md` | planned |

## Sequencing Rationale

Phases 01–06 built pure, tested domain logic with injected store interfaces and deterministic fakes. The remaining phases fall into four arcs:

### Arc A: Complete the domain (07–08)

- 07 adds the core product value: tax templates, export lines, missing-evidence report, package manifest.
- 08 defines runtime modes, tenancy context, and storage/secret abstractions that every wiring phase depends on.

### Arc B: Wire it together (09–15)

Turn libraries into a working local product:

- 09 implements real SQLite repositories behind the store interfaces from phases 04–06.
- 10 implements filesystem document storage and an encrypted local secret store behind the phase-08 interfaces.
- 11 adds idempotent worker jobs that compose connectors, receipts, and repositories into continuous pipelines.
- 12 adds real receipt field extraction behind an adapter interface.
- 13 adds email invoice ingestion (preferred before browser automation).
- 14 adds a real Browserbase/Playwright portal runner behind the phase-06 read-only policy.
- 15 replaces the stub `sona.*` facade with service-backed operations behind risk gates and audit logging.

After Arc B, Sona works end-to-end for a single local workspace driven through code-mode MCP.

### Arc C: Complete the tax scope (16–17)

- 16 adds asset registry and depreciation schedules (Anlage V preparation depends on this).
- 17 adds portfolio/broker support (Portfolio Performance import, valuation snapshots).

### Arc D: Product surface and hosting (18–21)

- 18 adds the web review UI (review queue, uploads, export preview) for a local single workspace.
- 19 adds invite-only auth and workspace membership.
- 20 implements the hosted cloud MVP: Postgres, object storage, KMS secrets, audit logs, data export/deletion, DPIA checklist.
- 21 adds external adapters: ELSTER/ERiC draft export mapping (no submission), accountant collaboration exports, Paperless.

## Rules That Apply to Every Phase

- Read `AGENTS.md` and the relevant `docs/*.md` before implementing.
- One Conventional Commit PR per phase; wait for CI and review before merge.
- All domain writes require explicit workspace context.
- Raw source records stay append-only; corrections via supersession.
- AI suggests, humans approve tax-relevant decisions; review gates are never bypassed.
- No ELSTER submission, no payment initiation, no portal state mutation.
- Add tests for every changed financial/tax behavior before touching real user data.
