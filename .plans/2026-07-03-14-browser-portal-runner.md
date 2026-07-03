# Browser Portal Runner Plan

## Purpose

Implement a real `PortalTaskRunner` (Browserbase/Playwright) behind the phase-06 task schema, policy, and provenance model, plus one real read-only portal adapter. The fake runner remains the test default.

## Goals

- Implement a Playwright-based runner that executes versioned portal task definitions.
- Support managed Browserbase execution and plain local Playwright behind one interface.
- Enforce the read-only policy at the browser layer, not just task definitions.
- Inject portal credentials from the secret store; redact them from all logs, traces, and artifacts.
- Store fetched documents through `DocumentStorage` with full run provenance.
- Ship one real portal task definition (a common German invoice portal) as the reference adapter.

## Non-Goals

- Autonomous free-form browsing; only versioned task definitions run.
- Solving CAPTCHAs or bypassing bot detection — if a portal blocks automation, surface `blocked` status and stop.
- 2FA automation beyond pausing for user-provided codes.
- Any portal state mutation, ever.

## Required Reading

- `docs/agent-receipt-fetching.md`
- `packages/agents/src/portal-tasks/policy.ts`, `runner.ts`, `provenance.ts`
- `AGENTS.md` browser/agent rules

## Target Files

Likely create/modify:

```text
packages/agents/src/portal-tasks/playwright-runner.ts
packages/agents/src/portal-tasks/browserbase.ts
packages/agents/src/portal-tasks/network-guard.ts
packages/agents/src/portal-tasks/definitions/*.ts
packages/agents/src/portal-tasks/*.test.ts
apps/worker/src/jobs/portal-fetch.ts
```

## Read-Only Enforcement Layers

Defense in depth, all tested:

1. Task definitions are validated against the phase-06 policy before any browser launches.
2. Domain allowlist enforced via request interception: navigation or subresource requests outside the allowlist are aborted.
3. Non-idempotent HTTP methods (POST/PUT/PATCH/DELETE) are blocked by default; a task may allowlist specific POST endpoints only for login and search/filter forms, each with a recorded justification string.
4. Selectors matching known-destructive intents (buy, cancel, delete, change payment) are refused at definition validation time.

## TDD Steps

### Task 1: Network guard

Write tests first (Playwright against a local fixture server):

- off-allowlist navigation is aborted and recorded in provenance,
- POST to a non-justified endpoint is blocked,
- justified login POST passes.

### Task 2: Credential redaction

- credentials injected into the page never appear in run logs, provenance JSON, console captures, or stored artifacts (scan all outputs for the secret marker),
- screenshots are disabled on pages flagged `sensitive` in the task definition.

### Task 3: Runner behavior

- fixture portal: login → list invoices → download PDFs → documents stored with hash + run provenance,
- re-run downloads nothing new (dedup by content hash),
- portal layout change (missing selector) fails the step with status `selector_missing`, no retry loop hammering the portal,
- runner re-checks policy at execution (matching the fake runner's defense-in-depth).

### Task 4: Worker integration

- `portal_fetch` job runs a task by connection ID, is idempotent, and respects a per-portal cooldown.

## Acceptance Criteria

- `pnpm check` passes (Playwright tests may be a separate CI job, but must run in CI).
- Every enforcement layer has a test proving the block.
- The fake runner and Playwright runner pass a shared behavioral test suite.
- Commit uses Conventional Commits, e.g. `feat(agents): add playwright portal runner with read-only network guard`.

## Follow-Up

- Additional portal definitions (telecom, utilities, marketplaces).
- User-supplied browser/agent subscription mode.
- Session/cookie reuse to reduce login frequency.
