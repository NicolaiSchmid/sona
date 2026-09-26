/**
 * Versioned, read-only portal automation task definitions. A task describes how
 * to fetch receipts/invoices from a merchant portal; it must declare a domain
 * allowlist, only read-only actions, and known output types.
 */
import { sha256Hex } from "@sona/core";
import { z } from "zod";
import { DOWNLOAD_MIME_TYPES } from "./download.js";
import {
  forbiddenConceptFor,
  forbiddenSelectorConceptFor,
  validateReadOnlyActions,
} from "./policy.js";
import { decodedPathAndQuery } from "./url.js";

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
] as const satisfies readonly PortalTaskStep["kind"][];

/**
 * A bare hostname: dot-separated labels, no scheme, path, port, userinfo, or
 * wildcard. Runners enforce the allowlist as the navigation boundary, so a `*`
 * or a full URL must not be accepted here.
 */
const HOSTNAME_RE = /^(localhost|(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,})$/i;

/**
 * The allowlist admits every subdomain of an entry, so an entry that is itself
 * a public or shared-hosting suffix would admit unrelated, attacker-controlled
 * hosts. A full public-suffix list is a follow-up; this covers the suffixes a
 * reviewer is most likely to paste by mistake.
 */
const SHARED_SUFFIXES: ReadonlySet<string> = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "me.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.jp",
  "co.nz",
  "co.za",
  "com.br",
  "com.mx",
  "co.in",
  "github.io",
  "gitlab.io",
  "herokuapp.com",
  "netlify.app",
  "vercel.app",
  "pages.dev",
  "workers.dev",
  "web.app",
  "firebaseapp.com",
  "appspot.com",
  "azurewebsites.net",
  "cloudfront.net",
  "amazonaws.com",
  "blogspot.com",
  "wordpress.com",
  "myshopify.com",
]);

function isSharedSuffix(domain: string): boolean {
  return SHARED_SUFFIXES.has(domain.toLowerCase());
}

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
    /** Only formats whose bytes the runner can verify may become evidence. */
    mimeType: z.enum(DOWNLOAD_MIME_TYPES).default("application/pdf"),
  }),
]);

export const portalHttpMethodExceptionSchema = z
  .object({
    method: z.enum(PORTAL_EXCEPTION_HTTP_METHODS),
    urlPattern: safePortalUrlSchema,
    reason: z.enum(ALLOWED_NON_IDEMPOTENT_REASONS),
    justification: z.string().trim().min(12),
    /**
     * Body field names the reviewed form sends. The guard refuses a matching
     * POST that carries any other field, so a multiplexed endpoint cannot be
     * repurposed for a mutation under this exception.
     */
    allowedBodyFields: z.array(z.string().min(1)).min(1),
    /**
     * Fields whose values are opaque credentials (username, password, OTP)
     * and are therefore never screened. Every other field is a control field:
     * its value is screened for forbidden operations, or must equal one of
     * its pinned values when listed in `pinnedBodyValues`.
     */
    credentialBodyFields: z.array(z.string().min(1)).default([]),
    /** Control fields whose values are reviewed exactly, e.g. `{ action: ["login"] }`. */
    pinnedBodyValues: z.record(z.string().min(1), z.array(z.string()).min(1)).default({}),
  })
  .strict()
  .superRefine((exception, ctx) => {
    const allowed = new Set(exception.allowedBodyFields);
    for (const field of exception.credentialBodyFields) {
      if (!allowed.has(field)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["credentialBodyFields"],
          message: `Credential field "${field}" is not in allowedBodyFields`,
        });
      }
    }
    const credentials = new Set(exception.credentialBodyFields);
    for (const [field, values] of Object.entries(exception.pinnedBodyValues)) {
      if (credentials.has(field)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["pinnedBodyValues", field],
          message: `Field "${field}" cannot be both a credential and a pinned control field`,
        });
      }
      if (!allowed.has(field)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["pinnedBodyValues", field],
          message: `Pinned field "${field}" is not in allowedBodyFields`,
        });
      }
      for (const value of values) {
        const concept = forbiddenConceptFor(value);
        if (concept !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["pinnedBodyValues", field],
            message: `Pinned value "${value}" implies a forbidden operation (${concept})`,
          });
        }
      }
    }
  });

export const portalTaskSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.number().int().positive(),
    risk: z.enum(PORTAL_TASK_RISKS),
    /** Domain allowlist of bare hostnames; the runner must not navigate elsewhere. */
    domains: z
      .array(
        z
          .string()
          .regex(HOSTNAME_RE, "must be a bare hostname")
          .refine(
            (domain) => !isSharedSuffix(domain),
            "must name the portal, not a public or shared-hosting suffix",
          ),
      )
      .min(1),
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
      const concept = forbiddenConceptFor(decodedPathAndQuery(exception.urlPattern));
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
        const concept = forbiddenSelectorConceptFor(step.selector);
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

/**
 * Content digest of a task definition. A portal connection is bound to the
 * digest of the definition the user approved, so credentials are only ever
 * filled into the exact reviewed revision, domains and steps included. The
 * input is normalized through the schema first so defaults are part of the
 * digest whether the caller passes raw YAML data or a parsed task.
 */
export function portalTaskDigest(task: unknown): string {
  return sha256Hex(new TextEncoder().encode(canonicalJson(parsePortalTask(task))));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    // Code-unit order rather than localeCompare: the digest must not depend on the runtime locale.
    const entries = Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}
