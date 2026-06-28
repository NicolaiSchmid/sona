# Receipt Storage and Reconciliation Plan

## Purpose

Implement the first version of Sona's receipt/invoice storage and mass reconciliation engine.

This is core product value. Sona should store receipts itself for normal users, not only link to Paperless or another external system.

## Goals

- Add document storage abstraction and metadata model.
- Add receipt/invoice extraction result model.
- Add match candidate scoring between documents and bank transactions.
- Add conservative auto-apply policy hooks.
- Add review queue records for uncertain matches.
- Add tests for matching behavior.

## Non-Goals

- Production OCR provider integration.
- Full web upload UI.
- Browser portal fetching.
- Paperless adapter.
- Tax export generation.

## Required Reading

- `docs/receipt-reconciliation.md`
- `docs/data-model.md`
- `AGENTS.md` receipt section

## Target Files

Likely create/modify:

```text
packages/receipts/src/documents/types.ts
packages/receipts/src/documents/hash.ts
packages/receipts/src/extraction/types.ts
packages/receipts/src/reconciliation/scoring.ts
packages/receipts/src/reconciliation/policies.ts
packages/receipts/src/reconciliation/matches.ts
packages/receipts/src/reconciliation/*.test.ts
packages/db/src/schema.ts
packages/db/src/migrations/0002_receipts.sql or equivalent
```

## Document Model

Minimum document fields:

```text
id
workspaceId
contentHash
mimeType
originalFilename
storageUri
sourceKind: upload | email | portal | paperless | api
sourceMetadataJson
createdAt
retentionState
```

Extraction fields:

```text
documentId
vendorName
documentDate
dueDate
totalAmount
taxAmount
currency
invoiceNumber
paymentReference
extractedText
confidence
extractorVersion
```

## Matching Inputs

Define normalized matching types so tests do not depend on DB implementation:

```ts
interface MatchableTransaction { ... }
interface MatchableDocument { ... }
```

Fields should include amount, currency, dates, vendor/counterparty text, references, and source reliability.

## Scoring Rules

Initial scoring dimensions:

- exact amount match,
- currency match,
- date proximity,
- vendor/counterparty similarity,
- invoice/reference match,
- previous rule/source confidence placeholder,
- one-to-one uniqueness.

Return explainable scores:

```ts
interface MatchScore {
  score: number;
  reasons: string[];
  blockers: string[];
}
```

## TDD Steps

### Task 1: Content hash deduplication

Write tests for hashing buffers/strings and duplicate detection helper.

### Task 2: Exact amount/date match

Write tests:

- exact amount/currency/date window produces high score,
- wrong currency blocks,
- large date distance lowers score.

### Task 3: Vendor fuzzy match

Write tests for simple normalized string similarity:

- `Amazon EU SARL` vs `AMAZON MARKETPLACE` should score positively,
- unrelated vendors should not.

Keep the first implementation simple and replaceable.

### Task 4: Review state decision

Write tests for policy outputs:

- score >= 0.97 and exact amount can auto-match,
- high-value amount forces review,
- real-estate improvement category forces review,
- low score becomes candidate review item.

### Task 5: Match candidate persistence interface

If DB is ready, persist `match_candidates` and `match_decisions`. If not, define repository interfaces and tests with in-memory fakes.

## Acceptance Criteria

- `pnpm check` passes.
- Matching is deterministic and explainable.
- Auto-apply policy is conservative and configurable.
- Documents are modeled as internally stored evidence.
- No external OCR/API dependency is required for tests.
- Commit uses Conventional Commits, e.g. `feat(receipts): add reconciliation scoring`.

## Follow-Up

- Add OCR/text extraction provider.
- Add upload/email ingestion.
- Add UI/MCP review queue.
- Add Paperless adapter only as an optional external source.
