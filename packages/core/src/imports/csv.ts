/**
 * A small RFC 4180 CSV reader (ADR 0029): commas, double-quoted fields,
 * quotes doubled inside quotes, line breaks inside quotes, CRLF or LF, and a
 * leading UTF-8 byte-order mark. No dependency — the format is fixed by
 * docs/import/listings-template.csv and this is what it needs.
 */

export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

export class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvError';
  }
}

/**
 * One cell of a CSV we hand back to a person, quoted. A cell that a
 * spreadsheet would run as a formula (= + - @, tab, CR) is prefixed with an
 * apostrophe: the report echoes what the uploaded file said, and opening it
 * must not run anything.
 */
export function csvCell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function parseCsv(text: string, maxRows = MAX_IMPORT_ROWS): { headers: string[]; rows: string[][] } {
  if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) throw new CsvError('That file is larger than 10 MB');
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      i += 1;
    } else if (c === ',') {
      record.push(field);
      field = '';
      i += 1;
    } else if (c === '\n' || c === '\r') {
      record.push(field);
      field = '';
      if (!(record.length === 1 && record[0] === '')) records.push(record);
      record = [];
      i += c === '\r' && src[i + 1] === '\n' ? 2 : 1;
      if (records.length > maxRows + 1) throw new CsvError(`At most ${maxRows.toLocaleString('en-AU')} rows in one file — split it into smaller files`);
    } else {
      field += c;
      i += 1;
    }
  }
  if (quoted) throw new CsvError('A quoted field is never closed — check for a stray " in the file');
  if (field !== '' || record.length) {
    record.push(field);
    if (!(record.length === 1 && record[0] === '')) records.push(record);
  }
  if (!records.length) throw new CsvError('The file is empty');
  const [headers, ...rows] = records;
  if (rows.length > maxRows) throw new CsvError(`At most ${maxRows.toLocaleString('en-AU')} rows in one file — split it into smaller files`);
  if (!rows.length) throw new CsvError('The file has a header row but no listings');
  return { headers: headers!.map((h) => h.trim()), rows };
}

/** Rows as a table: the first row its headers. What a Google Sheet or an Excel file becomes (ADR 0029 amendment). */
export type ImportTable = { headers: string[]; rows: string[][] };

/**
 * A table read from a sheet or a workbook, made to look exactly like a parsed CSV: every cell a
 * string, rows as wide as the headers, blank rows dropped, and the CSV's own limits and messages.
 */
export function tableFromCells(cells: unknown[][], maxRows = MAX_IMPORT_ROWS): ImportTable {
  const text = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  const records = cells.map((r) => (Array.isArray(r) ? r.map(text) : [])).filter((r) => r.some((c) => c.trim() !== ''));
  if (!records.length) throw new CsvError('The sheet is empty');
  const [head, ...body] = records;
  // A trailing run of empty header cells is not a column.
  let width = head!.length;
  while (width > 0 && head![width - 1]!.trim() === '' && body.every((r) => (r[width - 1] ?? '').trim() === '')) width -= 1;
  if (!width) throw new CsvError('The first row has no column names');
  if (!body.length) throw new CsvError('The sheet has a header row but no listings');
  if (body.length > maxRows) throw new CsvError(`At most ${maxRows.toLocaleString('en-AU')} rows in one file — split it into smaller files`);
  const rows = body.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ''));
  const table = { headers: head!.slice(0, width).map((h) => h.trim()), rows };
  if (Buffer.byteLength(tableToCsv(table), 'utf8') > MAX_IMPORT_BYTES) throw new CsvError('That sheet is larger than 10 MB');
  return table;
}

/**
 * The table as RFC 4180 text — kept as the import's file (30 days, like an upload) and hashed to
 * spot the same file twice. Cells are quoted as they are: this text is read back by `parseCsv`,
 * never opened in a spreadsheet (that is `csvCell`'s job, with its formula guard).
 */
export function tableToCsv(t: ImportTable): string {
  const q = (v: string) => (/[",\r\n]/.test(v) || v !== v.trim() ? `"${v.replace(/"/g, '""')}"` : v);
  return [t.headers, ...t.rows].map((r) => r.map(q).join(',')).join('\n');
}
