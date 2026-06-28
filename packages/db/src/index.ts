/**
 * @sona/db
 *
 * Database schema, migrations, and typed repositories. Hosted cloud targets
 * PostgreSQL; local/self-hosted may use SQLite. Repositories enforce workspace
 * scoping and append-only semantics for raw source records.
 */

/** Package version marker, used to verify wiring and test discovery. */
export const sonaDbVersion = "0.0.0" as const;
