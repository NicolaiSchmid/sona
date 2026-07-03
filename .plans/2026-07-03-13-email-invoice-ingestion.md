# Email Invoice Ingestion Plan

## Purpose

Add email as an ingestion source for invoices and receipts. Email exports are preferred over browser automation, so this lands before the real portal runner.

## Goals

- Add an email source kind: IMAP polling of a configured mailbox/folder.
- Extract PDF (and common image) attachments into document ingest with provenance.
- Record message metadata (sender, subject, date, message-id) as the raw source record.
- Deduplicate by message-id and by attachment content hash.
- Support sender/domain allowlists per source.

## Non-Goals

- Hosted inbound forwarding address (`user@in.sona.app`) — hosted-cloud follow-up.
- Parsing HTML email bodies into invoices (attachments only for v0).
- OAuth mailbox integrations (Gmail API etc.); IMAP with app password via the secret store is enough for v0.
- Sending any email.

## Required Reading

- `docs/product-spec.md` source onboarding
- `.plans/2026-07-03-11-worker-jobs-ingestion.md`
- `AGENTS.md` secrets and sensitive data rules

## Target Files

Likely create/modify:

```text
packages/connectors/src/email/types.ts
packages/connectors/src/email/imap-client.ts
packages/connectors/src/email/sync.ts
packages/connectors/src/email/*.test.ts
packages/connectors/src/email/fixtures.ts
apps/worker/src/jobs/source-sync.ts (dispatch by source kind)
```

## Design Constraints

- Follow the Enable Banking connector shape: a thin client interface, pure normalization, sync composed with injected stores — so tests run against a fake IMAP client with synthetic fixtures.
- Read-only mailbox access: never delete, move, or mark messages; track the sync cursor (UIDs) on Sona's side.
- Mailbox credentials live in the secret store; never in config files or logs.
- Raw source record stores redacted metadata only — no full message bodies by default; the attachment itself is the evidence.
- Ignore attachments from senders outside the allowlist when one is configured; record a skipped counter so ingestion is observable.

## TDD Steps

### Task 1: Normalization

Write tests first with synthetic MIME fixtures:

- PDF attachment extracted with filename, mime, bytes,
- multi-attachment message yields one document per attachment,
- inline images and signatures below a size threshold are skipped,
- message metadata normalizes to the raw record shape with redaction applied.

### Task 2: Sync semantics

- new messages since cursor are fetched; cursor advances only after successful ingest,
- re-running sync ingests nothing new (message-id dedup),
- same invoice forwarded twice dedupes by content hash at document level,
- allowlist filtering works and is logged as counts, not addresses.

### Task 3: Read-only guarantees

- fake client records every IMAP command; assert no STORE/EXPUNGE/MOVE-class commands are ever issued.

## Acceptance Criteria

- `pnpm check` passes.
- No credentials or email addresses in logs (tested via log capture).
- Idempotent sync verified end-to-end through the worker job.
- Commit uses Conventional Commits, e.g. `feat(connectors): add read-only imap invoice ingestion`.

## Follow-Up

- Hosted inbound forwarding address.
- OAuth-based mailbox connectors.
- Body-only invoice parsing (no attachment) via extraction pipeline.
