/**
 * @sona/agents
 *
 * Browser automation task plans for read-only receipt/invoice fetching from
 * merchant portals. Task definitions are versioned, domain-allowlisted, and
 * read-only by policy; runners must enforce those guarantees at execution time.
 */

/** Package version marker, used to verify wiring and test discovery. */
export const sonaAgentsVersion = "0.0.0" as const;

export type {
  PortalBrowserPage,
  PortalBrowserProvider,
  PortalBrowserSession,
  PortalBrowserSessionInput,
  PortalDownloadResponse,
  PortalElementHandle,
} from "./portal-tasks/browser.js";
export {
  BrowserbasePortalTaskRunner,
  type BrowserbasePortalTaskRunnerOptions,
} from "./portal-tasks/browserbase.js";
export { syntheticReferencePortalTask } from "./portal-tasks/definitions/synthetic-reference-portal.js";
export {
  createNetworkGuard,
  NetworkGuard,
  type NetworkGuardOptions,
  type NetworkGuardSnapshot,
  type PortalRequest,
  type PortalRequestDecision,
} from "./portal-tasks/network-guard.js";
export {
  createCdpPlaywrightBrowserProvider,
  createLocalPlaywrightBrowserProvider,
} from "./portal-tasks/playwright-adapter.js";
export {
  type GetPortalConnectionInput,
  InMemoryPortalConnectionRepository,
  InMemoryPortalDocumentRegistry,
  LocalPlaywrightPortalTaskRunner,
  type LocalPlaywrightPortalTaskRunnerOptions,
  type PortalConnection,
  type PortalConnectionRepository,
  type PortalDocumentRegistry,
} from "./portal-tasks/playwright-runner.js";
export {
  destructiveSelectorConceptFor,
  forbiddenConceptFor,
  type PolicyViolation,
  type ReadOnlyPolicyResult,
  validateReadOnlyActions,
} from "./portal-tasks/policy.js";
export {
  type AllowedNonIdempotentPortalRequest,
  type BlockedPortalRequest,
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
  type PortalTaskRunStatus,
  type RunPortalTaskInput,
  type RunPortalTaskResult,
} from "./portal-tasks/runner.js";
export {
  ALLOWED_NON_IDEMPOTENT_REASONS,
  PORTAL_EXCEPTION_HTTP_METHODS,
  PORTAL_TASK_OUTPUTS,
  PORTAL_TASK_RISKS,
  PORTAL_TASK_STEP_KINDS,
  type PortalHttpMethodException,
  type PortalTask,
  type PortalTaskStep,
  parsePortalTask,
  portalHttpMethodExceptionSchema,
  portalTaskSchema,
  portalTaskStepSchema,
  safeParsePortalTask,
} from "./portal-tasks/schema.js";
