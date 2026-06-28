# German Private Tax Export Plan

## Purpose

Implement the first tax export model for Sona: configurable German private-tax-oriented templates, missing-evidence reports, and export package generation.

This is preparation/backoffice automation, not tax advice and not ELSTER submission.

## Goals

- Add tax category/template model.
- Map ledger accounts to export sections through configurable templates.
- Generate draft export lines from reviewed ledger postings.
- Generate missing evidence report.
- Generate a local export package manifest.
- Add tests for traceability and review gates.

## Non-Goals

- ELSTER/ERiC submission.
- Legal/tax advice claims.
- Full German tax law coverage.
- PDF generation if Markdown/CSV/JSON is sufficient for v0.

## Required Reading

- `docs/tax-exports.md`
- `docs/product-spec.md`
- `docs/security-compliance.md`
- `AGENTS.md` tax boundaries

## Target Files

Likely create/modify:

```text
packages/tax-de/src/templates/private-de.ts
packages/tax-de/src/templates/rental-property.ts
packages/tax-de/src/export/types.ts
packages/tax-de/src/export/generate.ts
packages/tax-de/src/export/missing-evidence.ts
packages/tax-de/src/export/package.ts
packages/tax-de/src/export/*.test.ts
packages/tax-de/fixtures/*.json
```

## Template Shape

Start with a plain TypeScript template object:

```ts
export interface TaxTemplate {
  jurisdiction: "DE";
  audience: "private_individual";
  sections: TaxSection[];
}
```

Sections should include initial private-tax-relevant categories:

- rental property / Anlage V preparation,
- tax advice,
- donations,
- insurance,
- work-related expenses,
- household services,
- medical expenses,
- investment-related fees,
- depreciation schedules.

Use neutral wording: `suggested`, `configured`, `reviewRequired`.

## Export Line Requirements

Each generated export line should include:

- date,
- description,
- amount,
- currency,
- ledger account,
- template section/category,
- source posting IDs,
- evidence document IDs,
- review state,
- notes.

## TDD Steps

### Task 1: Template validation

Write tests first:

- template has jurisdiction `DE`,
- audience is `private_individual`,
- no section claims legal deductibility,
- sections have stable IDs.

### Task 2: Ledger-to-tax mapping

Using synthetic ledger postings, test:

- `Expenses:RealEstate:Maintenance` maps to rental property maintenance section,
- `Expenses:TaxAdvice` maps to tax advice section,
- unrecognized account maps to review/uncategorized section.

### Task 3: Review gate

Test final export excludes or flags non-reviewed lines depending on mode:

- draft export can include `suggested`,
- final export requires `user_reviewed` or stronger.

### Task 4: Missing evidence report

Test:

- tax-relevant posting without receipt appears in missing-evidence report,
- posting with substantiating document is omitted,
- account with `receiptRequired: false` is omitted.

### Task 5: Package manifest

Generate a manifest object with expected files:

```text
summary.md
tax-categories.csv
missing-evidence.csv
evidence-links.json
receipt-manifest.csv
```

Actual ZIP/PDF generation can wait if needed.

## Acceptance Criteria

- `pnpm check` passes.
- Tax templates are configurable data, not hidden code claims.
- Export lines are traceable to ledger postings and evidence links.
- Missing-evidence report works on synthetic fixtures.
- No ELSTER submission code is introduced.
- Commit uses Conventional Commits, e.g. `feat(tax-de): add private tax export model`.

## Follow-Up

- Add asset/depreciation export schedules.
- Add Markdown/HTML rendering.
- Add receipt bundle/ZIP generation.
- Add ELSTER/ERiC draft adapter only after core exports are solid.
