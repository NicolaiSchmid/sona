# Architecture

## Design goals

- Cloud-usable for early trusted users.
- Self-hostable without architectural rewrites.
- Code-mode MCP first, like a typed operational backend agents can safely use.
- Strict auditability: every import, suggestion, mutation, and export is traceable.
- Configurable templates rather than hardcoded personal finance assumptions.
- Read-only financial source integration by default.

## High-level components

```text
apps/
  web/          review UI, onboarding, document upload
  worker/       scheduled source sync, OCR, reconciliation, exports
  mcp/          code-mode MCP endpoint

packages/
  core/         ledger, evidence graph, validation, domain types
  db/           schema, migrations, repositories
  connectors/   bank/email/portal/portfolio adapters
  receipts/     document processing and matching
  tax-de/       German private-tax templates and export mappings
  agents/       browser automation task plans and execution adapters
```

This is a proposed layout, not yet implemented.

## Runtime modes

### Hosted cloud

Managed service for early users and friends.

- Multi-tenant application.
- User-owned data partitioning.
- Managed bank/provider credentials.
- Internal receipt/document storage.
- Background workers for syncing and matching.
- Audit logs and export/deletion flows.

### Self-hosted

Same core packages and MCP tools run in a user's environment.

- Local SQLite or Postgres.
- Local object storage or filesystem documents.
- Bring-your-own provider credentials.
- Optional integration with existing Paperless.
- Same export formats.

## MCP/code-mode surface

Prefer a flat code-mode MCP interface over many narrow tools.

Public MCP tools:

- `docs`
- `search`
- `execute`

`execute` runs TypeScript snippets against a typed `sona.*` facade:

```ts
await sona.sources.list();
await sona.sources.sync({ sourceId });
await sona.receipts.ingestUpload({ fileId });
await sona.reconciliation.suggestMatches({ taxYear: 2026 });
await sona.ledger.createRule({ pattern, account });
await sona.tax.exportPackage({ year: 2026, format: "zip" });
```

The string-based backend paths remain private implementation details.

## Source ingestion

All source adapters produce raw source records first. Normalization is a separate step.

```text
provider API / browser task / email / upload
  ↓
raw source record
  ↓
normalized candidate
  ↓
ledger transaction/posting draft
  ↓
review or rule approval
```

## Ledger model

Raw imports are not the ledger. The ledger is a derived, balanced, auditable accounting model.

Every imported financial transaction should create balanced draft postings. If the counter-account is unknown, use suspense accounts:

```text
Assets:Bank:DKB:Giro       -84.23 EUR
Suspense:Unclassified       84.23 EUR
```

After classification:

```text
Assets:Bank:DKB:Giro       -84.23 EUR
Expenses:RealEstate:Maintenance 84.23 EUR
```

## Evidence graph

Every derived line should link to supporting data:

```text
ledger posting
  ← raw bank transaction
  ← receipt document
  ← OCR extraction
  ← classification rule
  ← user review event
  ← tax export line
```

This graph is the core moat.

## Background jobs

Initial jobs:

- bank transaction sync,
- email receipt pull,
- browser receipt fetching task execution,
- OCR/text extraction,
- receipt ↔ transaction matching,
- missing evidence scan,
- tax export generation.

Jobs must be idempotent and safe to retry.

## Technology defaults

Preferred initial stack:

- TypeScript strict mode.
- PostgreSQL for hosted cloud; SQLite for local/self-hosted mode if practical.
- Drizzle or Kysely for typed SQL.
- Object storage abstraction for receipts.
- Zod or Valibot for boundary validation.
- Vitest for unit tests.
- Playwright/Browserbase for browser automation tasks.
- MCP server for agent control.

## Open questions

- Exact hosted database choice.
- Whether self-hosted mode should start with SQLite or Postgres-only Docker.
- Which OCR provider to use first.
- Whether Browserbase tasks run under Sona's account, user-provided Browserbase credentials, or a user-provided Codex/browser subscription where possible.
- Whether early users should get per-tenant encryption keys from day one.