/**
 * @sona/core
 *
 * Core domain layer for Sona: double-entry ledger primitives, the evidence
 * graph, source-record semantics, review states, and validation helpers.
 *
 * This package must not depend on connectors, storage backends, or cloud
 * tenancy details. It models the private-tax-backoffice domain only.
 */

/** Package version marker, used to verify wiring and test discovery. */
export const sonaCoreVersion = "0.0.0" as const;
