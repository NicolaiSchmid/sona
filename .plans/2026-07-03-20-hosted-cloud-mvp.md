# Hosted Cloud MVP Plan

## Purpose

Implement the `hosted_cloud` runtime mode for trusted early users: Postgres, object storage, KMS-backed secrets, hosted workers, audit log completeness, and GDPR workflows (data export and deletion). Self-hosted mode must remain a first-class equal.

## Goals

- Postgres implementation of the `DbClient` abstraction; run the entire repository test suite against both SQLite and Postgres in CI.
- S3-compatible `DocumentStorage` with server-side encryption and hash verification.
- KMS/envelope-encryption `SecretStore` (per-workspace data keys).
- Hosted worker deployment: queue claim semantics safe across multiple worker instances.
- Workspace data export: complete, machine-readable dump (documents + records + audit trail).
- Workspace deletion: verified hard delete of documents, records, and secrets with a deletion receipt; grace period configurable.
- Subprocessor inventory and DPIA checklist in `docs/`.
- Backups with tested restore.

## Non-Goals

- Billing/subscription management.
- Multi-region, autoscaling, or infrastructure-as-code polish.
- SOC2-style formal certification work (checklist groundwork only).

## Required Reading

- `docs/security-compliance.md`
- `.plans/2026-06-28-08-cloud-self-hosting-boundary.md`
- `AGENTS.md` hosted cloud requirements

## Target Files

Likely create/modify:

```text
packages/db/src/postgres.ts
packages/core/src/runtime/storage-s3.ts
packages/core/src/runtime/secrets-kms.ts
packages/core/src/gdpr/export.ts
packages/core/src/gdpr/deletion.ts
packages/core/src/gdpr/*.test.ts
apps/worker/src/index.ts (multi-instance claims)
docs/cloud-self-hosting.md
docs/dpia-checklist.md
docs/subprocessors.md
.github/workflows/ci.yml (Postgres service matrix)
```

## Design Constraints

- No cloud vendor names in core packages; S3/KMS implementations live behind the phase-08 interfaces and are selected by runtime config.
- Migrations must be engine-portable or split per engine explicitly — no runtime SQL dialect branching inside repositories.
- Data export includes: raw records, normalized records, ledger, postings, documents (original bytes), review events, audit log, config — enough to re-import into self-hosted (product promise: no lock-in).
- Deletion covers derived data, object storage, secrets, and queued jobs; a post-deletion scan asserts zero rows/objects remain for the workspace. Backup expiry policy is documented honestly (deleted data ages out of backups within the stated window).
- Audit log review: every mutating service path writes an audit row (add a test that walks the service surface).
- Worker claims use `FOR UPDATE SKIP LOCKED` (Postgres) with the SQLite path preserved.

## TDD Steps

### Task 1: Postgres parity

Repository/behavior suites from phases 09/11 run green against Postgres in CI (service container).

### Task 2: Storage and secrets

- S3 storage passes the phase-10 behavioral suite against MinIO/localstack in CI,
- KMS secret store envelope roundtrip; workspace A's data key never decrypts workspace B's ciphertext.

### Task 3: GDPR workflows

- export contains every record family (walk the schema and assert coverage so new tables can't be silently omitted),
- deletion leaves zero workspace rows/objects/secrets; deletion receipt lists counts,
- export/deletion are jobs: resumable and audited.

### Task 4: Multi-worker safety

- two worker instances against one Postgres queue never double-claim (contention test).

## Acceptance Criteria

- `pnpm check` passes, with the CI matrix covering SQLite + Postgres and MinIO.
- Fresh restore from backup verified in CI or a documented runbook script.
- DPIA checklist and subprocessor docs exist.
- Commit uses Conventional Commits, e.g. `feat(core): add hosted cloud storage, gdpr export/deletion, and postgres parity`.

## Follow-Up

- Billing.
- Status page/alerting.
- Formal DPIA completion before non-trusted-user launch.
