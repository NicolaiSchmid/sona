/**
 * Renders an {@link ElsterDraft} as a Markdown document to copy from and as a
 * JSON document for tooling. Both open with the same banner: prepared values,
 * review required, not a submission, not tax advice.
 */
import type { ElsterDraft, ElsterDraftLine, ElsterDraftTotal } from "./types.js";

/** Banner every rendered draft carries verbatim; tests assert on these lines. */
export const ELSTER_DRAFT_BANNER = [
  "PREPARED VALUES FOR REVIEW — NOT A SUBMISSION — NOT TAX ADVICE",
  "This document groups user-reviewed ledger lines by the form fields a user may",
  "copy them into. Nothing here has been transmitted to any tax authority, and",
  "Sona does not decide whether an amount is deductible or belongs on a form.",
  "Verify every value against its evidence before filing.",
] as const;

export const ELSTER_DRAFT_JSON_FILE = "elster-draft.json" as const;
export const ELSTER_DRAFT_MARKDOWN_FILE = "elster-draft.md" as const;

const LINE_TABLE_HEADER = [
  "| Date | Description | Amount | Account | Review state | Posting / transaction | Evidence |",
  "|---|---|---|---|---|---|---|",
] as const;

function formatTotals(totals: readonly ElsterDraftTotal[]): string {
  return totals.length === 0
    ? "0 (no lines)"
    : totals.map((t) => `${t.amount} ${t.currency}`).join(" · ");
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function lineRow(line: ElsterDraftLine): string {
  const evidence = line.evidenceDocumentIds.length === 0 ? "—" : line.evidenceDocumentIds.join(" ");
  const flags = line.flags.length === 0 ? "" : ` ⚠ ${line.flags.join("; ")}`;
  return `| ${line.date} | ${escapeCell(line.description)} | ${line.amount} ${line.currency} | ${escapeCell(line.account)} | ${line.reviewState} | ${line.postingId} / ${line.transactionId} | ${evidence}${flags} |`;
}

function lineTable(lines: readonly ElsterDraftLine[]): string[] {
  return lines.length === 0 ? [] : [...LINE_TABLE_HEADER, ...lines.map(lineRow), ""];
}

export function renderElsterDraftMarkdown(draft: ElsterDraft): string {
  const out: string[] = [
    `# ELSTER-oriented draft ${draft.year} (prepared values)`,
    "",
    ...ELSTER_DRAFT_BANNER.map((line) => `> ${line}`),
    "",
    `Template: ${draft.templateId} · Mapping: ${draft.mappingId} v${draft.mappingVersion} · Minimum review state: ${draft.requiredReviewState}`,
    "",
    "Every total is the exact sum of the lines listed under it; every line names",
    "its ledger posting, transaction, and evidence documents.",
    "",
  ];

  for (const group of draft.groups) {
    out.push(
      `## ${group.anlage} — ${group.lineLabel}`,
      "",
      `Suggested grouping: ${group.description}`,
      "",
      `**Prepared total (review required): ${formatTotals(group.totals)}** — ${group.lines.length} line(s)`,
      "",
      ...lineTable(group.lines),
    );
  }

  out.push("## Unmapped — review required", "");
  if (draft.unmapped.length === 0) {
    out.push("- (none)", "");
  } else {
    out.push(
      "Reviewed lines in sections the mapping does not assign to any form field.",
      "They are not lost; decide where (or whether) they belong.",
      "",
    );
    for (const section of draft.unmapped) {
      out.push(
        `### ${section.sectionTitle} (${section.sectionId}): ${formatTotals(section.totals)}`,
        "",
        ...lineTable(section.lines),
      );
    }
  }

  out.push(
    `## Excluded from this draft: ${draft.excluded.length} posting(s)`,
    "",
    ...(draft.excluded.length === 0
      ? ["- (none)"]
      : draft.excluded.map((e) => `- ${e.postingId}: ${e.reason}`)),
    "",
  );
  return out.join("\n");
}

/** JSON twin of the Markdown document; carries the same banner as `notice`. */
export function renderElsterDraftJson(draft: ElsterDraft): string {
  return JSON.stringify({ notice: [...ELSTER_DRAFT_BANNER], ...draft }, null, 2);
}
