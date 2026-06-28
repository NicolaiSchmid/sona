# Cloud MVP and Self-Hosting Boundary Plan

## Purpose

Define the first implementation boundary that lets Sona be cloud-usable for trusted early users while preserving a clean self-hosting path.

This is a design/implementation plan for tenancy, configuration, storage abstractions, and deployment boundaries. It should not implement every cloud feature.

## Goals

- Establish runtime configuration boundaries.
- Separate hosted tenancy from core domain logic.
- Define storage abstractions for DB, documents, and secrets.
- Add example local/self-host config without secrets.
- Add cloud MVP checklist for future implementation.

## Non-Goals

- Billing.
- Full auth implementation.
- Production infrastructure provisioning.
- Legal document generation.
- Multi-region architecture.

## Required Reading

- `docs/architecture.md`
- `docs/security-compliance.md`
- `docs/product-spec.md`
- `AGENTS.md`

## Target Files

Likely create/modify:

```text
packages/core/src/runtime/config.ts
packages/core/src/runtime/storage.ts
packages/core/src/runtime/tenancy.ts
packages/core/src/runtime/*.test.ts
config/sona.example.yaml
.env.example
docs/cloud-self-hosting.md
README.md
```

## Runtime Modes

Define explicit modes:

```text
local_dev
self_hosted
hosted_cloud
```

Each mode controls defaults for:

- database URL/path,
- document storage backend,
- secret storage backend,
- worker execution,
- browser automation provider,
- admin access policy.

## Storage Abstractions

Define interfaces, not implementations everywhere:

```ts
interface DocumentStorage {
  put(input): Promise<StoredDocument>;
  get(input): Promise<DocumentStream>;
  delete(input): Promise<void>;
}

interface SecretStore {
  putSecret(input): Promise<SecretRef>;
  getSecret(ref): Promise<SecretValue>;
  rotateSecret(input): Promise<SecretRef>;
}
```

Hosted implementation can later use object storage and KMS. Self-hosted can use local filesystem and env/file secrets.

## Tenancy Boundary

Core domain functions should accept an explicit `workspaceId` or context. Avoid hidden globals.

Test that repository/facade functions require workspace context even if implementation is stubbed.

## Example Config

Create `config/sona.example.yaml`:

```yaml
runtime: self_hosted
locale: de-DE
currency: EUR
storage:
  documents:
    provider: filesystem
    path: ./data/documents
  database:
    provider: sqlite
    path: ./data/sona.sqlite
policies:
  aiCan:
    suggestClassifications: true
    submitTaxReturns: false
    initiatePayments: false
  receipts:
    requireFor:
      - Expenses:RealEstate:*
      - Expenses:TaxAdvice
```

## TDD Steps

### Task 1: Config parser

Write tests first for:

- valid self-hosted config parses,
- `submitTaxReturns: true` fails unless an explicit future feature flag exists,
- `initiatePayments: true` fails by default,
- hosted mode requires stronger storage/secrets settings.

### Task 2: Workspace context

Write tests that core service constructors reject missing workspace context.

### Task 3: Storage interface fakes

Implement in-memory fakes for document storage and secret store for tests. Ensure secret values are not returned by list operations.

## Acceptance Criteria

- `pnpm check` passes.
- Example config exists and contains no secrets.
- Runtime modes are explicit.
- Hosted vs self-hosted differences are documented.
- No production cloud vendor is hardcoded into core.
- Commit uses Conventional Commits, e.g. `feat(core): add runtime configuration boundary`.

## Follow-Up

- Add real local filesystem document storage.
- Add Postgres/S3/KMS implementations for hosted cloud.
- Add auth and user/workspace membership.
- Add data export/deletion workflows.
