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

export const portalTaskSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.number().int().positive(),
    risk: z.enum(PORTAL_TASK_RISKS),
    /** Domain allowlist — at least one; the runner must not navigate elsewhere. */
    domains: z.array(z.string().min(1)).min(1),
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
