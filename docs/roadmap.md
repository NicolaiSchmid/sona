# Roadmap

## Phase 0: Definition

- [x] Define ICP: private individuals who self-manage wealth and taxes.
- [x] Define product focus: tax backoffice, not budgeting.
- [x] Create repository and initial documentation.
- [ ] Choose initial license/source model.
- [ ] Decide hosted database/object storage defaults.

## Phase 1: TypeScript foundation

- [ ] Create package/workspace structure.
- [ ] Add strict TypeScript, linting, formatting, tests.
- [ ] Add database schema and migrations.
- [ ] Implement double-entry validation.
- [ ] Implement raw source records.
- [ ] Implement evidence links.
- [ ] Implement code-mode MCP skeleton.

## Phase 2: Banking import

- [ ] Port Enable Banking spike to TypeScript.
- [ ] Store bank connections, accounts, balances, transactions.
- [ ] Create draft ledger postings into suspense accounts.
- [ ] Add idempotent sync runs.
- [ ] Add tests with synthetic fixtures.

## Phase 3: Receipt storage and mass reconciliation

- [ ] Internal document storage abstraction.
- [ ] Upload/email ingestion path.
- [ ] OCR/text extraction adapter.
- [ ] Extract vendor/date/amount/invoice fields.
- [ ] Receipt ↔ transaction match candidates.
- [ ] Auto-apply policy and review queue.

## Phase 4: Agent/browser receipt fetching

- [ ] Define portal task schema.
- [ ] Add Browserbase/Playwright runner abstraction.
- [ ] Implement one read-only portal adapter.
- [ ] Store fetched documents with provenance.
- [ ] Explore user-supplied Codex/browser automation mode.

## Phase 5: Tax export v0

- [ ] German private-tax category templates.
- [ ] Missing evidence report.
- [ ] CSV/Markdown/HTML export package.
- [ ] Receipt manifest and evidence JSON.
- [ ] User review gating.

## Phase 6: Assets and depreciation

- [ ] Asset registry.
- [ ] Real estate components.
- [ ] Configurable depreciation schedules.
- [ ] Annual depreciation postings.
- [ ] Evidence links to contracts/improvements.

## Phase 7: Portfolio support

- [ ] Portfolio Performance import.
- [ ] Broker cash/security transaction model.
- [ ] Valuation snapshots.
- [ ] Tax export integration for relevant events.

## Phase 8: Cloud MVP

- [ ] Invite-only auth/tenancy.
- [ ] Hosted workers.
- [ ] Secure credential vault.
- [ ] Managed object storage.
- [ ] Data export/deletion.
- [ ] Initial DPIA/security review.

## Phase 9: Future adapters

- [ ] ELSTER/ERiC draft export adapter.
- [ ] Accountant collaboration/export links.
- [ ] Additional bank/open-banking providers.
- [ ] Additional receipt portal adapters.
