# Agent and Browser Receipt Fetching Plan

## Purpose

Design and implement the first safe browser automation framework for fetching receipts/invoices from portals.

This is not a portal-adapter free-for-all. The goal is a secure, versioned, read-only task model that can later run through Browserbase, Playwright, or user-provided agent/browser subscriptions.

## Goals

- Define portal task schema.
- Define read-only action policy and forbidden actions.
- Define execution adapter interface.
- Implement a fake/in-memory runner for tests.
- Add one example task fixture without real credentials.
- Store output provenance for fetched documents.

## Non-Goals

- Real Browserbase integration in the first pass unless trivial.
- Real portal credentials.
- Amazon or bank scraping in production.
- Bypassing MFA/passkeys.
- Mutating portal state.

## Required Reading

- `docs/agent-receipt-fetching.md`
- `docs/security-compliance.md`
- `AGENTS.md` browser automation section

## Target Files

Likely create/modify:

```text
packages/agents/src/portal-tasks/schema.ts
packages/agents/src/portal-tasks/policy.ts
packages/agents/src/portal-tasks/runner.ts
packages/agents/src/portal-tasks/provenance.ts
packages/agents/src/portal-tasks/fixtures/amazon-de-invoices.example.yaml
packages/agents/src/portal-tasks/*.test.ts
packages/agents/package.json
packages/receipts/src/documents/provenance.ts
```

Create `packages/agents` if it does not exist yet.

## Portal Task Schema

A task should include:

```yaml
id: amazon-de-invoices
name: Amazon Germany invoice fetcher
version: 1
risk: read_only_document_fetch
domains:
  - amazon.de
requires:
  - authenticated_session_or_credentials
allowedActions:
  - navigate
  - click
  - search_orders
  - download_invoice_pdf
forbiddenActions:
  - purchase
  - cancel_order
  - change_payment_method
  - change_address
outputs:
  - document_file
  - provenance_json
```

## Action Policy

Create runtime validation that rejects task definitions containing forbidden actions or missing domain allowlists.

Default forbidden concepts:

```text
purchase
buy
order
cancel
refund_request
change_payment_method
change_address
change_password
transfer
submit_tax
send_message
```

This does not replace execution-time safeguards, but it catches unsafe task definitions early.

## Runner Interface

Define an interface like:

```ts
interface PortalTaskRunner {
  runTask(input: RunPortalTaskInput): Promise<RunPortalTaskResult>;
}
```

Result includes:

- run ID,
- task ID/version,
- fetched documents,
- provenance JSON,
- warnings,
- errors.

## TDD Steps

### Task 1: Schema validation

Write tests first:

- valid fixture passes,
- task without domain allowlist fails,
- task with forbidden action fails,
- task with unknown output type fails.

### Task 2: Policy validation

Write tests for read-only policy:

- allowed actions pass,
- `purchase`/`change_payment_method` fail,
- suspicious action names fail case-insensitively.

### Task 3: Fake runner

Write tests for fake runner returning a fetched PDF placeholder with provenance.

No real browser execution yet.

### Task 4: Provenance conversion

Write tests that fetched document provenance can be converted into receipt/document metadata for `packages/receipts`.

## Browserbase/Codex Notes

Document extension points:

- `BrowserbasePortalTaskRunner`,
- `LocalPlaywrightPortalTaskRunner`,
- `UserDelegatedAgentTaskRunner` for future user-provided Codex/browser subscription mode.

Do not hardcode a single vendor into the domain model.

## Acceptance Criteria

- `pnpm check` passes.
- Portal task schema and policy tests pass.
- No real portal credentials or screenshots are committed.
- The architecture leaves room for Browserbase and user-delegated execution.
- Commit uses Conventional Commits, e.g. `feat(agents): add portal task model`.

## Follow-Up

- Implement Browserbase runner.
- Implement interactive login handoff.
- Add one real adapter behind feature flag.
- Add run history and redacted logs.
