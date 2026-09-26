# Agent Receipt Fetching

Some receipts are not delivered by email and are only available behind merchant portals. Sona should support agent-assisted browser automation to fetch them.

## Goal

Allow a user to provide credentials or an authenticated browser session so Sona can periodically fetch invoices/receipts from portals and store them as first-class documents.

## Examples

- Amazon invoices,
- utility providers,
- telecom providers,
- insurance portals,
- Hausverwaltung portals,
- SaaS subscriptions,
- app stores,
- broker tax statements,
- property management platforms.

## Product constraints

- Prefer user-controlled credentials/sessions.
- Do not use brittle scraping when an official export/API/email option exists.
- Store fetched documents internally.
- Record provenance: portal, URL, timestamp, browser run, file hash.
- Never let the agent buy, cancel, transfer, or change account settings.
- Keep automation read-only by policy.

## Runner architecture

```text
Sona worker (portal_fetch job: lease, cooldown, run history)
  → PortalTaskRunner
      LocalPlaywrightPortalTaskRunner   self-hosted Chromium via Playwright
      BrowserbasePortalTaskRunner       managed remote browser over CDP
  → versioned task definition (schema-validated, read-only policy)
  → network guard on the browser context
  → portal login → discovery → worker-issued download (session cookies, byte cap)
  → DocumentStorage (hash dedup) + receipts evidence record + run provenance
  → extraction + reconciliation
```

`@sona/agents` ships both runners behind one `PortalTaskRunner` interface;
`playwright` is an optional peer dependency and only loaded when a runner is
instantiated without an injected browser provider. Each run:

- re-validates the task and re-checks the read-only action policy before any
  browser launches, and refuses tasks without executable steps;
- only fills credentials when the connection is bound to the digest of the
  exact reviewed task revision (domains and steps included);
- only runs on the browser provider (local or managed) the connection was
  approved for, since a managed remote browser is a separate data processor;
- installs a network guard on the browser context that aborts off-allowlist
  and cleartext requests, URLs naming a forbidden operation (decoded, any
  method, any initiator; only static asset paths are exempt), every WebSocket
  handshake, and any non-idempotent request that is not an exact-URL POST
  exception whose body carries only reviewed fields (credential fields are
  opaque, control fields are pinned or screened);
- treats a refused navigation, download, or mutation attempt as `blocked`
  (terminal for the worker) while incidental third-party pixels or fonts are
  recorded as provenance and the run continues;
- issues every HTTP request of the session from the worker with redirects
  disabled, so each hop is evaluated by the guard before it is sent (a remote
  browser contributes rendering and scripting, not network egress);
- downloads with the session cookies under a hard byte cap and wall-clock
  deadline, checks final URL, status, media type, and the byte signature of the
  declared format (PDF, PNG, JPEG), reserves the content hash atomically,
  stores the original, and registers it as `@sona/receipts` evidence with
  source kind `portal`;
- redacts credentials, provider secrets, and query strings from errors,
  provenance, and stored metadata, and never returns document bytes.

The worker job leases a job id before launching, records every run result in
the run history before settling the lease, retries only transient failures,
and treats `policy_refused`, `selector_missing`, and `blocked` as terminal.
The real-browser fixture suite runs in CI (`pnpm test:portal-browser`).

## Codex subscription preference

If possible, the long-term design should let a user run browser/agent work through their own agent/browser subscription rather than forcing Sona to pay per browser/API task.

Potential modes:

### Managed mode

Sona pays for and operates Browserbase/browser infrastructure.

Pros:

- easiest UX,
- predictable environment,
- supportable.

Cons:

- direct usage cost,
- higher credential/security responsibility,
- more sensitive data in Sona infrastructure.

### Bring-your-own browser automation credentials

User supplies Browserbase or similar credentials.

Pros:

- cost belongs to user,
- self-host friendly.

Cons:

- setup complexity,
- not friend-friendly.

### User-agent delegated mode

User authorizes a task to run in their own Codex/agent/browser environment where available.

Pros:

- aligns with user subscriptions,
- reduces Sona API billing,
- clearer user control.

Cons:

- product surface may depend on external agent capabilities,
- harder to guarantee reliability,
- needs careful security model.

## Task model

A portal automation is a versioned task definition:

```yaml
id: amazon-de-invoices
name: Amazon Germany invoice fetcher
risk: read_only_document_fetch
requires:
  - authenticated_session_or_credentials
allowedActions:
  - navigate
  - search_orders
  - download_invoice_pdf
forbiddenActions:
  - purchase
  - cancel_order
  - change_payment_method
  - change_address
outputs:
  - document_file
  - provenance_json
```

## Safety gates

Every browser task should enforce:

- domain allowlist,
- read-only action policy,
- download type restrictions,
- no payment or profile mutation actions,
- credential redaction in logs,
- screenshot/log retention policy,
- user-visible run history,
- manual approval for new task definitions.

## Credentials and sessions

Supported approaches:

- encrypted username/password + TOTP/passkey-handling plan where allowed,
- user-provided session cookies/tokens,
- interactive login handoff,
- OAuth/API where available,
- manual upload fallback.

Credentials must be encrypted and scoped to the portal task. Plaintext credentials must never appear in logs, MCP outputs, or errors.

## Output provenance

For every fetched document, store:

- source portal,
- task version,
- run ID,
- original URL if safe,
- downloaded filename,
- content hash,
- timestamp,
- browser provider,
- user/workspace,
- extraction status.

## MCP examples

```ts
await sona.agents.listPortalTasks();
await sona.agents.createPortalConnection({ taskId: "amazon-de-invoices" });
await sona.agents.runPortalTask({ connectionId });
await sona.agents.listFetchedDocuments({ runId });
```

## Implementation note

Do not start by building dozens of portal adapters. Start with a generic task model, one or two real adapters, and strong provenance/security controls.
