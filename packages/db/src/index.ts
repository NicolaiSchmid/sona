/**
 * @sona/db
 *
 * Database schema, migrations, and (later) typed repositories. Hosted cloud
 * targets PostgreSQL; local/self-hosted may use SQLite. Migrations are written
 * in the portable SQL subset shared by both.
 */

/** Package version marker, used to verify wiring and test discovery. */
export const sonaDbVersion = "0.0.0" as const;

export { CORE_MIGRATIONS, type Migration } from "./migrations/index";
export * from "./runner";
export * from "./schema";
