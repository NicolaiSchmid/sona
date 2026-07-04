import type { MoneyAmount } from "@sona/core";
import type { ExtractionProvider, ExtractionProviderInput } from "./provider.js";
import { assertProviderExtractionResult, compactFieldEvidence, field } from "./provider.js";
import type { DocumentExtraction, ExtractionFieldEvidence } from "./types.js";

const PDF_TEXT_PROVIDER_VERSION = "1";
const REVIEW_CONFIDENCE_THRESHOLD = 0.6;
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

interface ParsedAmount {
  readonly amount: string;
  readonly currency: string;
  readonly snippet: string;
}

interface ParsedField {
  readonly value: string;
  readonly snippet: string;
  readonly confidence: number;
}

export class PdfTextExtractionProvider implements ExtractionProvider {
  readonly name = "pdf-text";
  readonly version = PDF_TEXT_PROVIDER_VERSION;

  async extract(input: ExtractionProviderInput): Promise<DocumentExtraction> {
    const text = extractPdfTextLayer(input.bytes);
    if (text.trim() === "") {
      return assertProviderExtractionResult({
        documentId: input.metadata.documentId,
        vendorName: undefined,
        documentDate: undefined,
        dueDate: undefined,
        totalAmount: undefined,
        taxAmount: undefined,
        currency: undefined,
        invoiceNumber: undefined,
        paymentReference: undefined,
        extractedText: undefined,
        confidence: 0,
        extractorVersion: `${this.name}@${this.version}`,
        status: "needs_ocr",
        providerName: this.name,
        providerVersion: this.version,
        warnings: ["pdf has no extractable text layer"],
      });
    }

    const warnings: string[] = [];
    const vendor = parseVendor(text);
    const documentDate = parseDocumentDate(text);
    const invoiceNumber = parseInvoiceNumber(text);
    const total = parseTotalAmount(text);
    if (total.ambiguous) {
      warnings.push("multiple conflicting total amounts");
    }

    const fieldEvidence: ExtractionFieldEvidence = {};
    if (vendor !== undefined) {
      fieldEvidence.vendorName = field(text, vendor.value, vendor.confidence, vendor.snippet);
    }
    if (documentDate !== undefined) {
      fieldEvidence.documentDate = field(
        text,
        documentDate.value,
        documentDate.confidence,
        documentDate.snippet,
      );
    }
    if (invoiceNumber !== undefined) {
      fieldEvidence.invoiceNumber = field(
        text,
        invoiceNumber.value,
        invoiceNumber.confidence,
        invoiceNumber.snippet,
      );
    }
    if (total.amount !== undefined) {
      fieldEvidence.totalAmount = field(
        text,
        total.amount.amount,
        total.confidence,
        total.amountSnippet,
      );
      fieldEvidence.currency = field(
        text,
        total.amount.commodity,
        total.confidence,
        total.amountSnippet,
      );
    }

    const confidence = overallConfidence([
      vendor?.confidence,
      documentDate?.confidence,
      invoiceNumber?.confidence,
      total.amount === undefined ? undefined : total.confidence,
    ]);
    const status = confidence < REVIEW_CONFIDENCE_THRESHOLD ? "needs_review" : "succeeded";

    return assertProviderExtractionResult({
      documentId: input.metadata.documentId,
      vendorName: vendor?.value,
      documentDate: documentDate?.value,
      dueDate: undefined,
      totalAmount: total.amount?.amount,
      taxAmount: undefined,
      currency: total.amount?.commodity,
      invoiceNumber: invoiceNumber?.value,
      paymentReference: undefined,
      extractedText: text,
      confidence,
      extractorVersion: `${this.name}@${this.version}`,
      status,
      providerName: this.name,
      providerVersion: this.version,
      fieldEvidence: compactFieldEvidence(fieldEvidence),
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  }
}

export function extractPdfTextLayer(bytes: Uint8Array): string {
  const pdf = Buffer.from(bytes).toString("latin1");
  const lines: string[] = [];
  const streamPattern = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let streamMatch = streamPattern.exec(pdf);

  while (streamMatch !== null) {
    const stream = streamMatch[1];
    if (stream === undefined || !/\bBT\b/.test(stream) || !/\bET\b/.test(stream)) {
      streamMatch = streamPattern.exec(pdf);
      continue;
    }
    lines.push(...extractTextLinesFromContentStream(stream));
    streamMatch = streamPattern.exec(pdf);
  }

  return lines.join("\n").trim();
}

function extractTextLinesFromContentStream(stream: string): string[] {
  const lines: string[] = [];
  const textPattern =
    /\[((?:\s*\((?:\\.|[^\\)])*\)\s*-?\d*(?:\.\d+)?\s*)+)\]\s*TJ|\((?:\\.|[^\\)])*\)\s*Tj/g;
  let match = textPattern.exec(stream);

  while (match !== null) {
    const token = match[0];
    if (token.endsWith("TJ")) {
      const arrayContent = match[1];
      if (arrayContent !== undefined) {
        const parts = literalStrings(arrayContent).map(decodePdfLiteralString);
        const line = parts.join("").trim();
        if (line !== "") {
          lines.push(line);
        }
      }
    } else {
      const literal = literalStrings(token)[0];
      if (literal !== undefined) {
        const line = decodePdfLiteralString(literal).trim();
        if (line !== "") {
          lines.push(line);
        }
      }
    }
    match = textPattern.exec(stream);
  }

  return lines;
}

function literalStrings(source: string): string[] {
  const matches = source.match(/\((?:\\.|[^\\)])*\)/g);
  return matches ?? [];
}

