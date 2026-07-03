# Receipt Extraction Pipeline Plan

## Purpose

Implement real field extraction for stored receipts/invoices behind an adapter interface: vendor, date, total, currency, invoice number, and line-item hints, with confidence scores that feed the conservative matching policy.

## Goals

- Define an `ExtractionProvider` interface in `@sona/receipts` (the types in `packages/receipts/src/extraction/types.ts` are the output contract).
- Implement PDF text-layer extraction as the first real provider (no OCR dependency for digital PDFs).
- Implement an LLM-assisted structuring provider behind config, off by default.
- Keep a deterministic fake provider for tests.
- Record extraction provenance: provider, version, model (if any), confidence per field.
- Route low-confidence extractions to the review queue instead of matching.

## Non-Goals

- Image OCR (Tesseract or hosted OCR) — follow-up once PDF path is solid.
- Training or fine-tuning anything.
- Sending documents to any external service without an explicit config opt-in.

## Required Reading

- `docs/receipt-reconciliation.md`
- `packages/receipts/src/extraction/types.ts`
- `packages/receipts/src/reconciliation/policies.ts` confidence thresholds
- `AGENTS.md` AI-suggests-humans-approve rule

## Target Files

Likely create/modify:

```text
packages/receipts/src/extraction/provider.ts
packages/receipts/src/extraction/pdf-text.ts
packages/receipts/src/extraction/llm.ts
packages/receipts/src/extraction/fake.ts
packages/receipts/src/extraction/*.test.ts
packages/receipts/fixtures/pdfs/*.pdf (synthetic only)
```

## Design Constraints

- Providers receive document bytes + metadata and return the typed extraction result; they never touch storage or the database directly.
- Every extracted field carries `confidence: number` in `[0, 1]` and `evidence` (source text snippet/position) so review UI can show why.
- The LLM provider must be explicitly enabled in config (`extraction.llm.enabled: true` plus provider credentials via the secret store); default config keeps documents local.
- Fixture PDFs are generated synthetic invoices — never real receipts.
- Amounts parse into the `@sona/core` money type; no floats.

## TDD Steps

### Task 1: Provider contract

Write tests first:

- fake provider satisfies the interface and returns stable results,
- results validate against the extraction result schema (Zod/Valibot at the boundary).

### Task 2: PDF text extraction

- synthetic German invoice fixture yields vendor, ISO date, gross amount, currency, invoice number,
- ambiguous amounts (multiple totals) lower confidence instead of guessing,
- scanned-image PDF (no text layer) returns `status: needs_ocr`, not an empty success.

### Task 3: Confidence gating

- extraction below the policy threshold creates a review item and is excluded from auto-match,
- high-confidence extraction flows into match candidate scoring.

### Task 4: LLM provider (config-gated)

- disabled by default: constructing it without explicit opt-in throws,
- request payload contains document text, not raw file bytes, unless configured,
- responses are validated against the same schema; invalid output degrades to `needs_review`, never a crash or fabricated fields.

## Acceptance Criteria

- `pnpm check` passes.
- No network call happens in default config (tested with a throwing fetch stub).
- Every extraction result is traceable to provider + version.
- Commit uses Conventional Commits, e.g. `feat(receipts): add pdf and llm extraction providers`.

## Follow-Up

- OCR provider for photos/scans.
- Line-item level extraction for split postings.
- Feedback loop: corrected fields recorded as review events to evaluate provider quality.
