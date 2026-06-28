# Sona

Sona is a personal tax backoffice for private individuals who self-manage wealth and prepare their own taxes.

It continuously collects bank transactions, receipts, invoices, portfolio events, and asset/depreciation schedules; reconciles them into an evidence-linked double-entry ledger; and produces tax-ready export packages that a human can review.

Sona is **not** business accounting software for GmbHs/UGs. It is for people with non-trivial private financial lives: multiple banks, brokers, rental properties, deductible expenses, subscriptions, insurance, invoices, and annual tax prep chaos.

## Product thesis

Most personal finance apps answer: **"Where did my money go?"**

Sona answers: **"Is my tax backoffice already ready?"**

The core value is not budgeting. The core value is:

- receipt and invoice capture,
- bank/portfolio/source reconciliation,
- double-entry evidence ledger,
- tax-oriented categorization,
- depreciation schedules for assets such as real estate,
- missing evidence detection,
- review queues,
- tax-ready exports with source references.

## Safety boundary

Sona automates backoffice work. It does not replace the user's judgment, Steuerberater, or tax software.

- AI may suggest classifications, receipt matches, depreciation postings, and export mappings.
- Humans approve tax-relevant decisions.
- Sona must not initiate payments by default.
- Sona must not auto-submit to ELSTER.
- ELSTER/ERiC adapters, if implemented later, generate draft/pre-fill/validation artifacts only unless a separately audited human-controlled submission flow exists.

## Target user

Sona is for private individuals who:

- self-manage wealth,
- prepare their own taxes or prepare a package for a Steuerberater,
- own broker accounts, rental property, or depreciable private assets,
- receive invoices/receipts across email portals and PDFs,
- want every tax-relevant number traceable to evidence,
- do not want to operate business accounting software.

## Architecture direction

Sona should be cloud-usable for early trusted users while staying cleanly self-hostable.

```text
External sources
  ├─ banks / open banking / FinTS
  ├─ email inboxes
  ├─ merchant portals via browser automation
  ├─ receipt uploads
  ├─ Portfolio Performance / broker exports
  └─ asset/depreciation schedules
      ↓
Raw source vault
      ↓
Normalizer + reconciliation engine
      ↓
Double-entry evidence ledger
      ↓
Review queues + rule engine
      ↓
Tax-ready exports + MCP/code-mode tools
```

The first implementation should be TypeScript, strict, test-first, and exposed through a code-mode MCP surface before a large UI is built.

## Key modules

- `core`: double-entry ledger, source records, evidence graph, validation.
- `connectors`: Enable Banking, FinTS, email, upload, receipt providers, Portfolio Performance.
- `receipts`: document storage, OCR/text extraction, invoice fields, matching and reconciliation.
- `agents`: browser automation plans for receipt/invoice fetching from portals.
- `tax-de`: configurable German private-tax templates and exports.
- `mcp`: code-mode tool surface for agents and Domovoi-style automation.
- `cloud`: hosted tenancy, secrets, audit logs, jobs, billing, compliance controls.

## Documentation

- [Product spec](docs/product-spec.md)
- [Architecture](docs/architecture.md)
- [Data model](docs/data-model.md)
- [Receipt reconciliation](docs/receipt-reconciliation.md)
- [Agent receipt fetching](docs/agent-receipt-fetching.md)
- [Tax exports](docs/tax-exports.md)
- [Security, privacy, and compliance](docs/security-compliance.md)
- [Roadmap](docs/roadmap.md)

## Development principles

- Open-core friendly: self-hostable core, cloud convenience.
- Configurable first: sensible defaults, no hardcoded personal finances.
- Raw source records are immutable or append-only.
- Every derived amount links to source evidence.
- Double-entry postings must balance.
- AI suggestions are auditable drafts, not silent mutations.
- Use Conventional Commits: `type(scope): summary`.

## Development

Sona is a `pnpm` workspace using TypeScript strict mode, Biome for lint/format, and Vitest for tests.

```bash
pnpm install
pnpm check     # typecheck + lint + test
```

Other scripts:

```bash
pnpm build      # tsc -b across all packages
pnpm typecheck  # tsc -b only
pnpm lint       # biome check .
pnpm format     # biome format --write .
pnpm test       # vitest run
```

### Workspace layout

```text
packages/
  core/         ledger, evidence graph, validation, domain types
  db/           schema, migrations, repositories
  connectors/   bank/email/portal/portfolio adapters
  receipts/     document processing and matching
  tax-de/       German private-tax templates and export mappings
  mcp/          code-mode MCP surface and the typed sona.* facade
apps/
  worker/       scheduled source sync, OCR, reconciliation, exports
  web/          review UI, onboarding, document upload
```

Never commit secrets, credentials, real financial data, or generated build/data output.

## Status

Pre-implementation product definition. The first milestone is a TypeScript repo skeleton with migrations, tests, and an MCP/code-mode shell.