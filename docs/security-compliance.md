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
