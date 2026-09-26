/**
 * Actor strings the worker writes on review events, match decisions, and
 * audit events. They follow the `@sona/core` convention for
 * `AuditEvent.actor`: humans are user ids, automation is namespaced. The MCP
 * facade and review UI use {@link isWorkerActor} to tell automated decisions
 * from human ones, so every worker-originated write must go through here.
 */

export const WORKER_ACTORS = {
  /** The job runner recording an attempt's outcome. */
  runner: (workerId: string) => `system:worker:${workerId}` as const,
  /** Draft postings and their corrections generated from a bank sync. */
  bankSync: "system:bank_sync",
  /** The conservative receipt auto-apply policy, versioned like a rule. */
  autoApply: "rule:auto_apply@1",
} as const;

const WORKER_ACTOR_PREFIXES = ["system:", "rule:"] as const;

/** True for any actor the worker itself may write; false for a human's user id. */
export function isWorkerActor(actor: string): boolean {
  return WORKER_ACTOR_PREFIXES.some((prefix) => actor.startsWith(prefix));
}
