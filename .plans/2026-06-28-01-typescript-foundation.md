# TypeScript Foundation Plan

## Purpose

Create the initial TypeScript monorepo foundation for Sona so multiple T3 agents can implement features independently without bikeshedding structure.

This plan should establish tooling only. Do not implement banking, receipts, MCP, or tax logic here beyond placeholder package boundaries.

## Goals

- Strict TypeScript workspace.
- Package layout matching `README.md` and `docs/architecture.md`.
- Test runner, linting, formatting, and CI-ready scripts.
- Conventional project hygiene for future T3 agents.
- No secrets, no real financial data, no local database files committed.

## Non-Goals

- Production database schema.
- Real connectors.
- Browser automation.
- Web app UI.
- Authentication.

## Proposed Stack

- `pnpm` workspace.
- TypeScript strict mode.
- Vitest.
- ESLint + Prettier or Biome. Prefer Biome if the agent wants fewer moving parts.
- `tsx` for scripts.
- `zod` for boundary schemas.

## Target Files

Create:

```text
package.json
pnpm-workspace.yaml
tsconfig.base.json
biome.json or eslint/prettier config
vitest.config.ts
packages/core/package.json
packages/core/src/index.ts
packages/core/src/index.test.ts
packages/db/package.json
packages/db/src/index.ts
packages/connectors/package.json
packages/connectors/src/index.ts
packages/receipts/package.json
packages/receipts/src/index.ts
packages/tax-de/package.json
packages/tax-de/src/index.ts
packages/mcp/package.json
packages/mcp/src/index.ts
apps/worker/package.json
apps/worker/src/index.ts
apps/web/package.json
apps/web/src/index.ts
```

Modify:

```text
README.md
AGENTS.md if new commands need to be documented
```

## Implementation Steps

### Step 1: Initialize workspace metadata

Add root `package.json` with scripts:

```json
{
  "name": "sona",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.15.0",
  "scripts": {
    "build": "pnpm -r build",
    "check": "pnpm typecheck && pnpm lint && pnpm test",
    "typecheck": "tsc -b --pretty false",
    "lint": "biome check .",
    "format": "biome format --write .",
    "test": "vitest run"
  },
  "devDependencies": {
    "@biomejs/biome": "latest",
    "@types/node": "latest",
    "tsx": "latest",
    "typescript": "latest",
    "vitest": "latest",
    "zod": "latest"
  }
}
```

Use equivalent pinned versions if preferred after `pnpm add` resolves them.

### Step 2: Add workspace config

`pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`tsconfig.base.json` should enable strict mode, ESM, `noUncheckedIndexedAccess`, and declaration output for packages.

### Step 3: Add package skeletons

Each package should have:

```json
{
  "name": "@sona/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

Adjust names per package.

### Step 4: Add one real test

In `packages/core/src/index.test.ts`, test a placeholder exported constant or function. This verifies test discovery.

Example:

```ts
import { describe, expect, it } from "vitest";
import { sonaCoreVersion } from "./index";

describe("sona core", () => {
  it("exports a package marker", () => {
    expect(sonaCoreVersion).toBe("0.0.0");
  });
});
```

### Step 5: Install and verify

Run:

```bash
pnpm install
pnpm check
```

Expected: all scripts pass.

### Step 6: Update docs

Add a short `Development` section to `README.md` with:

```bash
pnpm install
pnpm check
```

## Acceptance Criteria

- `pnpm install` succeeds.
- `pnpm check` succeeds.
- `git status` contains no generated build output, DB files, env files, or secrets.
- Workspace package names are stable enough for follow-up agents.
- Commit uses Conventional Commits, e.g. `chore: initialize typescript workspace`.

## Risks

- Avoid overbuilding framework choices before features exist.
- Keep apps minimal. This is foundation, not product UI.
