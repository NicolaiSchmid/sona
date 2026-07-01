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

function csvField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function csv(header: readonly string[], rows: readonly string[][]): string {
  return [header, ...rows].map((row) => row.map(csvField).join(",")).join("\n");
}

function taxCategoriesCsv(lines: readonly TaxExportLine[]): string {
  return csv(
    ["date", "description", "amount", "currency", "account", "section", "reviewState", "notes"],
    lines.map((l) => [
      l.date,
      l.description,
      l.amount,
      l.currency,
      l.account,
      l.sectionId,
      l.reviewState,
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
  const { lines } = generateExportLines(input.postings, input.template, { mode: input.mode });
  const missing = generateMissingEvidenceReport(input.postings, input.template);

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
