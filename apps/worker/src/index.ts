/**
 * @sona/worker
 *
 * Background jobs: source sync, OCR, reconciliation, portal receipt fetching,
 * and export generation. Jobs must be idempotent and safe to retry.
 */

/** Package version marker, used to verify wiring and test discovery. */
export const sonaWorkerVersion = "0.0.0" as const;

export {
  type AcquirePortalFetchJobInput,
  type GetPortalFetchConnectionInput,
  InMemoryPortalFetchConnectionRepository,
  InMemoryPortalFetchJobStateStore,
  InMemoryPortalFetchRunRecorder,
  type PortalFetchConnection,
  type PortalFetchConnectionRepository,
  type PortalFetchJobLeaseKey,
  type PortalFetchJobReservation,
  type PortalFetchJobStateStore,
  type PortalFetchJobStatus,
  type PortalFetchRunRecorder,
  type RecordPortalFetchRunInput,
  type RunPortalFetchJobInput,
  type RunPortalFetchJobResult,
  runPortalFetchJob,
} from "./jobs/portal-fetch.js";
