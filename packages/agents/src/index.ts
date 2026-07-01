/**
 * @sona/agents
 *
 * Browser automation task plans for read-only receipt/invoice fetching from
 * merchant portals. Task definitions are versioned, domain-allowlisted, and
 * read-only by policy; runners must enforce those guarantees at execution time.
 */

/** Package version marker, used to verify wiring and test discovery. */
export const sonaAgentsVersion = "0.0.0" as const;

export {
  forbiddenConceptFor,
  type PolicyViolation,
  type ReadOnlyPolicyResult,
  validateReadOnlyActions,
} from "./portal-tasks/policy.js";
export {
  type ExtractionStatus,
  type FetchedContent,
  type FetchedDocument,
  type FetchedDocumentProvenance,
  type TaskRunProvenance,
  type ToStoredDocumentInput,
  toStoredDocument,
} from "./portal-tasks/provenance.js";
export {
  FakePortalTaskRunner,
  type PortalTaskRunner,
  type RunPortalTaskInput,
  type RunPortalTaskResult,
} from "./portal-tasks/runner.js";
export {
  PORTAL_TASK_OUTPUTS,
  PORTAL_TASK_RISKS,
  type PortalTask,
  parsePortalTask,
  portalTaskSchema,
  safeParsePortalTask,
} from "./portal-tasks/schema.js";
