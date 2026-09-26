/**
 * `extraction`: runs the configured {@link ExtractionProvider} over a stored
 * document, persists the validated result, queues a review item when the
 * extraction is not trustworthy on its own, and hands the document to
 * reconciliation. One extraction is kept per document and provider version,
 * so a retry never writes a second row.
 */
import type { DocumentStorage, JsonValue, WorkspaceContext } from "@sona/core";
import type { DbClient } from "@sona/db";
import {
  RECORD_TYPES,
  type SqliteDocumentExtractionRepository,
  type SqliteDocumentRepository,
  type SqliteReviewQueueRepository,
  type StoredDocumentExtraction,
  withTransactionAsync,
} from "@sona/db";
import {
  assertProviderExtractionResult,
  type DocumentExtraction,
  type ExtractionProvider,
  type ExtractionStatus,
} from "@sona/receipts";
import { type JobHandler, NonRetryableJobError } from "./runner.js";

export interface ExtractionDependencies {
  db: DbClient;
  documents: SqliteDocumentRepository;
  extractions: SqliteDocumentExtractionRepository;
  reviewQueue: SqliteReviewQueueRepository;
  storage: DocumentStorage;
  provider: ExtractionProvider;
  /** Below this overall confidence the extraction is queued for review. Default 0.8. */
  reviewMinConfidence?: number;
}

export const DEFAULT_EXTRACTION_REVIEW_MIN_CONFIDENCE = 0.8;

export interface ExtractDocumentInput {
  context: WorkspaceContext;
  documentId: string;
  now: string;
}

export interface ExtractDocumentResult {
  extraction: StoredDocumentExtraction;
  /** False when an extraction by this provider version already existed. */
  created: boolean;
  /** Set when the extraction was queued for human review, with the reasons. */
  reviewItemId: string | undefined;
  reviewReasons: string[];
  /** Provider status of the result this run judged (undefined when reusing a stored row). */
  status: ExtractionStatus | undefined;
}

type ProviderIdentity = Pick<ExtractionProvider, "name" | "version">;

/** `name@version`, the stable identity of a provider implementation. */
export function providerTag(provider: ProviderIdentity): string {
  return `${provider.name}@${provider.version}`;
}

export function extractionId(documentId: string, provider: ProviderIdentity): string {
  return `extraction:${documentId}:${providerTag(provider)}`;
}

export function extractionReviewItemId(extractionId: string): string {
  return `review:${extractionId}`;
}

/**
 * Why an extraction must be looked at by a human before its fields are
 * trusted. Pass the provider's validated result where available: persisted
 * rows do not carry `status`/`warnings`.
 */
export function extractionReviewReasons(
  extraction: DocumentExtraction,
  minConfidence: number,
): string[] {
  const reasons: string[] = [];
  if (extraction.status !== undefined && extraction.status !== "succeeded") {
    reasons.push(`extraction status ${extraction.status}`);
  }
  if (extraction.confidence < minConfidence) {
    reasons.push(`confidence ${extraction.confidence} below ${minConfidence}`);
  }
  if (extraction.totalAmount === undefined) {
    reasons.push("no total amount extracted");
  }
  for (const warning of extraction.warnings ?? []) {
    reasons.push(`warning: ${warning}`);
  }
  return reasons;
}

export async function extractDocument(
  deps: ExtractionDependencies,
  input: ExtractDocumentInput,
): Promise<ExtractDocumentResult> {
  const { context, documentId } = input;
  const { workspaceId } = context;
  const document = await deps.documents.getById(workspaceId, documentId);
  if (document === undefined) {
    throw new NonRetryableJobError(`document ${documentId} not found in workspace`);
  }
  const minConfidence = deps.reviewMinConfidence ?? DEFAULT_EXTRACTION_REVIEW_MIN_CONFIDENCE;
  const id = extractionId(documentId, deps.provider);

  const existing = await deps.extractions.getById(workspaceId, id);
  if (existing !== undefined) {
    const reasons = extractionReviewReasons(existing, minConfidence);
    const reviewItem = await deps.reviewQueue.getById(workspaceId, extractionReviewItemId(id));
    return {
      extraction: existing,
      created: false,
      reviewItemId: reviewItem?.id,
      reviewReasons: reasons,
      status: undefined,
    };
  }

  const { bytes } = await deps.storage.get({ context, id: document.id });
  const raw = await deps.provider.extract({
    bytes,
    metadata: {
      documentId: document.id,
      mimeType: document.mimeType,
      originalFilename: document.originalFilename,
      contentHash: document.contentHash,
      sourceKind: document.sourceKind,
    },
  });
  const validated = assertProviderExtractionResult(raw);
  if (validated.documentId !== document.id) {
    throw new Error(
      `extraction provider returned documentId ${validated.documentId} for ${document.id}`,
    );
  }

  // Judge the provider's result, not the stored row: the extraction table does
  // not persist `status`/`warnings`, and both must be able to force review.
  const reasons = extractionReviewReasons(validated, minConfidence);
  return withTransactionAsync(deps.db, async () => {
    const extraction = await deps.extractions.save(workspaceId, {
      id,
      extraction: validated,
      createdAt: input.now,
    });
    let reviewItemId: string | undefined;
    if (reasons.length > 0) {
      reviewItemId = extractionReviewItemId(id);
      const reason: JsonValue = {
        kind: "extraction_review",
        documentId: document.id,
        extractionId: id,
        provider: providerTag(deps.provider),
        status: validated.status ?? null,
        confidence: extraction.confidence,
        reasons,
      };
      await deps.reviewQueue.enqueue({
        id: reviewItemId,
        workspaceId,
        targetType: RECORD_TYPES.documentExtraction,
        targetId: id,
        state: "suggested",
        reason,
        createdAt: input.now,
        updatedAt: input.now,
      });
    }
    return {
      extraction,
      created: true,
      reviewItemId,
      reviewReasons: reasons,
      status: validated.status,
    };
  });
}

export function createExtractionHandler(deps: ExtractionDependencies): JobHandler<"extraction"> {
  return async ({ job, context, now, enqueue, produced }) => {
    const result = await extractDocument(deps, {
      context,
      documentId: job.payload.documentId,
      now,
    });
    produced({ type: RECORD_TYPES.documentExtraction, id: result.extraction.id });
    if (result.reviewItemId !== undefined) {
      produced({ type: RECORD_TYPES.reviewItem, id: result.reviewItemId });
    }
    let reconciliationJobId: string | undefined;
    if (result.extraction.totalAmount !== undefined) {
      const follow = await enqueue("reconciliation", { documentId: job.payload.documentId });
      reconciliationJobId = follow.job.id;
    }
    return {
      extractionId: result.extraction.id,
      created: result.created,
      confidence: result.extraction.confidence,
      status: result.status ?? null,
      reviewItemId: result.reviewItemId ?? null,
      reviewReasons: result.reviewReasons,
      reconciliationJobId: reconciliationJobId ?? null,
    };
  };
}
