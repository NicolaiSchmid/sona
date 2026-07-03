# Document Storage and Secret Store Plan

## Purpose

Implement the first real backends for the phase-08 storage abstractions: filesystem document storage for receipt/invoice originals and an encrypted local secret store for connector and portal credentials.

## Goals

- Implement `DocumentStorage` on the local filesystem with content-addressed layout.
- Implement `SecretStore` with authenticated encryption at rest.
- Verify stored bytes against the document `contentHash` on read.
- Guarantee secrets never appear in logs, errors, or list operations.
- Wire both into runtime config (`self_hosted` / `local_dev` defaults from phase 08).

## Non-Goals

- S3/object storage and KMS (phase 20).
- Document retention/deletion policy workflows (phase 20 covers deletion).
- Key rotation UI; a manual `rotateSecret` path is enough.

## Required Reading

- `docs/security-compliance.md`
- `.plans/2026-06-28-08-cloud-self-hosting-boundary.md` storage interfaces
- `AGENTS.md` receipt handling and secrets rules

## Target Files

Likely create/modify:

```text
packages/core/src/runtime/storage-fs.ts
packages/core/src/runtime/secrets-local.ts
packages/core/src/runtime/*.test.ts
config/sona.example.yaml
docs/security-compliance.md (key handling section)
```

## Design Constraints

- Filesystem layout: `<root>/<workspaceId>/<hashPrefix>/<contentHash>` — content-addressed, so identical bytes are stored once per workspace and the path itself never leaks vendor or filename metadata.
- Writes are atomic: write to a temp file, fsync, rename.
- Secret store uses AES-256-GCM with a key from `SONA_SECRET_KEY` (or a key file); ciphertext includes a version byte for future rotation.
- `getSecret` returns a value object whose `toString()`/`toJSON()`/`inspect` are redacted; only an explicit `.reveal()` returns plaintext.
- Neither implementation may read `workspaceId` from anywhere except the explicit call input.

## TDD Steps

### Task 1: Filesystem document storage

Write tests first:

- put/get roundtrip preserves bytes and mime metadata,
- get verifies content hash and fails on tampered bytes,
- duplicate put of identical content is idempotent,
- delete removes bytes; get afterwards fails cleanly,
- paths for workspace A never resolve under workspace B.

### Task 2: Encrypted secret store

- put/get roundtrip,
- ciphertext at rest contains no plaintext substrings of the secret,
- list returns refs and labels only, never values,
- wrong key fails authentication (no silent garbage),
- rotate re-encrypts and old ref is superseded,
- accidental `JSON.stringify(secretValue)` yields a redaction marker.

### Task 3: Runtime wiring

- `self_hosted` config resolves filesystem storage and local secret store with paths from config,
- missing `SONA_SECRET_KEY` in a mode that needs it fails at startup with a clear error.

## Acceptance Criteria

- `pnpm check` passes.
- No secret material or document contents appear in logs or error messages (tested).
- Example config updated without secrets.
- Commit uses Conventional Commits, e.g. `feat(core): add filesystem document storage and encrypted secret store`.

## Follow-Up

- S3-compatible storage and KMS secret store for hosted cloud (phase 20).
- Retention states and legal-hold flags on stored documents.
