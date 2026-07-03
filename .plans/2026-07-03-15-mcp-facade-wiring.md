# MCP Facade Wiring Plan

## Purpose

Replace the deterministic stub `sona.*` facade with service-backed operations so code-mode MCP becomes the real control surface: agents can list sources, trigger syncs, ingest uploads, suggest matches, and generate exports against the actual repositories and jobs — behind risk gates and audit logging.

## Goals

- Back every facade operation with real services (repositories, job queue, export generation).
- Enforce risk tiers: read operations execute directly; mutating operations either enqueue jobs or create review items — never bypass review gates.
- Require explicit workspace context for every facade call.
- Write an audit log entry for every `execute` invocation: code hash, operations called, workspace, outcome.
- Keep `docs`/`search` catalogs generated from the same typed surface so they cannot drift.

## Non-Goals

- New facade operations beyond the existing contract (extend only where a wired service needs an input the stub lacked).
- Remote code execution hardening beyond the existing CodeRunner boundary (already gated/opt-in).
- Auth (phase 19); workspace context comes from server configuration until then.

## Required Reading

- `packages/mcp/src/facade.ts`, `catalog.ts`, `server.ts`
- `docs/architecture.md` MCP section
- `AGENTS.md` review gate and MCP rules

## Target Files

Likely create/modify:

```text
packages/mcp/src/facade.ts
packages/mcp/src/services.ts
packages/mcp/src/audit.ts
packages/mcp/src/risk.ts
packages/mcp/src/*.test.ts
packages/db/src/migrations/0005_audit.sql
```

## Risk Tiers

```text
read        → execute directly (sources.list, receipts.list, tax.previewExport, ...)
enqueue     → create an idempotent job (sources.sync, receipts.ingestUpload, tax.generatePackage)
review_gate → create suggestion/review records only (ledger.createRule, reconciliation.approveMatch*)
forbidden   → not exposed (payments, submissions, portal mutation)
```

`reconciliation.approveMatch` acts on behalf of a human only when the MCP session is explicitly marked as user-driven; agent-driven sessions can suggest, not approve. Session origin is part of the audit record.

## TDD Steps

### Task 1: Service backing

Write tests first with real SQLite + fakes for external systems:

- `sources.list` returns persisted sources for the bound workspace only,
- `sources.sync` enqueues an idempotent job and returns its ID; duplicate call returns the same job,
- `tax.generatePackage` enqueues export generation and never inlines unreviewed lines.

### Task 2: Review gates

- `ledger.createRule` creates a `draft` rule requiring review; no postings change until approved,
- agent-origin session calling `approveMatch` is rejected with a clear error,
- gated operations from the phase-03 frozen-facade tests still hold.

### Task 3: Audit log

- every execute call writes exactly one audit row with code hash and called operations,
- audit rows are append-only,
- failures are audited with redacted errors.

### Task 4: Catalog consistency

- `search`/`docs` output is generated from the facade type surface; a facade change without catalog regeneration fails a test.

## Acceptance Criteria

- `pnpm check` passes.
- No facade path can mutate ledger/tax state without a review record or an explicitly user-driven session.
- Audit coverage is 100% of execute calls (tested).
- Commit uses Conventional Commits, e.g. `feat(mcp): wire sona facade to services with risk gates and audit log`.

## Follow-Up

- Per-operation rate limits.
- Scoped API tokens for agent sessions (with phase 19 auth).
