/**
 * Versioned, read-only portal automation task definitions. A task describes how
 * to fetch receipts/invoices from a merchant portal; it must declare a domain
 * allowlist, only read-only actions, and known output types.
 */
import { z } from "zod";
import {
  destructiveSelectorConceptFor,
  forbiddenConceptFor,
  validateReadOnlyActions,
} from "./policy.js";

/** Risk labels for portal tasks. Only read-only fetching is supported today. */
export const PORTAL_TASK_RISKS = ["read_only_document_fetch"] as const;

export const PORTAL_TASK_OUTPUTS = ["document_file", "provenance_json"] as const;

/**
 * The only non-idempotent method a task may justify. Login and search forms
 * POST; PUT/PATCH/DELETE have no read-only use on a merchant portal.
 */
export const PORTAL_EXCEPTION_HTTP_METHODS = ["POST"] as const;

export const ALLOWED_NON_IDEMPOTENT_REASONS = ["login", "search"] as const;

export const PORTAL_TASK_STEP_KINDS = [
  "navigate",
  "fill",
  "click",
  "waitForSelector",
  "downloadLinks",
] as const;

/**
 * A bare hostname: dot-separated labels, no scheme, path, port, userinfo, or
 * wildcard. Runners enforce the allowlist as the navigation boundary, so a `*`
 * or a full URL must not be accepted here.
 */
const HOSTNAME_RE = /^(localhost|(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,})$/i;

const SAFE_PORTAL_URL_RE = /^(https:\/\/[^/?#\s]+[^\s]*|http:\/\/localhost(:[0-9]+)?[^\s]*)$/i;

/**
 * A portal URL a task may navigate to or justify a POST against: https (or
 * plain-http localhost for fixtures) and never carrying userinfo, because
 * credentials belong in the SecretStore, not in a committed task definition.
 */
const safePortalUrlSchema = z
  .string()
  .url()
  .regex(SAFE_PORTAL_URL_RE, "must be an https URL or localhost URL")
  .refine((value) => !hasUserinfo(value), "must not embed credentials in the URL");

function hasUserinfo(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.username.length > 0 || url.password.length > 0;
  } catch {
    return true;
  }
}

const baseStepSchema = z.object({
  sensitive: z.boolean().optional(),
});

const selectorStepSchema = baseStepSchema.extend({
  selector: z.string().min(1),
});

export const portalTaskStepSchema = z.discriminatedUnion("kind", [
  baseStepSchema.extend({
    kind: z.literal("navigate"),
    url: safePortalUrlSchema,
  }),
  selectorStepSchema.extend({
    kind: z.literal("fill"),
    credentialKey: z.string().min(1),
  }),
  selectorStepSchema.extend({
    kind: z.literal("click"),
  }),
  selectorStepSchema.extend({
    kind: z.literal("waitForSelector"),
    timeoutMs: z.number().int().positive().optional(),
  }),
  selectorStepSchema.extend({
    kind: z.literal("downloadLinks"),
    hrefAttribute: z.string().min(1).default("href"),
    filenameAttribute: z.string().min(1).optional(),
    mimeType: z.string().min(1).default("application/pdf"),
  }),
]);

export const portalHttpMethodExceptionSchema = z
  .object({
    method: z.enum(PORTAL_EXCEPTION_HTTP_METHODS),
    urlPattern: safePortalUrlSchema,
    reason: z.enum(ALLOWED_NON_IDEMPOTENT_REASONS),
    justification: z.string().trim().min(12),
  })
  .strict();

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
    httpMethodExceptions: z.array(portalHttpMethodExceptionSchema).default([]),
    steps: z.array(portalTaskStepSchema).default([]),
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

    // A justified POST is the only bypass of the read-only network guard, so
    // its endpoint must not itself name a destructive operation.
    for (const [index, exception] of task.httpMethodExceptions.entries()) {
      const concept = forbiddenConceptFor(urlPathAndQuery(exception.urlPattern));
      if (concept !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["httpMethodExceptions", index, "urlPattern"],
          message: `Exception endpoint implies a forbidden operation (${concept})`,
        });
      }
    }

    for (const [index, step] of task.steps.entries()) {
      if ("selector" in step) {
        const concept = destructiveSelectorConceptFor(step.selector);
        if (concept !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["steps", index, "selector"],
            message: `Selector implies a forbidden operation (${concept})`,
          });
        }
      }
    }
  });

function urlPathAndQuery(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.pathname}${url.search}`;
  } catch {
    return rawUrl;
  }
}

export type PortalTask = z.infer<typeof portalTaskSchema>;
export type PortalTaskStep = z.infer<typeof portalTaskStepSchema>;
export type PortalHttpMethodException = z.infer<typeof portalHttpMethodExceptionSchema>;

/** Parses and validates a raw task definition (from YAML/JSON). Throws on error. */
export function parsePortalTask(input: unknown): PortalTask {
  return portalTaskSchema.parse(input);
}

/** Safe parse variant returning a discriminated result. */
export function safeParsePortalTask(input: unknown): z.SafeParseReturnType<unknown, PortalTask> {
  return portalTaskSchema.safeParse(input);
}
