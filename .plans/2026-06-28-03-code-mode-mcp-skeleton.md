# Code-Mode MCP Skeleton Plan

## Purpose

Build the first Sona MCP/code-mode shell so agents can operate Sona through a typed `sona.*` facade instead of one-off tools.

This should mirror the Subzero/Drio code-mode approach: small public tool surface, typed backend catalog, no raw internal function paths exposed.

## Goals

- Create `packages/mcp` server skeleton.
- Expose public MCP tools: `docs`, `search`, `execute`.
- Define a typed `sona.*` facade with stubbed function families.
- Make `search` inspect the catalog.
- Make `execute` run constrained TypeScript/JavaScript snippets against the facade in a controlled environment.
- Add tests for catalog search and basic execution.

## Non-Goals

- Production auth.
- Remote deployment.
- Real database mutations.
- Real source sync.
- Browser automation execution.

## Required Reading

- `README.md`
- `docs/architecture.md`
- `AGENTS.md` MCP section

## Target Files

Likely create/modify:

```text
packages/mcp/src/catalog.ts
packages/mcp/src/facade.ts
packages/mcp/src/tools/docs.ts
packages/mcp/src/tools/search.ts
packages/mcp/src/tools/execute.ts
packages/mcp/src/server.ts
packages/mcp/src/index.ts
packages/mcp/src/catalog.test.ts
packages/mcp/src/execute.test.ts
packages/mcp/package.json
```

## Facade Shape

Start with stub functions that return deterministic placeholder data and document intended args.

Families:

```ts
sona.sources.*
sona.receipts.*
sona.reconciliation.*
sona.ledger.*
sona.tax.*
sona.assets.*
sona.agents.*
```

Example catalog entry:

```ts
{
  path: "sona.receipts.ingestUpload",
  description: "Register an uploaded receipt or invoice for extraction and matching.",
  inputSchema: z.object({ fileId: z.string() }),
  risk: "write_draft",
}
```

## Risk Labels

Add risk labels now even if auth is not implemented:

```text
read_only
write_draft
review_required
external_read
external_browser
forbidden_without_policy
```

This will help future agents avoid unsafe surfaces.

## TDD Steps

### Task 1: Catalog search

Write tests first:

- searching `receipt` returns receipt functions,
- searching `tax export` returns tax export functions,
- unknown search returns empty plus available families,
- catalog entries have path, description, schema, and risk.

Then implement catalog and search.

### Task 2: Docs tool

Write tests for docs output containing:

- product boundary,
- available families,
- safety rule: no automatic ELSTER submission,
- safety rule: no payment initiation.

Then implement docs tool.

### Task 3: Execute sandbox

Write tests for:

- executing `return await sona.sources.list()` returns placeholder source list,
- accessing unavailable global APIs is blocked or omitted,
- thrown errors are normalized,
- input code must use `sona.*` not raw internals.

Implement the smallest safe execution harness. If full sandboxing is too much for this phase, mark it as local/dev-only and document limitations loudly.

## Security Constraints

- Do not allow access to process env from executed code.
- Do not expose database handles.
- Do not expose filesystem by default.
- Do not include secrets in errors.
- Do not implement mutating real behavior in stubs.

## Acceptance Criteria

- `pnpm check` passes.
- MCP package has a clear catalog and tests.
- `docs`, `search`, and `execute` exist at package level.
- The typed facade is easy for later agents to extend.
- README or package docs show a minimal example.
- Commit uses Conventional Commits, e.g. `feat(mcp): add code-mode tool skeleton`.

## Follow-Up Plans

- Connect facade functions to real DB repositories after core schema lands.
- Add auth/tenant checks before any hosted deployment.
- Add risk-based approval gates before external browser or tax export operations.
