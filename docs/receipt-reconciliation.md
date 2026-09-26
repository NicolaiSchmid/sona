# Receipt Reconciliation

Receipt reconciliation is a primary product feature, not a nice-to-have.

## Goal

Given many transactions and many uploaded/fetched receipts, Sona should automatically propose high-confidence matches and queue ambiguous cases for review.

## Inputs

Transactions:

- bank transaction amount,
- currency,
- booking date,
- value date,
- creditor/debtor names,
- remittance text,
- IBAN/counterparty details,
- card metadata if available,
- source account.

Documents:

- PDF/image/email body,
- OCR/text,
- extracted vendor,
- invoice/receipt date,
- due date,
- total amount,
- tax amount,
- invoice number,
- payment reference,
- source email/portal/upload metadata.

## Matching strategy

### Stage 1: deterministic candidates

Create candidates when strong identifiers match:

- exact amount + date window,
- exact invoice/reference number in bank remittance,
- IBAN or counterparty account match,
- payment provider reference,
- unique amount in small time window.

### Stage 2: fuzzy candidates

Score candidates by:

- amount match: exact, net/gross, partial, split payment,
- date distance,
- vendor/counterparty similarity,
- invoice number/reference similarity,
- recurring subscription pattern,
- email sender domain,
- document source reliability,
- previous user-approved rule.

### Stage 3: review queues

Human review is required for:

- multiple plausible receipts,
- multiple plausible transactions,
- low OCR confidence,
- tax-relevant expense without receipt,
- high-value expense,
- depreciation/asset-related expense,
- medical/legal/insurance documents,
- conflicting extracted totals.

## Mass-upload workflow

1. User uploads a ZIP, PDF batch, phone photos, or forwards emails.
2. Sona stores originals and computes content hashes.
3. OCR/text extraction runs.
4. Fields are extracted into structured document records.
5. Reconciliation creates match candidates against transactions.
6. High-confidence matches can be auto-applied under policy.
7. Ambiguous matches appear in a review UI/MCP queue.
8. User decisions create reusable matching/classification rules.

## Email ingestion

Email is the preferred invoice channel before browser automation. The email source polls one IMAP folder read-only (`EXAMINE`; mail is never flagged, moved, or deleted) and:

- fetches envelopes and body structures only — message bodies are never read,
- applies a per-source sender allowlist (addresses or domains); non-allowlisted mail is counted, never stored,
- downloads only attachments of the configured types (by default PDF and common image types) that pass size rules (embedded signature images and tiny images are skipped) and whose bytes carry the declared type's signature,
- stores attachments through the document storage boundary with content-hash dedup, so a forwarded copy of the same invoice is not stored twice,
- writes redacted message metadata (sender, subject, date, Message-ID, folder, UID, attachment hashes) as the raw source record, deduplicated by Message-ID (falling back to folder + `UIDVALIDITY` + UID when the header is absent),
- keeps the UID cursor on Sona's side per sync run; a run only advances past messages it fully ingested.

Mailbox credentials live in the secret store and never in config or logs.

## Paperless-ngx import

Users with an existing Paperless-ngx archive can add it as a read-only source. The import lists documents in `(modified, id)` order from the last cursor, applies a tag allowlist and MIME/size policy, downloads originals (never the OCR text), verifies the bytes carry the declared type's signature, and stores them through the document storage boundary with content-hash dedup. Each imported document gets a raw source record with the Paperless id, title, dates, resolved tag/correspondent/type names, and the stored hash; a retagged or renamed document gets a superseding record and its bytes are deduplicated. Paperless is never written to. See `docs/adapters.md`.

## Auto-apply policy

Auto-apply should be configurable and conservative.

Example default:

```yaml
receiptMatching:
  autoApply:
    enabled: true
    minScore: 0.97
    requireExactAmount: true
    maxDateDistanceDays: 5
    disallowFor:
      - Expenses:Medical:*
      - Expenses:RealEstate:Improvements
      - amountGreaterThan: 1000
```

## Split and aggregate cases

Support:

- one receipt → one transaction,
- many receipts → one card transaction,
- one invoice → multiple installment payments,
- one bank transfer → multiple invoices,
- refunds/chargebacks,
- reimbursements.

These should be explicit reconciliation groups, not hidden hacks.

## Output states

```text
unmatched
candidate_found
auto_matched
user_matched
rejected
missing_receipt
not_required
```

## Evidence requirements

Receipt policies decide which ledger accounts require evidence.

Example:

```yaml
receiptPolicies:
  - account: Expenses:RealEstate:*
    required: true
  - account: Expenses:TaxAdvice
    required: true
  - account: Expenses:Insurance
    required: recommended
  - account: Expenses:Groceries
    required: false
```

## MCP examples

```ts
await sona.receipts.ingestUpload({ fileId });
await sona.reconciliation.suggestReceiptMatches({ taxYear: 2026 });
await sona.reconciliation.autoApply({ minScore: 0.98 });
await sona.reconciliation.listReviewItems({ kind: "receipt_match" });
await sona.reconciliation.approveMatch({ candidateId });
```