function decodePdfLiteralString(literal: string): string {
  const body = literal.startsWith("(") && literal.endsWith(")") ? literal.slice(1, -1) : literal;
  let result = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== "\\") {
      result += char;
      continue;
    }
    const next = body[index + 1];
    if (next === undefined) {
      continue;
    }
    index += 1;
    if (next === "n") {
      result += "\n";
    } else if (next === "r") {
      result += "\r";
    } else if (next === "t") {
      result += "\t";
    } else if (next === "b") {
      result += "\b";
    } else if (next === "f") {
      result += "\f";
    } else if (/[0-7]/.test(next)) {
      const rest = body.slice(index, index + 3);
      const octal = /^[0-7]{1,3}/.exec(rest)?.[0] ?? next;
      result += String.fromCharCode(Number.parseInt(octal, 8));
      index += octal.length - 1;
    } else {
      result += next;
    }
  }
  return result;
}

function parseVendor(text: string): ParsedField | undefined {
  const line = text
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0 && !/(rechnung|invoice|datum|gesamtbetrag)/i.test(part));
  if (line === undefined) {
    return undefined;
  }
  return { value: line, snippet: line, confidence: 0.9 };
}

function parseDocumentDate(text: string): ParsedField | undefined {
  const match =
    /((?:rechnungsdatum|datum|invoice date)\s*:?\s*)(\d{2}\.\d{2}\.\d{4}|\d{4}-\d{2}-\d{2})/i.exec(
      text,
    );
  const rawDate = match?.[2];
  if (match === null || rawDate === undefined) {
    return undefined;
  }
  const value = toIsoDate(rawDate);
  if (value === undefined) {
    return undefined;
  }
  return { value, snippet: match[0], confidence: 0.9 };
}

function toIsoDate(rawDate: string): string | undefined {
  if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    return rawDate;
  }
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(rawDate);
  if (match === null) {
    return undefined;
  }
  const [, day, month, year] = match;
  if (day === undefined || month === undefined || year === undefined) {
    return undefined;
  }
  const iso = `${year}-${month}-${day}`;
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) {
    return undefined;
  }
  return iso;
}

function parseInvoiceNumber(text: string): ParsedField | undefined {
  const match =
    /(?:rechnung(?:s(?:nummer|nr\.?))?|invoice(?:\s*number)?)\s*:?\s*([A-Z]{1,4}-\d{4}-\d{4}|[A-Z0-9][A-Z0-9-]{5,})/i.exec(
      text,
    );
  const value = match?.[1];
  if (match === null || value === undefined) {
    return undefined;
  }
  return { value, snippet: match[0], confidence: 0.88 };
}

function parseTotalAmount(text: string): {
  amount: MoneyAmount | undefined;
  amountSnippet: string;
  confidence: number;
  ambiguous: boolean;
} {
  const candidates = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /(gesamtbetrag|rechnungsbetrag|amount due|total)/i.test(line))
    .flatMap(parseAmountsFromLine);
  if (candidates.length === 0) {
    return { amount: undefined, amountSnippet: "", confidence: 0, ambiguous: false };
  }

  const distinctAmounts = new Set(candidates.map((candidate) => candidate.amount));
  const ambiguous = distinctAmounts.size > 1;
  const chosen = chooseAmount(candidates);
  const money = toMoneyAmount(chosen.amount, chosen.currency);
  if (money === undefined) {
    return { amount: undefined, amountSnippet: chosen.snippet, confidence: 0, ambiguous };
  }

  return {
    amount: money,
    amountSnippet: chosen.snippet,
    confidence: ambiguous ? 0.45 : 0.9,
    ambiguous,
  };
}

function parseAmountsFromLine(line: string): ParsedAmount[] {
  const amounts: ParsedAmount[] = [];
  const pattern = /(\d{1,3}(?:[.\s]\d{3})*,\d{2}|\d+,\d{2}|\d+\.\d{2})\s*(EUR|€|USD|GBP|CHF)?/gi;
  let match = pattern.exec(line);
  while (match !== null) {
    const amount = match[1];
    if (amount === undefined) {
      match = pattern.exec(line);
      continue;
    }
    const currency = normalizeCurrency(match[2]);
    amounts.push({
      amount: normalizeDecimal(amount),
      currency,
      snippet: line,
    });
    match = pattern.exec(line);
  }
  return amounts;
}

function chooseAmount(candidates: readonly ParsedAmount[]): ParsedAmount {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    counts.set(candidate.amount, (counts.get(candidate.amount) ?? 0) + 1);
  }
  let best = candidates[0];
  if (best === undefined) {
    throw new Error("chooseAmount requires at least one candidate");
  }
  for (const candidate of candidates) {
    const candidateCount = counts.get(candidate.amount) ?? 0;
    const bestCount = counts.get(best.amount) ?? 0;
    if (candidateCount > bestCount) {
      best = candidate;
    }
  }
  return best;
}

function normalizeCurrency(value: string | undefined): string {
  if (value === undefined || value === "€") {
    return "EUR";
  }
  return value.toUpperCase();
}

function normalizeDecimal(value: string): string {
  if (value.includes(",")) {
    return value.replace(/[.\s]/g, "").replace(",", ".");
  }
  return value;
}

function toMoneyAmount(amount: string, currency: string): MoneyAmount | undefined {
  if (!DECIMAL_RE.test(amount)) {
    return undefined;
  }
  return {
    amount,
    commodity: currency,
  };
}

function overallConfidence(values: readonly (number | undefined)[]): number {
  const present = values.filter((value): value is number => value !== undefined);
  if (present.length === 0) {
    return 0;
  }
  return Math.min(...present);
}
