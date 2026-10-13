import readXlsxFile from 'read-excel-file/universal';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { CsvError, MAX_IMPORT_BYTES, tableFromCells, type ImportTable } from './csv';
import { assertMayImport, createImportFromTable, ImportError, type CreatedImport, type ImportKind, type ImportMode } from './imports';

/**
 * An Excel workbook (.xlsx) as an import table (ADR 0029 amendment). Read on the server with
 * `read-excel-file` (pinned; MIT; the `/universal` build — no worker threads, which a serverless
 * function may not have). One sheet: the one named, else the first with anything in it.
 *
 * Cells become what a CSV of the same sheet would hold: numbers as plain digits, TRUE/FALSE, and
 * dates in the importer's own forms — `YYYY-MM-DD`, or `YYYY-MM-DD HH:mm` when the cell has a
 * time. Excel stores a date as the wall-clock day and time, which the library hands back as that
 * instant in UTC, so the UTC parts ARE what the person typed.
 */

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return '';
    const day = v.toISOString().slice(0, 10);
    const hm = v.toISOString().slice(11, 16);
    return hm === '00:00' ? day : `${day} ${hm}`;
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

export async function tableFromXlsx(bytes: ArrayBuffer, sheet?: string | null): Promise<{ table: ImportTable; sheet: string; sheets: string[] }> {
  if (bytes.byteLength > MAX_IMPORT_BYTES) throw new CsvError('That file is larger than 10 MB');
  const head = new Uint8Array(bytes.slice(0, 4));
  if (!ZIP_MAGIC.every((b, i) => head[i] === b)) throw new CsvError('That is not an Excel (.xlsx) file. Save it as .xlsx or CSV and try again.');
  let sheets: { sheet: string; data: unknown[][] }[];
  try {
    sheets = (await readXlsxFile(bytes)) as unknown as { sheet: string; data: unknown[][] }[];
  } catch {
    throw new CsvError('That Excel file could not be read. Open it in Excel, save it again as .xlsx (or CSV), and try again.');
  }
  const names = sheets.map((s) => s.sheet);
  const wanted = sheet?.trim();
  const chosen = wanted
    ? sheets.find((s) => s.sheet === wanted) ?? sheets.find((s) => s.sheet.toLowerCase() === wanted.toLowerCase())
    : sheets.find((s) => s.data.some((r) => Array.isArray(r) && r.some((c) => cellText(c).trim() !== '')));
  if (!chosen) {
    throw new CsvError(wanted ? `There is no sheet called “${wanted}”. Its sheets are: ${names.join(', ')}.` : 'The workbook is empty');
  }
  const table = tableFromCells(chosen.data.map((r) => (Array.isArray(r) ? r.map(cellText) : [])));
  return { table, sheet: chosen.sheet, sheets: names };
}

/** Upload an Excel file: read it now, then exactly the CSV import (map → check → import). */
export async function createImportFromXlsx(
  db: Db,
  actor: Actor,
  input: { fileName: string; bytes: ArrayBuffer; sheet?: string | null; mode?: ImportMode; kind?: ImportKind },
): Promise<CreatedImport> {
  const kind = input.kind ?? 'listings';
  // Who may import is asked before the file is opened.
  assertMayImport(actor, kind);
  let read: Awaited<ReturnType<typeof tableFromXlsx>>;
  try {
    read = await tableFromXlsx(input.bytes, input.sheet);
  } catch (err) {
    if (err instanceof CsvError) throw new ImportError('invalid', err.message);
    throw err;
  }
  const name = input.fileName.slice(0, 160) || 'import.xlsx';
  return createImportFromTable(db, actor, {
    fileName: read.sheets.length > 1 ? `${name} — ${read.sheet}` : name,
    table: read.table,
    ...(input.mode ? { mode: input.mode } : {}),
    source: 'xlsx',
    kind,
  });
}
