# AGENTS.md - Coding Agent Guidelines for Sona

`sona` is a personal tax backoffice for private individuals who self-manage wealth and prepare their own taxes.

Treat this repository as sensitive financial/tax infrastructure, not a budgeting toy, generic accounting app, or autonomous tax advisor.

## Core Rules

- Read `README.md` before making changes.
- Keep the product boundary clear: Sona automates backoffice preparation, reconciliation, evidence management, and exports. It does not silently decide tax law or submit tax returns.
- The ICP is private individuals with non-trivial wealth/tax backoffice needs, not GmbH/UG/legal-person accounting.
- Primary product value is tax readiness: reconciliation, depreciation, receipt/invoice capture, evidence-linked exports, and review workflows.
- Budgeting and "where did my money go" insights are secondary.
- Financial, tax, receipt, invoice, real estate, medical, legal, insurance, broker, banking, and portal data are sensitive production data.
- Do not commit secrets, OAuth tokens, bank sessions, private keys, portal credentials, local environment files, real receipts, real bank data, real IBANs, or user exports.
- AI may suggest classifications, matches, rules, and export mappings. Humans approve tax-relevant decisions.
- Do not build automatic ELSTER submission or payment initiation without explicit product/legal/security design.

## Product Boundary

Sona owns the personal tax backoffice layer:

- collect transactions, receipts, invoices, portfolio events, and asset events,
- preserve raw source records,
- store documents as first-class evidence,
- reconcile receipts/invoices with transactions,
- maintain a double-entry evidence ledger,
- queue uncertain classifications and matches for review,
- manage configurable tax-oriented account templates,
- generate tax-ready export packages,
- expose safe code-mode MCP operations for agents.

Sona must not:

- present AI output as individualized tax advice,
- claim a transaction is legally deductible without user-configured rules and review,
- submit tax returns automatically,
- initiate payments by default,
- mutate external merchant/bank/portal settings during receipt fetching,
- hide unsupported assumptions inside templates,
- store only external links for receipts when the product needs durable evidence.

## Preferred Stack

- TypeScript strict mode.
- Code-mode MCP as a first-class control surface.
- Typed `sona.*` facade for MCP execution.
- PostgreSQL for hosted cloud; SQLite may be supported for local/self-hosted mode.
- Drizzle or Kysely for typed SQL.
- Zod or Valibot at boundaries.
- Vitest for tests.
- Playwright/Browserbase for browser automation where official APIs/email exports are unavailable.
- Object storage abstraction for receipt/invoice originals.

## MCP Tools

Prefer a flat code-mode MCP surface over one tool per backend operation:

- `docs`
- `search`
- `execute`

`search` should inspect reviewed TypeScript function catalogs. `execute` should run code against a typed `sona.*` facade, such as:

```ts
await sona.sources.list();
await sona.sources.sync({ sourceId });
await sona.receipts.ingestUpload({ fileId });
await sona.reconciliation.suggestReceiptMatches({ taxYear: 2026 });
await sona.tax.generatePackage({ year: 2026 });
```

Keep string-based backend paths private. Do not expose raw database/function paths as the public agent interface.

## Data Model Principles

Every derived number must be traceable:

- raw source record,
- normalized record,
- ledger transaction,
- ledger postings,
- receipt/document evidence,
- classification rule or manual review,
- tax category/export line.

Every double-entry transaction must balance per commodity. If a counter-account is unknown, use explicit suspense accounts such as `Suspense:Unclassified` or `Suspense:NeedsReceipt`.

Raw source rows should be immutable or append-only. Corrections happen via supersession, review events, or ledger adjustments.

## Receipt and Invoice Handling

Receipts are first-class product data.

- Store originals internally for normal users.
- External systems such as Paperless are adapters, not the default product assumption.
- Record hashes, provenance, source URL/portal/email/upload metadata, extraction status, and retention state.
- Mass upload and auto-reconciliation are core workflows.
- High-confidence auto-match is allowed only under configurable conservative policy.
- Tax-relevant or high-value uncertain matches must enter a review queue.

## Browser/Agent Receipt Fetching

Browser tasks must be read-only by design.

- Use domain allowlists.
- Use versioned task definitions.
- Record task run provenance.
- Redact credentials and sensitive fields from logs.
- Never buy, cancel, change payment methods, change profile settings, or mutate portal state.
- Prefer official APIs/email exports before browser automation.
- Support managed Browserbase-style execution and leave room for user-provided agent/browser subscriptions where feasible.

## Tax and Compliance Boundaries

- Use wording like "suggested category", "configured rule", "review required", and "tax-ready export".
- Avoid wording like "guaranteed deductible" or "AI files your taxes".
- Maintain review states: `draft`, `suggested`, `user_reviewed`, `advisor_reviewed`, `exported`, `superseded`.
- Hosted cloud must support data export, deletion, audit logs, encryption, credential isolation, and subprocessor tracking.
- Expect GDPR work and likely DPIA/Datenschutz-Folgenabschätzung.
- Use regulated bank aggregators for bank data; do not build direct PSD2/eIDAS connectivity by default.

## Planning

- Store implementation plans in `.plans/` at the repo root for work that needs a written plan.
- Use repo-relative paths in plan files.
- Commit plan files with related work when useful.

## Code Style

- TypeScript should be strict.
- Prefer named types/interfaces for important data shapes.
- Prefer literal union types over TypeScript `enum`.
- Use `as const` and `satisfies` where they improve type safety.
- Avoid `any`; use precise types or `unknown` with narrowing.
- Use `import type` for type-only imports.
- Use 2-space indentation, double quotes, semicolons, and trailing commas.
- Keep financial/tax logic small, testable, and easy to audit.
- Keep validation close to write boundaries and tool/action entrypoints.

## Testing

Add focused tests around:

- tenant/user isolation,
- double-entry balancing,
- raw source immutability/supersession,
- idempotent imports,
- receipt/document hash deduplication,
- receipt ↔ transaction matching,
- review gates,
- export traceability,
- credential encryption and redaction,
- browser task read-only guardrails,
- tax template mapping behavior.

Do not process real user financial data until these paths are covered for the relevant feature.

## Review Guidelines

When reviewing changes, prioritize correctness, privacy, and product risk over style preferences already covered by tooling.

Focus on:

- cross-user data leaks,
- secrets or personal data exposure,
- unbalanced ledger postings,
- destructive source mutations,
- unsupported tax/legal claims,
- AI bypassing review gates,
- unsafe browser automation,
- missing audit logs,
- missing idempotency,
- missing tests for changed financial/tax behavior.

Use concise findings with exact file and line references. State the impact, failure mode, and smallest reasonable fix.

## Git

- Use Conventional Commits for new commits: `type(scope): short summary`.
- Common types: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`.
- Keep commits focused.
- Do not revert user changes unless explicitly asked.
