/**
 * Assembles a tax-year export package as in-memory files. Actual ZIP/PDF
 * writing can come later; the content here (Markdown/CSV/JSON) is already
 * reviewable and traceable to ledger postings and evidence documents.
 */
import { generateExportLines } from "./generate.js";
import { generateMissingEvidenceReport } from "./missing-evidence.js";
import type { ExportMode, TaxExportLine, TaxPostingInput, TaxTemplate } from "./types.js";

export interface ExportFile {
  path: string;
  content: string;
}

export interface TaxExportPackage {
  year: number;
  templateId: string;
  mode: ExportMode;
  files: ExportFile[];
}

export interface GeneratePackageInput {
  year: number;
  postings: readonly TaxPostingInput[];
  template: TaxTemplate;
  mode: ExportMode;
}

/** File paths a generated package always contains. */
export const PACKAGE_FILES = [
  "summary.md",
  "tax-categories.csv",
  "missing-evidence.csv",
  "receipt-manifest.csv",
  "evidence-links.json",
] as const;

/**
 * Neutralizes spreadsheet formula injection: a field starting with `=`, `+`,
 * `@`, or a non-numeric `-` would execute as a formula when the CSV is opened
 * in Excel/LibreOffice. A leading apostrophe forces text interpretation.
 * Signed decimal amounts (e.g. "-84.23") are left intact.
 */
function escapeFormula(value: string): string {
  if (/^[=+@]/.test(value)) {
    return `'${value}`;
  }
  if (value.startsWith("-") && !/^-\d/.test(value)) {
    return `'${value}`;
  }
  return value;
}

function csvField(value: string): string {
  const safe = escapeFormula(value);
  if (/[",\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

function csv(header: readonly string[], rows: readonly string[][]): string {
  return [header, ...rows].map((row) => row.map(csvField).join(",")).join("\n");
}

function taxCategoriesCsv(lines: readonly TaxExportLine[]): string {
  return csv(
    [
      "date",
      "description",
      "amount",
      "currency",
      "account",
      "section",
      "reviewState",
      "postingId",
      "transactionId",
      "evidenceDocumentIds",
      "notes",
    ],
    lines.map((l) => [
      l.date,
      l.description,
      l.amount,
      l.currency,
      l.account,
      l.sectionId,
      l.reviewState,
      l.sourcePostingId,
      l.sourceTransactionId,
      l.evidenceDocumentIds.join(";"),
      l.notes ?? "",
    ]),
  );
}

function evidenceLinksJson(lines: readonly TaxExportLine[]): string {
  const links = lines
    .filter((l) => l.evidenceDocumentIds.length > 0)
    .map((l) => ({
      postingId: l.sourcePostingId,
      transactionId: l.sourceTransactionId,
      documentIds: l.evidenceDocumentIds,
    }));
  return JSON.stringify(links, null, 2);
}

function receiptManifestCsv(lines: readonly TaxExportLine[]): string {
  const rows: string[][] = [];
  for (const line of lines) {
    for (const documentId of line.evidenceDocumentIds) {
      rows.push([documentId, line.sourcePostingId, line.account, line.sectionId]);
    }
  }
  return csv(["documentId", "postingId", "account", "section"], rows);
}

function summaryMd(
  input: GeneratePackageInput,
  lines: readonly TaxExportLine[],
  missing: number,
): string {
  const totals = new Map<string, number>();
  for (const line of lines) {
    totals.set(line.sectionId, (totals.get(line.sectionId) ?? 0) + 1);
  }
  const sectionLines = [...totals.entries()].map(([id, count]) => `- ${id}: ${count} line(s)`);

  return [
    `# Tax export ${input.year} (${input.template.jurisdiction}, ${input.template.audience})`,
    "",
    `Template: ${input.template.id} · Mode: ${input.mode}`,
    "",
    "This is a tax-ready preparation package for review. It does not assert legal",
    "deductibility and does not file anything. A human must review before use.",
    "",
    `## Lines by section (${lines.length} total)`,
    ...(sectionLines.length > 0 ? sectionLines : ["- (none)"]),
    "",
    `## Missing evidence: ${missing} posting(s)`,
    "See missing-evidence.csv.",
    "",
  ].join("\n");
}

export function generateExportPackage(input: GeneratePackageInput): TaxExportPackage {
  // A package is for exactly one tax year: postings from other years must not
  // leak into its files even if the caller passes a mixed set.
  const yearPrefix = `${input.year}-`;
  const postings = input.postings.filter((p) => p.date.startsWith(yearPrefix));

  const { lines } = generateExportLines(postings, input.template, { mode: input.mode });

  // The missing-evidence report honors the same review gate as the export:
  // a final package only reports gaps for postings that are actually in it.
  const includedIds = new Set(lines.map((l) => l.sourcePostingId));
  const gatedPostings = postings.filter((p) => includedIds.has(p.postingId));
  const missing = generateMissingEvidenceReport(gatedPostings, input.template);

  const files: ExportFile[] = [
    { path: "summary.md", content: summaryMd(input, lines, missing.length) },
    { path: "tax-categories.csv", content: taxCategoriesCsv(lines) },
    {
      path: "missing-evidence.csv",
      content: csv(
        ["postingId", "transactionId", "date", "account", "section", "amount", "currency"],
        missing.map((m) => [
          m.postingId,
          m.transactionId,
          m.date,
          m.account,
          m.sectionId,
          m.amount,
          m.currency,
        ]),
      ),
    },
    { path: "receipt-manifest.csv", content: receiptManifestCsv(lines) },
    { path: "evidence-links.json", content: evidenceLinksJson(lines) },
  ];

  return { year: input.year, templateId: input.template.id, mode: input.mode, files };
}
