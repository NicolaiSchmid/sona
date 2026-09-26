/**
 * Share-ready accountant package: the final tax-year export package, the
 * ELSTER-oriented draft, the receipt originals every included line points at,
 * a SHA-256 manifest, and a README addressed to the Steuerberater.
 *
 * The builder is pure and deterministic — identical inputs (including the
 * caller-supplied `generatedAt`) yield identical ZIP bytes — so the archive's
 * hash can identify it on a share link. Only `user_reviewed`-or-stronger
 * lines enter: the package is generated in `final` mode, and the ELSTER draft
 * applies the same gate.
 */
import { type DocumentStorage, sha256Hex, type WorkspaceContext } from "@sona/core";
import { generateElsterDraft } from "../elster-draft/mapping.js";
import {
  ELSTER_DRAFT_JSON_FILE,
  ELSTER_DRAFT_MARKDOWN_FILE,
  renderElsterDraftJson,
  renderElsterDraftMarkdown,
} from "../elster-draft/render.js";
import type { ElsterDraft, ElsterDraftMapping } from "../elster-draft/types.js";
import { type GeneratePackageInput, generateExportPackage } from "../export/package.js";
import { createZip } from "./zip.js";

/** A receipt/invoice original to bundle, as loaded from `DocumentStorage`. */
export interface AccountantPackageDocument {
  id: string;
  originalFilename: string | undefined;
  contentType: string;
  bytes: Uint8Array;
}

export interface AccountantPackageFile {
  path: string;
  bytes: Uint8Array;
}

export interface AccountantManifestEntry {
  path: string;
  sha256: string;
  byteLength: number;
}

export interface BundledDocument {
  documentId: string;
  path: string;
  originalFilename: string | undefined;
  contentType: string;
  sha256: string;
  byteLength: number;
}

export interface AccountantPackageInput extends Omit<GeneratePackageInput, "mode"> {
  mapping: ElsterDraftMapping;
  /**
   * ISO timestamp written into the README. Supplied by the caller (not read
   * from the clock) so the same inputs always produce the same bytes.
   */
  generatedAt: string;
  /** Originals available for bundling; only those an included line references are used. */
  documents: readonly AccountantPackageDocument[];
  /** Optional neutral label for the recipient, e.g. "Kanzlei Muster". Keep it free of personal data. */
  recipientLabel?: string;
}

export interface AccountantPackage {
  year: number;
  templateId: string;
  mappingId: string;
  files: readonly AccountantPackageFile[];
  manifest: readonly AccountantManifestEntry[];
  bundledDocuments: readonly BundledDocument[];
  /** Referenced by an included line but not supplied by the caller. */
  missingDocumentIds: readonly string[];
  /** Supplied but referenced by no included line; never bundled. */
  excludedDocumentIds: readonly string[];
  elsterDraft: ElsterDraft;
  zip: Uint8Array;
  zipSha256: string;
}

export const ACCOUNTANT_README_FILE = "README.md" as const;
export const ACCOUNTANT_MANIFEST_FILE = "MANIFEST.sha256" as const;
export const ACCOUNTANT_DOCUMENTS_DIR = "documents" as const;

const EXTENSION_BY_CONTENT_TYPE: Readonly<Record<string, string>> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/tiff": "tiff",
  "image/webp": "webp",
  "text/plain": "txt",
};

const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const SAFE_EXTENSION = /^[a-z0-9]{1,8}$/;

/**
 * Archive path of a bundled original: the document id plus a file extension.
 * Original filenames stay in the manifest CSV only — they may carry personal
 * data and are not needed to open the file.
 */
export function bundledDocumentPath(document: {
  id: string;
  originalFilename: string | undefined;
  contentType: string;
}): string {
  if (!SAFE_ID.test(document.id) || document.id === "." || document.id === "..") {
    throw new Error(
      `document id ${JSON.stringify(document.id)} is not a safe archive path segment`,
    );
  }
  const fromName = document.originalFilename?.split(".").at(-1)?.toLowerCase();
  const extension =
    fromName !== undefined &&
    fromName !== document.originalFilename?.toLowerCase() &&
    SAFE_EXTENSION.test(fromName)
      ? fromName
      : (EXTENSION_BY_CONTENT_TYPE[document.contentType.toLowerCase()] ?? "bin");
  return `${ACCOUNTANT_DOCUMENTS_DIR}/${document.id}.${extension}`;
}

/** Document ids referenced from the package's `evidence-links.json`. */
function referencedDocumentIds(evidenceLinksJson: string): Set<string> {
  const links = JSON.parse(evidenceLinksJson) as Array<{ documentIds: string[] }>;
  return new Set(links.flatMap((link) => link.documentIds));
}

function textBytes(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}

