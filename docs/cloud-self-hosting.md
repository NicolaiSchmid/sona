# Cloud and Self-Hosting Boundary

Sona keeps hosted cloud and self-hosted runtime choices outside the core tax
domain model. `@sona/core` now defines the typed boundary for runtime mode,
storage settings, workspace context, document storage, and secret storage
interfaces. It does not hardcode a production cloud vendor.

## Runtime Modes

- `local_dev`: developer-local runs with explicit workspace context and local
  test fakes.
- `self_hosted`: user-operated deployments, typically SQLite/Postgres with
  filesystem or local object storage and environment/file-backed secret refs.
- `hosted_cloud`: managed multi-tenant deployments. Config validation requires
  non-filesystem document storage and managed, non-plaintext secret backend
  settings.

## Configuration Boundary

`parseSonaRuntimeConfig` accepts already-decoded JSON/object input. The example
YAML at `config/sona.example.yaml` is documentation, not parsed by core; this
avoids adding a YAML dependency only for configuration examples.

The parser rejects unsupported autonomy settings:

- `policies.aiCan.submitTaxReturns: true`
- `policies.aiCan.initiatePayments: true`

Those actions need separate product, legal, and security design before any
feature flag exists.

## Tenancy Boundary

Core services should receive a `WorkspaceContext` explicitly and call
`requireWorkspaceContext` in constructors or entrypoints. The runtime layer does
not rely on hidden globals for workspace or tenant selection.

## Storage Boundary

`DocumentStorage` and `SecretStore` are interfaces. In-memory fakes are provided
for tests and local composition:

- `InMemoryDocumentStorage`
- `InMemorySecretStore`

Secret list operations return refs and labels only. `SecretValue` redacts itself
during string and JSON coercion so accidental logs and serialized responses do
not expose plaintext.
