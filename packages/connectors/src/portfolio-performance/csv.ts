/**
 * Minimal RFC 4180-style CSV reader for Portfolio Performance exports: quoted
 * fields with doubled quotes, CR/LF/CRLF line endings, an optional UTF-8 BOM,
 * and `;` (German locale) or `,` delimiters detected from the header line.
 */

export type CsvDelimiter = ";" | ",";

/** One data row with its 1-based line number in the source text. */
export interface CsvRecord {
  line: number;
  cells: string[];
}

export interface CsvTable {
  delimiter: CsvDelimiter;
  header: string[];
  rows: CsvRecord[];
}

export function detectDelimiter(headerLine: string): CsvDelimiter {
  const semicolons = headerLine.split(";").length - 1;
  const commas = headerLine.split(",").length - 1;
  return semicolons >= commas ? ";" : ",";
}

/** Splits text into records, honoring quotes across delimiters and newlines. */
function readRecords(text: string, delimiter: CsvDelimiter): CsvRecord[] {
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;

  const endCell = (): void => {
    cells.push(cell);
    cell = "";
  };
  const endRecord = (): void => {
    endCell();
    records.push({ line: recordLine, cells });
    cells = [];
    recordLine = line;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === "\n") {
          line += 1;
        }
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      endCell();
    } else if (ch === "\r") {
      if (text[i + 1] === "\n") {
        i += 1;
      }
      line += 1;
      endRecord();
    } else if (ch === "\n") {
      line += 1;
      endRecord();
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || cells.length > 0) {
    endRecord();
  }
  return records;
}

/** Thrown when the text has no header line. */
export class EmptyCsvError extends Error {
  constructor() {
    super("CSV has no header line");
    this.name = "EmptyCsvError";
  }
}

export function parseCsv(text: string): CsvTable {
  const body = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const firstBreak = body.search(/\r|\n/);
  const headerLine = firstBreak === -1 ? body : body.slice(0, firstBreak);
  if (headerLine.trim() === "") {
    throw new EmptyCsvError();
  }
  const delimiter = detectDelimiter(headerLine);
  const [headerRecord, ...dataRecords] = readRecords(body, delimiter);
  if (headerRecord === undefined) {
    throw new EmptyCsvError();
  }
  const header = headerRecord.cells.map((cell) => cell.trim());
  const rows = dataRecords.filter((record) => record.cells.some((cell) => cell.trim() !== ""));
  return { delimiter, header, rows };
}
