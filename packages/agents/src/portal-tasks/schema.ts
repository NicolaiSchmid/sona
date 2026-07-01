/**
 * Versioned, read-only portal automation task definitions. A task describes how
 * to fetch receipts/invoices from a merchant portal; it must declare a domain
 * allowlist, only read-only actions, and known output types.
 */
import { z } from "zod";
import { validateReadOnlyActions } from "./policy.js";

/** Risk labels for portal tasks. Only read-only fetching is supported today. */
export const PORTAL_TASK_RISKS = ["read_only_document_fetch"] as const;

export const PORTAL_TASK_OUTPUTS = ["document_file", "provenance_json"] as const;

/**
 * A bare hostname: dot-separated labels, no scheme, path, port, userinfo, or
 * wildcard. Runners enforce the allowlist as the navigation boundary, so a `*`
 * or a full URL must not be accepted here.
 */
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

export const portalTaskSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.number().int().positive(),
    risk: z.enum(PORTAL_TASK_RISKS),
    /** Domain allowlist of bare hostnames; the runner must not navigate elsewhere. */
    domains: z.array(z.string().regex(HOSTNAME_RE, "must be a bare hostname")).min(1),
    requires: z.array(z.string().min(1)).default([]),
    allowedActions: z.array(z.string().min(1)).min(1),
    forbiddenActions: z.array(z.string().min(1)).default([]),
    outputs: z.array(z.enum(PORTAL_TASK_OUTPUTS)).min(1),
  })
  .superRefine((task, ctx) => {
    // Enforce the read-only policy on the declared allowed actions.
    const result = validateReadOnlyActions(task.allowedActions);
    for (const violation of result.violations) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowedActions"],
        message: `Action "${violation.action}" implies a forbidden operation (${violation.concept})`,
      });
    }
  });

export type PortalTask = z.infer<typeof portalTaskSchema>;

/** Parses and validates a raw task definition (from YAML/JSON). Throws on error. */
export function parsePortalTask(input: unknown): PortalTask {
  return portalTaskSchema.parse(input);
}

/** Safe parse variant returning a discriminated result. */
export function safeParsePortalTask(input: unknown): z.SafeParseReturnType<unknown, PortalTask> {
  return portalTaskSchema.safeParse(input);
}
