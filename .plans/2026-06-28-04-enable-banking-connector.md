# Enable Banking Connector Plan

## Purpose

Port the verified Enable Banking Python spike into a test-backed TypeScript connector that imports account, balance, and transaction data as raw source records and normalized banking records.

## Background

A sandbox spike on domovoi proved:

- RS256 JWT auth works,
- `GET /application` works,
- AIS auth URL creation works,
- session code exchange works,
- account details/balances/transactions can be fetched,
- sandbox ASPSPs can be flaky and must be retried/tolerated.

Do not commit the sandbox key, app ID secrets beyond examples, JWTs, session IDs, or real account data.

## Goals

- Implement an Enable Banking client in TypeScript.
- Implement JWT signing from app ID + private key.
- Add fixture-backed tests with synthetic payloads.
- Normalize accounts, balances, and transactions.
- Store raw source records before normalized records.
- Create draft ledger postings into suspense accounts only after core ledger APIs exist.

## Non-Goals

- Production user onboarding UI.
- Real credentials in repo.
- Payment initiation.
- Direct PSD2/eIDAS bank integration.
- FinTS implementation.

## Target Files

Likely create/modify:

```text
packages/connectors/src/enable-banking/client.ts
packages/connectors/src/enable-banking/jwt.ts
packages/connectors/src/enable-banking/types.ts
packages/connectors/src/enable-banking/normalize.ts
packages/connectors/src/enable-banking/sync.ts
packages/connectors/src/enable-banking/index.ts
packages/connectors/src/enable-banking/*.test.ts
packages/connectors/fixtures/enable-banking/*.json
.env.example
```

## Environment Shape

Document but do not require real values:

```text
ENABLE_BANKING_APP_ID=
ENABLE_BANKING_PRIVATE_KEY_PATH=
ENABLE_BANKING_API_BASE=https://api.enablebanking.com
ENABLE_BANKING_REDIRECT_URL=
```

## Client API

Proposed functions:

```ts
createEnableBankingClient(config)
client.getApplication()
client.listAspsps({ country, nameContains? })
client.startAuth({ country, name, redirectUrl, validUntil })
client.exchangeCode({ code })
client.getSession({ sessionId })
client.getAccountDetails({ accountUid })
client.getBalances({ accountUid })
client.getTransactions({ accountUid })
```

## TDD Steps

### Task 1: JWT claims/header

Write tests first for:

- header contains `typ: JWT`, `alg: RS256`, `kid`,
- payload contains `iss`, `aud`, `iat`, `exp`,
- exp is bounded and not over 24h.

Use a generated test key fixture, not the real key.

### Task 2: HTTP client request shape

Use mocked fetch/HTTP transport. Test:

- Authorization header is `Bearer <jwt>`,
- API base URL is respected,
- non-2xx responses normalize errors with status/body,
- retry policy can retry transient 502/503/timeouts for sandbox flakiness.

### Task 3: Normalizers

Create synthetic fixture payloads for:

- session with accounts,
- account details,
- balances,
- transactions.

Test normalized outputs contain stable IDs and preserve raw payload references.

### Task 4: Sync orchestration

Implement a sync function that:

1. records sync run start,
2. fetches session/account data,
3. writes raw source records,
4. writes normalized bank records,
5. records per-account errors without failing the entire sync when one account fails.

Use repository interfaces/mocks if DB layer is not ready.

## Error Handling

- Treat ASPSP 502/503 as per-account transient errors.
- Do not fail all accounts because one transaction endpoint failed.
- Persist error details without secrets.
- Redact JWTs, private key paths if needed, and any credentials.

## Acceptance Criteria

- `pnpm check` passes.
- No real Enable Banking credentials are committed.
- Synthetic fixtures cover accounts, balances, transactions, and one ASPSP error.
- Client can be wired to real credentials by env/config outside the repo.
- Commit uses Conventional Commits, e.g. `feat(connectors): add enable banking client`.

## Future Work

- Production/restricted-production onboarding flow.
- FinTS connector.
- Connector health dashboard.
- Consent expiry and re-auth reminders.
