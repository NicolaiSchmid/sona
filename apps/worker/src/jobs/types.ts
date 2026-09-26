/**
 * Typed job model: every job kind has a payload schema validated at the queue
 * boundary and a deterministic idempotency key derived from that payload, so
 * enqueueing the same work twice is a no-op.
 */
import type { JsonValue } from "@sona/core";
import type { PersistedJob } from "@sona/db";
import type { DocumentSourceKind } from "@sona/receipts";
import { z } from "zod";

export const JOB_KINDS = [
  "source_sync",
  "document_ingest",
  "extraction",
  "reconciliation",
  "export_generation",
  "portal_fetch",
] as const;

export type JobKind = (typeof JOB_KINDS)[number];

export function isJobKind(value: string): value is JobKind {
  return (JOB_KINDS as readonly string[]).includes(value);
}

const nonEmpty = z.string().trim().min(1);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

export const EXPORT_MODES = ["draft", "final"] as const;

export const DOCUMENT_SOURCE_KINDS = [
  "upload",
  "email",
  "portal",
  "paperless",
  "api",
] as const satisfies readonly DocumentSourceKind[];

export const JOB_PAYLOAD_SCHEMAS = {
  source_sync: z
    .object({
      sourceId: nonEmpty,
      /**
       * Scheduling window the sync belongs to (e.g. an ISO hour bucket). Part
       * of the idempotency key, so one sync runs per source per window; omit
       * it for a one-off sync that should coalesce with any pending one.
       */
      window: nonEmpty.optional(),
      transactionQuery: z
        .object({
          dateFrom: isoDate.optional(),
          dateTo: isoDate.optional(),
          strategy: nonEmpty.optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  document_ingest: z
    .object({
      /** Id of the staged upload in `DocumentStorage`; the job reads bytes from there. */
      uploadId: nonEmpty,
      sourceKind: z.enum(DOCUMENT_SOURCE_KINDS).default("upload"),
      /** Provenance (portal/email/upload context); never credentials. */
      sourceMetadata: jsonValueSchema.optional(),
    })
    .strict(),
  extraction: z.object({ documentId: nonEmpty }).strict(),
  reconciliation: z
    .object({
      documentId: nonEmpty,
      /**
       * What prompted this pass (e.g. `sync:<runId>` after new bank
       * transactions arrived). Part of the idempotency key, so a document is
       * reconciled once per trigger; omit it for the pass after extraction.
       */
      trigger: nonEmpty.optional(),
    })
    .strict(),
  export_generation: z
    .object({
      year: z.number().int().min(1900).max(9999),
      mode: z.enum(EXPORT_MODES).default("draft"),
      templateId: nonEmpty.default("private-de"),
    })
    .strict(),
  portal_fetch: z
    .object({
      connectionId: nonEmpty,
      /** Scheduling window, like `source_sync`; omit for a one-off fetch. */
      window: nonEmpty.optional(),
      /** Overrides the worker's default per-connection cooldown. */
      cooldownMs: z.number().int().nonnegative().optional(),
    })
    .strict(),
} as const satisfies Record<JobKind, z.ZodTypeAny>;

export type JobPayloadSchemas = typeof JOB_PAYLOAD_SCHEMAS;

/** Parsed payload (defaults applied) for a job kind. */
export type JobPayload<K extends JobKind> = z.infer<JobPayloadSchemas[K]>;

/** Payload as accepted at the enqueue boundary (defaults optional). */
export type JobPayloadInput<K extends JobKind> = z.input<JobPayloadSchemas[K]>;

export type ExportMode = (typeof EXPORT_MODES)[number];

/** A persisted job narrowed to one kind with its parsed payload. */
export interface Job<K extends JobKind = JobKind> extends Omit<PersistedJob, "kind" | "payload"> {
  kind: K;
  payload: JobPayload<K>;
}

export class InvalidJobPayloadError extends Error {
  readonly kind: string;
  readonly issues: readonly string[];

  constructor(kind: string, issues: readonly string[]) {
    super(`invalid ${kind} job payload: ${issues.join("; ")}`);
    this.name = "InvalidJobPayloadError";
    this.kind = kind;
    this.issues = issues;
  }
}

export function parseJobPayload<K extends JobKind>(kind: K, payload: unknown): JobPayload<K> {
  const schema: z.ZodTypeAny = JOB_PAYLOAD_SCHEMAS[kind];
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new InvalidJobPayloadError(
      kind,
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }
  return parsed.data as JobPayload<K>;
}

/** Narrows a persisted job to its kind, re-validating the stored payload. */
export function narrowJob<K extends JobKind>(job: PersistedJob, kind: K): Job<K> {
  if (job.kind !== kind) {
    throw new Error(`job ${job.id} is a ${job.kind} job, not ${kind}`);
  }
  return { ...job, kind, payload: parseJobPayload(kind, job.payload) };
}

export function narrowJobKind(job: PersistedJob): Job {
  if (!isJobKind(job.kind)) {
    throw new Error(`job ${job.id} has unknown kind ${JSON.stringify(job.kind)}`);
  }
  return narrowJob(job, job.kind);
}

/** The payload fields that identify one unit of work per kind; `undefined` parts are dropped. */
const IDEMPOTENCY_KEY_PARTS: {
  [K in JobKind]: (payload: JobPayload<K>) => ReadonlyArray<string | number | undefined>;
} = {
  source_sync: (p) => [p.sourceId, p.window],
  document_ingest: (p) => [p.uploadId],
  extraction: (p) => [p.documentId],
  reconciliation: (p) => [p.documentId, p.trigger],
  export_generation: (p) => [p.year, p.mode, p.templateId],
  portal_fetch: (p) => [p.connectionId, p.window],
};

/** Default workspace-scoped idempotency key, `<kind>:<part>:<part>`, for a kind and parsed payload. */
export function defaultIdempotencyKey<K extends JobKind>(kind: K, payload: JobPayload<K>): string {
  return [kind, ...IDEMPOTENCY_KEY_PARTS[kind](payload)]
    .filter((part) => part !== undefined)
    .join(":");
}
