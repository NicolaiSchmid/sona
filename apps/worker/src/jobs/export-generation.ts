/**
 * `export_generation`: builds the `@sona/tax-de` package for one tax year from
 * the ledger and stores it as a single JSON bundle in `DocumentStorage`. The
 * review gate lives in the tax package (`draft` includes `suggested` lines,
 * `final` requires `user_reviewed`); this job only feeds it postings with their
 * substantiating documents from the evidence graph.
 */
import type { DocumentStorage, WorkspaceContext } from "@sona/core";
import {
  type PersistedLedgerTransaction,
  RECORD_TYPES,
  type SqliteEvidenceLinkRepository,
  type SqliteLedgerRepository,
} from "@sona/db";
import {
  generateExportPackage,
  PRIVATE_DE_TEMPLATE,
  type TaxExportPackage,
  type TaxPostingInput,
  type TaxTemplate,
} from "@sona/tax-de";
import { type JobHandler, NonRetryableJobError } from "./runner.js";
import type { ExportMode } from "./types.js";

export interface ExportGenerationDependencies {
  ledger: SqliteLedgerRepository;
  evidenceLinks: SqliteEvidenceLinkRepository;
  storage: DocumentStorage;
  /** Templates by id; defaults to the built-in private DE template. */
  templates?: Readonly<Record<string, TaxTemplate>>;
}

export const DEFAULT_TAX_TEMPLATES = {
  [PRIVATE_DE_TEMPLATE.id]: PRIVATE_DE_TEMPLATE,
} as const satisfies Readonly<Record<string, TaxTemplate>>;

export interface GenerateExportInput {
  context: WorkspaceContext;
  year: number;
  mode: ExportMode;
  templateId: string;
  /** Distinguishes stored bundles of the same year/mode (e.g. the job id). */
  revision: string;
  now: string;
}

export interface GenerateExportResult {
  /** `DocumentStorage` id of the stored JSON bundle. */
  storageId: string;
  package: TaxExportPackage;
  postingCount: number;
  lineCount: number;
}

const STORAGE_ID_UNSAFE = /[^A-Za-z0-9_-]/g;

/** `DocumentStorage` id of a stored bundle; safe as a single path segment. */
export function exportStorageId(
  input: Pick<GenerateExportInput, "year" | "mode" | "templateId" | "revision">,
): string {
  return ["tax-export", input.year, input.mode, input.templateId, input.revision]
    .map((part) => String(part).replace(STORAGE_ID_UNSAFE, "_"))
    .join("-");
}

/** Ledger postings of one year as tax export inputs, with their substantiating documents. */
export async function collectTaxPostings(
  deps: Pick<ExportGenerationDependencies, "ledger" | "evidenceLinks">,
  workspaceId: string,
  year: number,
): Promise<TaxPostingInput[]> {
  const transactions = await deps.ledger.listTransactions(workspaceId, {
    from: `${year}-01-01`,
    to: `${year}-12-31`,
  });
  const postings: TaxPostingInput[] = [];
  for (const transaction of transactions) {
    const evidenceDocumentIds = await substantiatingDocuments(deps.evidenceLinks, transaction);
    for (const posting of transaction.postings) {
      postings.push({
        postingId: posting.id,
        transactionId: transaction.id,
        date: transaction.bookedOn,
        description: transaction.description,
        amount: posting.amount.amount,
        commodity: posting.amount.commodity,
        account: posting.account,
        reviewState: transaction.reviewState,
        evidenceDocumentIds,
      });
    }
  }
  return postings;
}

async function substantiatingDocuments(
  evidenceLinks: SqliteEvidenceLinkRepository,
  transaction: PersistedLedgerTransaction,
): Promise<string[]> {
  const links = await evidenceLinks.listForTransaction(transaction.workspaceId, transaction.id);
  return links
    .filter(
      (link) =>
        link.kind === "substantiates" &&
        link.fromType === RECORD_TYPES.document &&
        link.toId === transaction.id,
    )
    .map((link) => link.fromId);
}

export async function generateExport(
  deps: ExportGenerationDependencies,
  input: GenerateExportInput,
): Promise<GenerateExportResult> {
  const { context } = input;
  const templates = deps.templates ?? DEFAULT_TAX_TEMPLATES;
  const template = Object.hasOwn(templates, input.templateId)
    ? templates[input.templateId]
    : undefined;
  if (template === undefined) {
    throw new NonRetryableJobError(`unknown tax template ${input.templateId}`);
  }

  const postings = await collectTaxPostings(deps, context.workspaceId, input.year);
  const taxPackage = generateExportPackage({
    year: input.year,
    postings,
    template,
    mode: input.mode,
  });

  const storageId = exportStorageId({ ...input, templateId: template.id });
  const bundle = JSON.stringify(
    {
      generatedAt: input.now,
      workspaceId: context.workspaceId,
      package: taxPackage,
    },
    null,
    2,
  );
  await deps.storage.put({
    context,
    id: storageId,
    bytes: new TextEncoder().encode(bundle),
    contentType: "application/json",
    originalFilename: `${storageId}.json`,
    createdAt: input.now,
    metadata: {
      kind: RECORD_TYPES.taxExportPackage,
      year: String(input.year),
      mode: input.mode,
      templateId: template.id,
    },
  });

  const categories = taxPackage.files.find((file) => file.path === "tax-categories.csv");
  const lineCount =
    categories === undefined ? 0 : Math.max(0, categories.content.split("\n").length - 1);
  return { storageId, package: taxPackage, postingCount: postings.length, lineCount };
}

export function createExportGenerationHandler(
  deps: ExportGenerationDependencies,
): JobHandler<"export_generation"> {
  return async ({ job, context, now, produced }) => {
    const result = await generateExport(deps, {
      context,
      year: job.payload.year,
      mode: job.payload.mode,
      templateId: job.payload.templateId,
      revision: job.id,
      now,
    });
    produced({ type: RECORD_TYPES.taxExportPackage, id: result.storageId });
    return {
      storageId: result.storageId,
      year: result.package.year,
      mode: result.package.mode,
      templateId: result.package.templateId,
      postingCount: result.postingCount,
      lineCount: result.lineCount,
      files: result.package.files.map((file) => file.path),
    };
  };
}
