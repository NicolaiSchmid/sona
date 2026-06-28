# Data Model

This document sketches the canonical entities. Names are provisional.

## Principles

- Raw source data is preserved.
- Ledger data is derived, balanced, and auditable.
- Documents are first-class evidence, not just links.
- Suggestions are separate from approved facts.
- Every tax export line is explainable through source links.

## Tenancy

```text
users
workspaces
workspace_members
```

Hosted cloud uses workspaces for tenant boundaries. Self-hosted can still use a single workspace.

## Sources

```text
sources
source_credentials
source_sync_runs
raw_source_records
```

`raw_source_records` stores provider payloads or browser/email extraction results.

Important fields:

- `sourceId`
- `externalId`
- `recordType`
- `payloadJson`
- `payloadHash`
- `observedAt`
- `supersedesRecordId`

## Banking

```text
bank_connections
bank_accounts
bank_transactions
bank_balances
```

Bank records link back to raw source records. They should not be manually edited; corrections happen in the ledger layer.

## Documents and receipts

```text
documents
document_files
document_extractions
document_parties
document_amounts
document_line_items
```

Sona stores documents internally for normal users. External systems such as Paperless are optional adapters.

Document fields:

- original filename,
- content hash,
- MIME type,
- storage URI,
- vendor/correspondent,
- document date,
- total amount,
- currency,
- tax amount if present,
- OCR/text extraction,
- source URL or portal metadata,
- retention and deletion state.

## Double-entry ledger

```text
ledger_accounts
ledger_transactions
ledger_postings
commodities
```

Account defaults should be tax-oriented for private individuals.

Example account tree:

```text
Assets:Bank
Assets:Broker
Assets:RealEstate
Liabilities:Mortgage
Income:Salary
Income:Interest
Income:Dividends
Income:Rental
Expenses:RealEstate:Interest
Expenses:RealEstate:Maintenance
Expenses:RealEstate:Depreciation
Expenses:Insurance
Expenses:TaxAdvice
Expenses:WorkRelated
Expenses:Donations
Suspense:Unclassified
Suspense:NeedsReceipt
Equity:OpeningBalances
```

Every transaction must balance per commodity.

## Evidence links

```text
evidence_links
```

Links any domain record to any other with a typed relationship.

Examples:

```text
bank_transaction -> ledger_transaction        imported_as
receipt_document -> ledger_transaction        substantiates
classification_rule -> ledger_posting         classified_by
user_review_event -> tax_export_line          approved
asset_schedule -> ledger_transaction          generated_depreciation
```

## Reconciliation

```text
match_candidates
match_decisions
reconciliation_runs
```

A candidate represents a possible link, e.g. receipt to transaction. A decision records human or rule approval/rejection.

Candidate scoring dimensions:

- amount equality,
- currency equality,
- date proximity,
- vendor/counterparty similarity,
- invoice/reference number,
- IBAN/payment reference,
- OCR confidence,
- source reliability.

## Rules and review

```text
classification_rules
receipt_policies
review_items
review_events
```

Rules produce suggestions. Review events approve, reject, or adjust suggestions.

## Assets and depreciation

```text
assets
asset_components
asset_events
asset_depreciation_schedules
asset_depreciation_entries
```

Real estate needs component support, e.g. land/building split, improvements, maintenance, financing costs.

## Tax exports

```text
tax_years
tax_categories
tax_mappings
tax_export_runs
tax_export_lines
```

Tax mappings are configurable templates. Export lines link to ledger postings and evidence documents.

## Audit logs

```text
audit_events
```

Audit every high-impact action:

- credential change,
- source connection,
- document deletion,
- classification approval,
- rule creation,
- export generation,
- tax mapping change,
- admin access.
