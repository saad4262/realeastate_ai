import { describe, expect, it } from 'vitest';
import { fakeFetch } from '../integrations/fake-fetch';
import { ProviderError } from '../integrations/provider-http';
import { CsvError, parseCsv, tableFromCells, tableToCsv } from './csv';
import { createImportFromSheet, googleSheetsApi, pickerSession, sheetsDepsFromEnv } from './sheets';

/** ADR 0029 amendment: a picked Google Sheet (or a workbook) becomes exactly a CSV upload. */

describe('tableFromCells — a sheet looks like a parsed CSV', () => {
  it('makes every cell a string, rows as wide as the headers, and drops blank rows', () => {
    const t = tableFromCells([
      ['Address', 'Suburb ', 'Beds', '', ''],
      ['1 George St', 'Ryde', 3],
      [],
      ['', '', ''],
      ['2/14 Smith St', 'Ryde', null, 'stray'],
    ]);
    expect(t.headers).toEqual(['Address', 'Suburb', 'Beds', '']);
    expect(t.rows).toEqual([
      ['1 George St', 'Ryde', '3', ''],
      ['2/14 Smith St', 'Ryde', '', 'stray'],
    ]);
  });

  it('says what is wrong in the CSV import’s own words', () => {
    expect(() => tableFromCells([])).toThrow(CsvError);
    expect(() => tableFromCells([['Address']])).toThrow(/header row but no listings/);
    // Blank rows above the headers are skipped: the first row with anything in it is the header row.
    expect(tableFromCells([['', ''], ['Address', 'Suburb'], ['1 George St', 'Ryde']]).headers).toEqual(['Address', 'Suburb']);
    expect(() => tableFromCells([['A'], ...Array.from({ length: 6 }, () => ['x'])], 5)).toThrow(/At most 5 rows/);
  });

  it('round-trips through the CSV text it is stored as — quotes, commas, line breaks and spaces kept', () => {
    const t = tableFromCells([
      ['Address', 'Price', 'Note'],
      ['1 "Big" House, Ryde', 'Offers over $950,000', 'line one\nline two'],
      [' padded ', '=SUM(A1)', ''],
    ]);
    const back = parseCsv(tableToCsv(t));
    expect(back.headers).toEqual(t.headers);
    expect(back.rows).toEqual(t.rows);
    // Stored text is data: no formula guard is added (that is csvCell's job, for files people open).
    expect(back.rows[1]![1]).toBe('=SUM(A1)');
  });
});

describe('the Google Sheets calls', () => {
  it('lists a file’s tabs: titles only, with the bearer token, the file id escaped', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { properties: { title: 'Stock list' }, sheets: [{ properties: { title: 'Sale', gridProperties: { rowCount: 120 } } }, { properties: { title: 'Rent' } }] } }]);
    const out = await googleSheetsApi(impl).file('tok', 'abcDEF123_-xyz');
    expect(out).toEqual({ title: 'Stock list', tabs: [{ title: 'Sale', rows: 120 }, { title: 'Rent', rows: 0 }] });
    expect(calls[0]!.url).toMatch(/^https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\/abcDEF123_-xyz\?fields=/);
    expect(calls[0]!.headers.authorization).toBe('Bearer tok');
  });

  it('reads one tab as the person sees it — the tab name quoted, formatted values, rows first', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { values: [['Address'], ['1 George St']] } }]);
    const cells = await googleSheetsApi(impl).values('tok', 'abcDEF123_-xyz', "Bob's tab");
    expect(cells).toEqual([['Address'], ['1 George St']]);
    const url = decodeURIComponent(calls[0]!.url);
    expect(url).toContain("/values/'Bob''s tab'?");
    expect(url).toContain('valueRenderOption=FORMATTED_VALUE');
    expect(url).toContain('majorDimension=ROWS');
  });

  it('an empty tab is no rows; a refusal is a ProviderError with its status', async () => {
    expect(await googleSheetsApi(fakeFetch([{ status: 200, body: {} }]).impl).values('t', 'abcDEF123_-xyz', 'S')).toEqual([]);
    await expect(googleSheetsApi(fakeFetch([{ status: 404, body: { error: { status: 'NOT_FOUND' } } }]).impl).file('t', 'abcDEF123_-xyz')).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('sheetsDepsFromEnv', () => {
  const keys = { current: Buffer.alloc(32) } as never;
  it('needs the token key; the Picker needs its browser key AND a numeric project number', () => {
    expect(sheetsDepsFromEnv(null, {} as NodeJS.ProcessEnv)).toBeNull();
    expect(sheetsDepsFromEnv(keys, {} as NodeJS.ProcessEnv)!.picker).toBeNull();
    expect(sheetsDepsFromEnv(keys, { GOOGLE_PICKER_API_KEY: 'k', GOOGLE_CLOUD_PROJECT_NUMBER: 'my-project' } as NodeJS.ProcessEnv)!.picker).toBeNull();
    expect(sheetsDepsFromEnv(keys, { GOOGLE_PICKER_API_KEY: 'k', GOOGLE_CLOUD_PROJECT_NUMBER: '123456789012' } as NodeJS.ProcessEnv)!.picker).toEqual({ apiKey: 'k', appId: '123456789012' });
  });
});

describe('who may have a Picker token (pickerSession)', () => {
  const db = new Proxy({}, { get: () => { throw new Error('the database was asked'); } }) as never;
  const deps = { keys: { current: Buffer.alloc(32) } as never, picker: { apiKey: 'k', appId: '1' } };
  it('a read-only member gets none — refused before the database or Google is asked', async () => {
    const out = await pickerSession(db, { userId: 'u', agencyId: 'a', membershipRole: 'read_only' }, deps);
    expect(out).toEqual({ ok: false, error: 'You cannot import here.' });
  });
  it('without the Picker settings, nobody gets one — and the reason names them', async () => {
    const out = await pickerSession(db, { userId: 'u', agencyId: 'a', membershipRole: 'agent' }, { ...deps, picker: null });
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).toMatch(/GOOGLE_PICKER_API_KEY/);
  });
  it('someone outside any agency gets none', async () => {
    expect((await pickerSession(db, { userId: 'u' }, deps)).ok).toBe(false);
  });
});

describe('createImportFromSheet asks who may import BEFORE Google is asked', () => {
  const db = new Proxy({}, { get: () => { throw new Error('the database was asked'); } }) as never;
  const deps = { keys: { current: Buffer.alloc(32) } as never, picker: null };
  const api = { file: () => { throw new Error('Google was asked'); }, values: () => { throw new Error('Google was asked'); } };
  it('a read-only member: refused for the kind they asked, Google and the database never touched', async () => {
    const ro = { userId: 'u', agencyId: 'a', membershipRole: 'read_only' as const };
    await expect(createImportFromSheet(db, ro, { spreadsheetId: 'abcDEF123_-xyz', tab: 'Sale', kind: 'contacts' }, deps, api)).rejects.toThrow(/cannot import contacts/);
    await expect(createImportFromSheet(db, ro, { spreadsheetId: 'abcDEF123_-xyz', tab: 'Sale' }, deps, api)).rejects.toThrow(/cannot import listings/);
  });
});
