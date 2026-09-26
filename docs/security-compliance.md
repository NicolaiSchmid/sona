# Security, Privacy, and Compliance

Sona handles extremely sensitive data: bank transactions, invoices, tax records, medical/legal/insurance receipts, property documents, and credentials. Security and compliance must shape the product from the beginning.

This document is not legal advice. It records product and engineering constraints for later legal review.

## Data classes

High-sensitivity data includes:

- bank account metadata,
- bank transactions,
- receipts and invoices,
- tax IDs or addresses appearing in documents,
- real estate records,
- medical/legal/insurance documents,
- broker and portfolio records,
- portal credentials and sessions.

## Core controls

- Encryption in transit.
- Encryption at rest for databases and object storage.
- Separate credential vault/encrypted secrets.
- Least-privilege workers.
- Audit logs for admin and user actions.
- User data export and deletion flows.
- Subprocessor inventory.
- Incident response process.
- Retention policy.
- No plaintext secrets in logs/errors/MCP responses.

## Local secret key handling

Local and self-hosted encrypted secret storage uses AES-256-GCM with a 32-byte
key supplied through `SONA_SECRET_KEY` or an explicitly configured key file. The
runtime config may point to the encrypted secret file and key file path, but it
must not contain the key material itself. Key files must stay outside source
control and outside exported support bundles.

Secret values returned by the core runtime are redacted during string, JSON, and
Node inspection coercion. Plaintext is available only through an explicit
`reveal()` call at the boundary that needs to authenticate to an external
service.

## GDPR

Likely required areas:

- lawful basis,
- privacy policy,
- data processing agreements with processors,
- data subject access/export,
- deletion/erasure,
- retention schedule,
- subprocessor list,
- breach notification process,
- role separation and access controls.

## DPIA / Datenschutz-Folgenabschätzung

A DPIA is likely appropriate and may be required because of the combination of financial data, tax data, document contents, and potentially sensitive categories inferred from receipts.

The DPIA should influence:

- data minimization,
- retention,
- encryption,
- access logging,
- automated decision boundaries,
- cloud vs self-hosted options,
- processor choices.

## Banking / PSD2 boundary

Initial assumption:

- Use regulated aggregators such as Enable Banking for account information services.
- Sona consumes user-authorized data through those providers.
- Sona does not initiate payments by default.
- Sona does not try to become a direct PSD2 AISP/TPP initially.

Need legal review before public launch and before marketing claims around bank connectivity.

## Tax advice boundary

Sona should not present AI suggestions as legal/tax advice.

Safer pattern:

```text
Suggested category based on configured template/rule.
User review required before export.
```

Risky pattern:

```text
This is deductible under German tax law.
```

Every tax-relevant value should have a review status and evidence trail.

## Admin access

Hosted cloud needs an explicit policy:

- default no human admin access to user data,
- break-glass process,
- audit every access,
- support-safe redaction views,
- tenant isolation.

## Browser automation risks

Browser tasks may expose account pages and credentials. Controls:

- read-only task definitions,
- domain allowlists,
- screenshot/log retention limits,
- sensitive field redaction,
- forbidden action policies,
- explicit user consent per portal connection,
- run history visible to the user.

Implemented controls and their known limits:

- Credentials are only filled into the task revision the connection was
  approved for (bound by content digest), never into a same-id rewrite.
- Credential approval also names the browser provider; credentials approved
  for a local browser are never loaded into a managed remote one.
- The network guard runs on the browser context and refuses off-allowlist,
  cleartext, destructive-URL, WebSocket, and unreviewed non-idempotent traffic
  before it is sent. Requests are issued by the worker with redirects disabled
  so every hop is evaluated first; should the browser ever follow a redirect on
  its own, a refused hop is recorded and the session fails closed.
- Domain allowlists admit every subdomain of an entry; a deny-list refuses the
  common public and shared-hosting suffixes (`co.uk`, `github.io`, ...), but a
  full public-suffix-list check is still a follow-up.
- Domain allowlists are hostname-based. They do not protect against DNS
  rebinding or portals resolving to private addresses, so browsers and
  workers must run in an egress-isolated network with no route to internal
  services, in hosted and self-hosted deployments alike.
- Downloads are bounded in size and validated (status, media type, byte
  signature of the declared format) before they become evidence; run results
  carry references, not document bytes.
- Because requests are issued by the worker through Playwright's request
  interception, every response body is buffered in the worker before the page
  sees it; WebSocket and EventSource channels are refused and long-lived media
  streams are not supported inside guarded sessions.

## Email mailbox access

The IMAP source is read-only by design: the client interface has no flag, move, copy, delete, or expunge operation, folders are opened with `EXAMINE`, and the test fake fails if any mutating command is issued. Only server-parsed envelopes, body structures, and selected attachment parts are downloaded; bodies are never fetched, and of the envelope only sender, subject, date, and Message-ID are kept — recipient lists are discarded in memory and never stored. The app password is resolved from the secret store at connect time and every client error is re-thrown with addresses and credentials redacted. Sync summaries carry counts, redacted error messages, and the UID cursor (which names the configured folder) — no addresses, subjects, filenames, or content.

## Early launch posture

For early friend users:

- invite-only,
- private individuals only,
- Germany-focused templates,
- read-only bank sync,
- no payment initiation,
- no ELSTER submission,
- manual review before exports,
- clear disclaimers,
- documented deletion/export process.
