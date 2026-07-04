/**
 * @sona/worker
 *
 * Background jobs: source sync, OCR, reconciliation, and export generation.
 * Jobs must be idempotent and safe to retry.
 */

/** Package version marker, used to verify wiring and test discovery. */
export const sonaWorkerVersion = "0.0.0" as const;

export {
  InMemoryPortalFetchConnectionRepository,
  InMemoryPortalFetchJobStateStore,
  type PortalFetchConnection,
  type PortalFetchConnectionRepository,
  type PortalFetchJobStateStore,
  type PortalFetchJobStatus,
  type RunPortalFetchJobInput,
  type RunPortalFetchJobResult,
  runPortalFetchJob,
} from "./jobs/portal-fetch.js";
