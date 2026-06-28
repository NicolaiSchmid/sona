# Tax Exports

Tax exports are the primary product outcome.

## Goal

Generate reviewable, source-linked tax preparation packages for private individuals.

## Export package

A tax-year export should contain:

```text
tax-export-2026/
  summary.md
  summary.html
  ledger-postings.csv
  tax-categories.csv
  depreciation-schedules.csv
  missing-evidence.csv
  receipt-manifest.csv
  evidence-links.json
  documents/
    ...original PDFs/images...
```

## Export line requirements

Each export line should include:

- date,
- description,
- amount,
- currency,
- ledger account,
- tax category/template field,
- source transaction IDs,
- receipt/document IDs,
- review status,
- reviewer,
- notes,
- confidence/suggestion provenance.

## Review states

```text
draft
suggested
user_reviewed
advisor_reviewed
exported
superseded
```

Tax-relevant exports should default to requiring `user_reviewed` for final packages.

## German private tax templates

Initial templates should focus on private individuals:

- rental property / Anlage V preparation,
- capital income / investment-related support,
- work-related expenses,
- tax advice expenses,
- donations,
- insurance,
- household services,
- medical expenses,
- education/training.

Avoid making legal claims in the product copy. Templates map user-reviewed ledger categories to export sections.

## Depreciation

Depreciation schedules should be configurable and evidence-linked.

For real estate, support:

- property asset,
- land/building split,
- acquisition costs,
- acquisition date,
- improvements,
- maintenance vs capitalized improvements,
- schedule entries,
- annual postings,
- linked receipts/contracts.

Sona should compute schedules from configured assumptions, not infer tax law silently.

## ELSTER/ERiC future adapter

ELSTER integration should be an adapter behind the export layer.

Phases:

1. Generate human-readable and CSV export packages.
2. Generate structured draft payloads mapped to form fields.
3. Validate form payloads with ERiC where possible.
4. Consider human-controlled submission only after legal/security review.

Default product behavior: no automatic ELSTER submission.

## MCP examples

```ts
await sona.tax.listTemplates({ jurisdiction: "DE" });
await sona.tax.previewExport({ year: 2026 });
await sona.tax.listMissingEvidence({ year: 2026 });
await sona.tax.generatePackage({ year: 2026, includeDocuments: true });
```