function manifestText(entries: readonly AccountantManifestEntry[]): string {
  // `sha256sum -c MANIFEST.sha256` format: hash, two spaces, path.
  return `${entries.map((e) => `${e.sha256}  ${e.path}`).join("\n")}\n`;
}

function bundledDocumentsCsv(documents: readonly BundledDocument[]): string {
  const field = (value: string): string =>
    /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  const rows = documents.map((d) =>
    [d.documentId, d.path, d.originalFilename ?? "", d.contentType, String(d.byteLength), d.sha256]
      .map(field)
      .join(","),
  );
  return ["documentId,path,originalFilename,contentType,byteLength,sha256", ...rows].join("\n");
}

interface ReadmeInput {
  input: AccountantPackageInput;
  draft: ElsterDraft;
  fileList: readonly string[];
  bundled: readonly BundledDocument[];
  missing: readonly string[];
  excluded: readonly string[];
}

function readmeMarkdown({
  input,
  draft,
  fileList,
  bundled,
  missing,
  excluded,
}: ReadmeInput): string {
  const reviewedLines = draft.groups.reduce((n, g) => n + g.lines.length, 0);
  const unmappedLines = draft.unmapped.reduce((n, s) => n + s.lines.length, 0);
  return [
    `# Sona accountant package — tax year ${input.year}`,
    "",
    "> PREPARED VALUES FOR REVIEW — NOT A SUBMISSION — NOT TAX ADVICE",
    "> This package was assembled by the taxpayer's own bookkeeping tool. It contains",
    "> user-reviewed ledger lines, the documents that substantiate them, and drafts",
    "> grouped by form fields as a preparation aid. It does not state that any",
    "> amount is deductible, and nothing in it has been transmitted to a tax authority.",
    "",
    ...(input.recipientLabel === undefined ? [] : [`Prepared for: ${input.recipientLabel}`, ""]),
    `Generated: ${input.generatedAt} · Template: ${input.template.id} · ELSTER draft mapping: ${input.mapping.id} v${input.mapping.version}`,
    "",
    "## Review gate",
    "",
    `Every ledger line in this package has review state \`${draft.requiredReviewState}\` or stronger`,
    "(`user_reviewed`, `advisor_reviewed`, `exported`). Lines the taxpayer has not",
    `reviewed are listed in ${ELSTER_DRAFT_MARKDOWN_FILE} under "Excluded" with the reason.`,
    "",
    `- Reviewed lines mapped to a form grouping: ${reviewedLines}`,
    `- Reviewed lines in sections without a form grouping (review block): ${unmappedLines}`,
    `- Postings excluded (below the review gate or outside the year): ${draft.excluded.length}`,
    "",
    "## Contents",
    "",
    ...fileList.map((path) => `- \`${path}\``),
    "",
    "| File | Purpose |",
    "|---|---|",
    "| `summary.md` | Overview of the export package: lines per section, missing evidence, depreciation. |",
    "| `tax-categories.csv` | Every reviewed ledger line with section, review state, posting/transaction ids, evidence ids. |",
    "| `missing-evidence.csv` | Included lines whose section requires a receipt but none is linked. |",
    "| `receipt-manifest.csv` | Which document substantiates which posting. |",
    "| `evidence-links.json` | Machine-readable posting → document links. |",
    "| `depreciation-schedules.csv` | Depreciation rows from user-configured schedules (suggested amounts, review required). |",
    "| `investment-evidence.csv` | Capital-income evidence with security and gross-currency provenance (when present). |",
    `| \`${ELSTER_DRAFT_MARKDOWN_FILE}\` / \`${ELSTER_DRAFT_JSON_FILE}\` | Prepared totals per form grouping, each traceable to its lines. Not a submission. |`,
    "| `documents.csv` | Bundled originals: document id, archive path, original filename, content type, hash. |",
    `| \`${ACCOUNTANT_DOCUMENTS_DIR}/\` | Receipt/invoice originals named by document id. |`,
    `| \`${ACCOUNTANT_MANIFEST_FILE}\` | SHA-256 of every other file; verify with \`sha256sum -c ${ACCOUNTANT_MANIFEST_FILE}\`. |`,
    "",
    "## Documents",
    "",
    `- Bundled originals: ${bundled.length}`,
    `- Referenced by an included line but not available in this package: ${missing.length}${missing.length === 0 ? "" : ` (${missing.join(", ")})`}`,
    `- Supplied but referenced by no included line, therefore left out: ${excluded.length}`,
    "",
    "## How to read amounts",
    "",
    "Amounts are signed decimal strings in the ledger's convention and are never",
    "netted across currencies. Each total in the ELSTER draft is the exact sum of",
    "the lines listed under it. Suggested categories come from the taxpayer's",
    "configured template; whether a value belongs on a form is for you and the",
    "taxpayer to decide.",
    "",
  ].join("\n");
}

