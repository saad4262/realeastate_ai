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
