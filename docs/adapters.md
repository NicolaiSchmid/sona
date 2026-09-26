# Adapters

Sona keeps third-party systems at the edges. Inbound adapters (sources) turn
external data into immutable raw source records and internally stored
documents; outbound adapters (exports) turn reviewed ledger data into
artifacts a human hands on. Nothing in between — the ledger, review states,
evidence graph — knows which adapter a record came from or where an export
goes.

This document describes how an adapter plugs in and which guarantees it must
give. It is not a public plugin SDK; adapters live in this repository and are
reviewed like any other financial code.

## Source adapters

A source adapter lives in `packages/connectors/src/<name>/` and follows the
pattern established by the email, Enable Banking, Portfolio Performance, and
Paperless connectors:

```text
<name>/
  types.ts        provider shapes + a read-only client interface
  client.ts       real implementation (fetch/IMAP/...), credentials from SecretStore
  fake-client.ts  deterministic fake for tests; records every request
  normalize.ts    pure helpers: policy, fingerprint, raw payload, redaction
  sync.ts         orchestration over injected stores
  fixtures.ts     synthetic data only
  index.ts        public surface, re-exported from packages/connectors/src/index.ts
```

Required guarantees:

- **Read-only.** The client interface exposes no operation that could mutate
  the upstream system. The fake exposes the upstream's mutating endpoints and
  throws (`*ReadOnlyViolationError`) so a code path reaching for them fails in
  tests. Real clients only issue idempotent reads.
- **Raw first.** Every imported item becomes a `RawSourceRecord` (verbatim or
  redacted provider metadata, content hash, provenance) before anything is
  normalized. Records are append-only; corrections use `supersedeRawSourceRecord`.
- **Documents through the storage boundary.** Originals go through
  `DocumentStorage` with content-hash dedup; the document row's
  `sourceMetadata` points back at the provider identity (message id, portal
  URL, Paperless id). Sona never keeps only an external link.
- **Idempotent by cursor and hash.** A sync resumes from a cursor persisted
  with the run that produced it (`*_sync_cursors` tables) and dedups on
  provider identity plus content hash, so re-running an unchanged source
  imports nothing. A policy change is fingerprinted into the cursor and forces
  a rescan.
- **Fail closed, no partial state.** A failure before the first write leaves a
  `failed` run and nothing else. Later failures pin the cursor on the first
  failed item and keep processing; the next run retries from the cursor.
- **Redaction.** Credentials come from `SecretStore` at request time and are
  never held on the client or placed in errors. Run summaries contain counts,
  redacted messages, and the cursor — no subjects, titles, filenames, or
  addresses.
- **Allowlists.** Anything that dials out (hosts, senders, tags) is
  allowlisted per source with conservative defaults.
- **Workspace binding.** The client carries the workspace whose credentials it
  uses; the sync refuses a mismatch, and repositories are wrapped with
  `createWorkspace*Store` so a connector cannot address another tenant.

Registering a new source kind means adding it to `SourceKind` in
`packages/core/src/source/types.ts`, adding a store implementation under
`packages/db/src/repositories/`, and a migration for its cursor table. Workers
compose the adapter with repositories; adapters themselves never open a
database.

### Paperless-ngx

`packages/connectors/src/paperless/` imports documents from an existing
Paperless-ngx archive as an ingestion source (`sourceKind: "paperless"`).

- Base URL must be HTTPS (HTTP only for loopback) and its host must be on the
  source's `allowedHosts`; the API token is a `SecretRef`.
- Only `GET /api/documents/`, `/api/tags/`, `/api/correspondents/`,
  `/api/document_types/`, and `/api/documents/<id>/download/?original=true`
  are used. The OCR `content` field is never requested.
- Policy: required tag names (any-of), allowed MIME types, byte cap, optional
  initial `modified` bound. Bytes must carry the declared type's signature.
- Cursor: `(modified, id)` of the last fully imported document. Re-syncs skip
  documents whose metadata and stored hash are unchanged without downloading;
  retagged/renamed documents get a superseding raw record and their bytes are
  deduplicated by hash.
- Raw payload: Paperless id, title, dates, resolved tag/correspondent/type
  names, ASN, original filename, instance host, and the stored document's
  hash/size/type. Document row `sourceMetadata` carries the same provenance.

Paperless is import-only. Sona does not write tags, notes, or documents back.

## Export adapters

Export adapters live in `packages/tax-de/src/` and consume the reviewed export
model (`TaxExportLine`, depreciation rows, investment evidence) — never raw
postings. They are pure functions over that model plus configuration data, so
their output is deterministic and testable without a database.

Required guarantees:

- **Review gate.** Artifacts meant to leave the workspace apply the `final`
  gate: `user_reviewed` or stronger. Excluded items are listed with a reason,
  never silently dropped.
- **Traceability.** Every number names the export line / posting /
  transaction it came from and the documents that substantiate it.
- **Configuration, not law.** Mappings (templates, ELSTER draft groupings)
  are versioned data the user can change. Wording is "prepared", "suggested",
  "review required". No adapter asserts deductibility, and no adapter
  transmits anything anywhere.
- **Determinism.** Identical inputs (including a caller-supplied timestamp)
  produce identical bytes, so an artifact's hash identifies it.

### ELSTER-oriented draft

`packages/tax-de/src/elster-draft/` maps export sections to Anlage-level line
groupings (`ElsterDraftMapping`, default `ELSTER_DRAFT_MAPPING_PRIVATE_DE`) and
renders `elster-draft.md` / `elster-draft.json`. Sections no group claims land
in an "Unmapped — review required" block. Both renderings open with the banner
"PREPARED VALUES FOR REVIEW — NOT A SUBMISSION — NOT TAX ADVICE". There is no
ERiC integration and no code path that could submit.

### Accountant package

`packages/tax-de/src/accountant/` builds a share-ready ZIP: the final export
package, the ELSTER draft, originals of every document an included line
references (`documents/<documentId>.<ext>`), `documents.csv`, a
`MANIFEST.sha256`, and a `README.md` for the Steuerberater. The ZIP writer is
pure Node (`node:zlib` + local CRC-32) with a fixed timestamp.

Hosted mode may hand the ZIP out through an expiring, revocable, read-only
share link (`AccountantShareLink`, `SqliteAccountantShareLinkRepository`):
token hashed at rest, expiry capped at 30 days, download cap, and an audit
event for creation, each download, each denial, and revocation. Serving the
bytes over HTTP is not part of this layer.

## Adding an adapter: checklist

1. Read `AGENTS.md`, this file, and the connector or export you are closest to.
2. Write the fake and fixtures first; every test runs without network or database.
3. Cover: allowlist, read-only guard, idempotent re-sync, hash dedup, failed-run
   cleanliness, redaction, workspace isolation (sources); review gate,
   traceability, deterministic output, forbidden wording (exports).
4. Add the migration with the next free number and extend `CORE_MIGRATIONS`.
5. Document the adapter here and in the relevant `docs/*.md`.
