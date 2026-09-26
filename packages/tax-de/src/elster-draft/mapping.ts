/**
 * Builds an {@link ElsterDraft} from ledger postings: applies the final review
 * gate (`user_reviewed` or stronger), maps each export line to its Anlage-level
 * grouping, and keeps everything else visible — unmapped sections in their own
 * block, gated-out postings with the reason they were left out.
 */
import { sumDecimals } from "@sona/core";
import { matchesAccountPattern } from "../export/accounts.js";
import { generateExportLines, requiredReviewState } from "../export/generate.js";
import type { TaxExportLine, TaxPostingInput, TaxTemplate } from "../export/types.js";
import type {
  ElsterDraft,
  ElsterDraftGroup,
  ElsterDraftLine,
  ElsterDraftMapping,
  ElsterDraftTotal,
  ElsterExcludedPosting,
  ElsterLineGroup,
  ElsterUnmappedSection,
} from "./types.js";

export interface GenerateElsterDraftInput {
  year: number;
  postings: readonly TaxPostingInput[];
  template: TaxTemplate;
  mapping: ElsterDraftMapping;
}

/** Whether the mapping is configured for the given tax year. */
export function mappingCoversYear(mapping: ElsterDraftMapping, year: number): boolean {
  return (
    year >= mapping.minTaxYear && (mapping.maxTaxYear === undefined || year <= mapping.maxTaxYear)
  );
}

/** First configured group the line belongs to, or `undefined` when none claims its section. */
export function groupForLine(
  mapping: ElsterDraftMapping,
  line: Pick<TaxExportLine, "sectionId" | "account">,
): ElsterLineGroup | undefined {
  return mapping.groups.find(
    (group) =>
      group.sectionIds.includes(line.sectionId) &&
      (group.accountPatterns === undefined ||
        group.accountPatterns.some((pattern) => matchesAccountPattern(line.account, pattern))),
  );
}

/** One exact total per currency, in first-seen order. */
export function totalsByCurrency(
  lines: readonly Pick<ElsterDraftLine, "amount" | "currency">[],
): ElsterDraftTotal[] {
  const byCurrency = new Map<string, string[]>();
  for (const line of lines) {
    const amounts = byCurrency.get(line.currency) ?? [];
    amounts.push(line.amount);
    byCurrency.set(line.currency, amounts);
  }
  return [...byCurrency.entries()].map(([currency, amounts]) => ({
    currency,
    amount: sumDecimals(amounts),
  }));
}

function toDraftLine(line: TaxExportLine): ElsterDraftLine {
  return {
    exportLineId: line.sourcePostingId,
    postingId: line.sourcePostingId,
    transactionId: line.sourceTransactionId,
    date: line.date,
    description: line.description,
    amount: line.amount,
    currency: line.currency,
    account: line.account,
    sectionId: line.sectionId,
    reviewState: line.reviewState,
    evidenceDocumentIds: [...line.evidenceDocumentIds],
    flags: line.notes === undefined ? [] : [line.notes],
  };
}

export function generateElsterDraft(input: GenerateElsterDraftInput): ElsterDraft {
  const { year, template, mapping } = input;
  if (mapping.templateId !== template.id) {
    throw new Error(
      `ELSTER draft mapping ${mapping.id} is configured for template ${mapping.templateId}, not ${template.id}`,
    );
  }
  if (!mappingCoversYear(mapping, year)) {
    throw new Error(
      `ELSTER draft mapping ${mapping.id} v${mapping.version} does not cover tax year ${year}`,
    );
  }

  // One tax year per draft; postings from other years are reported, not dropped silently.
  const yearPrefix = `${year}-`;
  const excluded: ElsterExcludedPosting[] = [];
  const inYear: TaxPostingInput[] = [];
  for (const posting of input.postings) {
    if (posting.date.startsWith(yearPrefix)) {
      inYear.push(posting);
    } else {
      excluded.push({
        postingId: posting.postingId,
        reason: `dated ${posting.date}, outside tax year ${year}`,
      });
    }
  }

  // The draft is stricter than a draft-mode export: only lines a human has
  // reviewed may be copied into a form.
  const gated = generateExportLines(inYear, template, { mode: "final" });
  excluded.push(...gated.excluded);

  const groupLines = new Map<string, ElsterDraftLine[]>();
  const unmappedLines = new Map<string, ElsterDraftLine[]>();
  for (const line of gated.lines) {
    const group = groupForLine(mapping, line);
    const bucket = group === undefined ? unmappedLines : groupLines;
    const key = group === undefined ? line.sectionId : group.id;
    const lines = bucket.get(key) ?? [];
    lines.push(toDraftLine(line));
    bucket.set(key, lines);
  }

  // Every configured group is rendered, even when empty, so a form line the
  // user expects to see is visibly zero rather than missing.
  const groups: ElsterDraftGroup[] = mapping.groups.map((group) => {
    const lines = groupLines.get(group.id) ?? [];
    return {
      groupId: group.id,
      anlage: group.anlage,
      lineLabel: group.lineLabel,
      description: group.description,
      totals: totalsByCurrency(lines),
      lines,
    };
  });

  const unmapped: ElsterUnmappedSection[] = template.sections
    .filter((section) => unmappedLines.has(section.id))
    .map((section) => {
      const lines = unmappedLines.get(section.id) ?? [];
      return {
        sectionId: section.id,
        sectionTitle: section.title,
        totals: totalsByCurrency(lines),
        lines,
      };
    });

  return {
    year,
    templateId: template.id,
    mappingId: mapping.id,
    mappingVersion: mapping.version,
    requiredReviewState: requiredReviewState("final"),
    groups,
    unmapped,
    excluded,
  };
}
