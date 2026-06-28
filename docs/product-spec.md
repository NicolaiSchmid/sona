# Product Spec

## One-liner

Sona is a personal tax backoffice for private individuals who self-manage wealth and prepare their own taxes.

## Problem

Private individuals with non-trivial finances often have data spread across banks, brokers, email inboxes, merchant portals, PDFs, receipt folders, real estate records, and tax software. Tax season becomes a manual reconstruction exercise:

- find transactions,
- find receipts,
- determine whether something is tax-relevant,
- reconcile invoices against bank statements,
- maintain depreciation schedules,
- prepare exports for ELSTER, tax software, or a Steuerberater.

Budgeting apps do not solve this. Business accounting tools solve a different problem and assume legal-person accounting workflows.

## Target customer

Primary ICP:

- private individuals,
- self-managed wealth,
- self-prepared taxes or semi-self-prepared tax packages,
- multiple banks/brokers/assets,
- German tax focus initially,
- high willingness to trade setup effort for less annual tax chaos.

Out of scope for the initial product:

- GmbH/UG accounting,
- payroll,
- VAT-first business bookkeeping,
- automatic tax submission,
- payment initiation.

## Product promise

> Connect sources once. Sona collects receipts, invoices, transactions, portfolio events, and asset schedules throughout the year, reconciles them into an evidence-linked ledger, and exports a reviewable tax package.

## Core workflows

### 1. Source onboarding

Users connect or configure:

- bank aggregation provider, e.g. Enable Banking,
- email inboxes for invoices,
- receipt upload address/dropzone,
- browser-automated merchant portals,
- Portfolio Performance exports,
- real estate and depreciable assets.

### 2. Continuous collection

Sona pulls:

- transactions,
- balances,
- PDF invoices,
- receipts,
- email invoice attachments,
- recurring subscription invoices,
- portfolio transactions/snapshots,
- asset events.

### 3. Reconciliation

Sona matches:

- receipt ↔ bank transaction,
- invoice ↔ payment,
- refund ↔ original charge,
- transfer leg ↔ transfer leg,
- portfolio cash movement ↔ bank movement,
- asset event ↔ depreciation schedule.

### 4. Review queue

The user reviews:

- uncategorized transactions,
- uncertain receipt matches,
- missing receipts for tax-relevant items,
- tax category suggestions,
- depreciation assumptions,
- export field mappings.

### 5. Export

Sona generates:

- tax-year summary,
- CSV exports,
- evidence manifest,
- receipt ZIP or document bundle,
- missing evidence report,
- depreciation schedule report,
- later: ELSTER/ERiC draft/pre-fill artifacts.

## Non-goals

- Sona does not give individualized tax advice as a black box.
- Sona does not silently decide deductibility.
- Sona does not submit ELSTER forms automatically.
- Sona does not initiate payments.
- Sona does not focus primarily on budgeting dashboards.

## Positioning language

Prefer:

- tax-ready export,
- evidence-linked ledger,
- personal tax backoffice,
- suggested category,
- user-reviewed,
- configurable tax template.

Avoid:

- guaranteed deductible,
- automated tax filing,
- AI tax advisor,
- accountant replacement.

## Business model hypothesis

Open-core:

- self-hostable core and local MCP engine,
- paid hosted cloud for friends/normal users,
- paid receipt inbox/storage/OCR automation,
- paid premium tax templates and guided review workflows,
- later accountant collaboration.

Cloud should be usable first, because the early friend ICP will not self-host. The implementation should remain portable enough to offer self-hosting later.