export function buildAccountantPackage(input: AccountantPackageInput): AccountantPackage {
  const exportPackage = generateExportPackage({ ...input, mode: "final" });
  const draft = generateElsterDraft({
    year: input.year,
    postings: input.postings,
    template: input.template,
    mapping: input.mapping,
  });

  const evidenceLinks = exportPackage.files.find((f) => f.path === "evidence-links.json");
  if (evidenceLinks === undefined) {
    throw new Error("export package is missing evidence-links.json");
  }
  const referenced = referencedDocumentIds(evidenceLinks.content);
  const supplied = new Map(input.documents.map((d) => [d.id, d]));
  for (const [id] of supplied) {
    if (input.documents.filter((d) => d.id === id).length > 1) {
      throw new Error(`document ${id} was supplied more than once`);
    }
  }

  const bundled: BundledDocument[] = [];
  const missing: string[] = [];
  for (const id of [...referenced].sort()) {
    const document = supplied.get(id);
    if (document === undefined) {
      missing.push(id);
      continue;
    }
    bundled.push({
      documentId: id,
      path: bundledDocumentPath(document),
      originalFilename: document.originalFilename,
      contentType: document.contentType,
      sha256: sha256Hex(document.bytes),
      byteLength: document.bytes.byteLength,
    });
  }
  const excluded = [...supplied.keys()].filter((id) => !referenced.has(id)).sort();

  const contentFiles: AccountantPackageFile[] = [
    ...exportPackage.files.map((f) => ({ path: f.path, bytes: textBytes(f.content) })),
    { path: ELSTER_DRAFT_MARKDOWN_FILE, bytes: textBytes(renderElsterDraftMarkdown(draft)) },
    { path: ELSTER_DRAFT_JSON_FILE, bytes: textBytes(renderElsterDraftJson(draft)) },
    { path: "documents.csv", bytes: textBytes(bundledDocumentsCsv(bundled)) },
    ...bundled.map((d) => {
      const document = supplied.get(d.documentId);
      if (document === undefined) {
        throw new Error(`bundled document ${d.documentId} vanished`);
      }
      return { path: d.path, bytes: document.bytes };
    }),
  ];
  const readmePath = ACCOUNTANT_README_FILE;
  const fileList = [
    readmePath,
    ...contentFiles.map((f) => f.path),
    ACCOUNTANT_MANIFEST_FILE,
  ].sort();
  contentFiles.push({
    path: readmePath,
    bytes: textBytes(readmeMarkdown({ input, draft, fileList, bundled, missing, excluded })),
  });

  const manifest: AccountantManifestEntry[] = contentFiles
    .map((f) => ({ path: f.path, sha256: sha256Hex(f.bytes), byteLength: f.bytes.byteLength }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const files: AccountantPackageFile[] = [
    ...contentFiles,
    { path: ACCOUNTANT_MANIFEST_FILE, bytes: textBytes(manifestText(manifest)) },
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const zip = createZip(files);
  return {
    year: input.year,
    templateId: input.template.id,
    mappingId: input.mapping.id,
    files,
    manifest,
    bundledDocuments: bundled,
    missingDocumentIds: missing,
    excludedDocumentIds: excluded,
    elsterDraft: draft,
    zip,
    zipSha256: sha256Hex(zip),
  };
}

export interface LoadAccountantDocumentsInput {
  storage: DocumentStorage;
  context: WorkspaceContext;
  documentIds: readonly string[];
}

/**
 * Loads originals from `DocumentStorage` for {@link buildAccountantPackage}.
 * A document the storage no longer holds is skipped (the builder reports it
 * as missing) rather than failing the whole package.
 */
export async function loadAccountantDocuments(
  input: LoadAccountantDocumentsInput,
): Promise<AccountantPackageDocument[]> {
  const documents: AccountantPackageDocument[] = [];
  for (const id of new Set(input.documentIds)) {
    let stream: Awaited<ReturnType<DocumentStorage["get"]>>;
    try {
      stream = await input.storage.get({ context: input.context, id });
    } catch {
      continue;
    }
    documents.push({
      id,
      originalFilename: stream.document.originalFilename,
      contentType: stream.document.contentType,
      bytes: stream.bytes,
    });
  }
  return documents;
}

/** Document ids an accountant package for these inputs would try to bundle. */
export function referencedEvidenceDocumentIds(
  input: Pick<GeneratePackageInput, "year" | "postings" | "template" | "depreciation">,
): string[] {
  const pkg = generateExportPackage({ ...input, mode: "final" });
  const evidenceLinks = pkg.files.find((f) => f.path === "evidence-links.json");
  return evidenceLinks === undefined
    ? []
    : [...referencedDocumentIds(evidenceLinks.content)].sort();
}
