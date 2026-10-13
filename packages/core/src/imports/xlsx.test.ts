import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CsvError } from './csv';
import { createImportFromXlsx, tableFromXlsx } from './xlsx';

/** ADR 0029 amendment: an Excel workbook becomes the same table a CSV of it would be. */

const fixture = () => {
  const b = readFileSync(join(__dirname, '__fixtures__', 'listings.xlsx'));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

describe('tableFromXlsx', () => {
  it('reads the first sheet with anything in it — numbers as digits, dates in the importer’s own forms', async () => {
    const r = await tableFromXlsx(fixture());
    expect(r.sheet).toBe('Stock');
    expect(r.sheets).toEqual(['Stock', 'Notes']);
    expect(r.table.headers).toEqual(['Address', 'Suburb', 'Beds', 'Listed on', 'Auction']);
    expect(r.table.rows).toEqual([
      ['1 George St', 'Ryde', '3', '2026-11-14', '2026-11-14 11:00'],
      ['2/14 Smith St', 'Ryde', '2', '', ''],
    ]);
  });

  it('reads the sheet asked for, whatever its case, and names the sheets when it is not there', async () => {
    expect((await tableFromXlsx(fixture(), 'notes')).table.headers).toEqual(['Notes']);
    await expect(tableFromXlsx(fixture(), 'Rentals')).rejects.toThrow(/no sheet called “Rentals”.*Stock, Notes/);
  });

  it('refuses a file that is not a workbook, before trying to unzip it', async () => {
    const csv = new TextEncoder().encode('Address,Suburb\n1 George St,Ryde\n').buffer as ArrayBuffer;
    await expect(tableFromXlsx(csv)).rejects.toBeInstanceOf(CsvError);
    await expect(tableFromXlsx(csv)).rejects.toThrow(/not an Excel/);
  });

  it('a broken zip is a plain-words refusal, not a crash', async () => {
    const broken = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6]).buffer as ArrayBuffer;
    await expect(tableFromXlsx(broken)).rejects.toThrow(/could not be read/);
  });
});

describe('createImportFromXlsx', () => {
  const db = new Proxy({}, { get: () => { throw new Error('the database was asked'); } }) as never;
  it('a read-only member is refused before the file is opened or the database asked', async () => {
    await expect(createImportFromXlsx(db, { userId: 'u', agencyId: 'a', membershipRole: 'read_only' }, { fileName: 'x.xlsx', bytes: fixture() })).rejects.toThrow(/cannot import/);
  });
});
