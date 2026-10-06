import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CsvError, csvCell, MAX_IMPORT_ROWS, parseCsv } from './csv';
import { autoMap, IMPORT_FIELDS, normalizeRow, parseMoney } from './columns';

const TEMPLATE = readFileSync(join(__dirname, '..', '..', '..', '..', 'docs', 'import', 'listings-template.csv'), 'utf8');

describe('the CSV reader', () => {
  it('reads quotes, doubled quotes, commas and line breaks inside quotes, CRLF and a BOM', () => {
    const { headers, rows } = parseCsv('﻿a,b,c\r\n1,"x, y","he said ""hi"""\r\n2,"line one\nline two",\n');
    expect(headers).toEqual(['a', 'b', 'c']);
    expect(rows).toEqual([
      ['1', 'x, y', 'he said "hi"'],
      ['2', 'line one\nline two', ''],
    ]);
  });
  it('refuses an unclosed quote, an empty file, no data rows, and more than 5,000 rows', () => {
    expect(() => parseCsv('a,b\n1,"oops\n')).toThrow(CsvError);
    expect(() => parseCsv('')).toThrow(/empty/);
    expect(() => parseCsv('a,b\n')).toThrow(/no listings/);
    const big = 'a\n' + Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => String(i)).join('\n');
    expect(() => parseCsv(big)).toThrow(/5,000/);
    expect(parseCsv('a\n' + Array.from({ length: MAX_IMPORT_ROWS }, (_, i) => String(i)).join('\n')).rows).toHaveLength(MAX_IMPORT_ROWS);
  });
});

describe('the report we hand back', () => {
  it('quotes every cell and never lets a spreadsheet run a cell from the uploaded file as a formula', () => {
    expect(csvCell('plain, "quoted"')).toBe('"plain, ""quoted"""');
    for (const evil of ['=HYPERLINK("http://x")', '+1+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1']) {
      expect(csvCell(evil).startsWith(`"'`), evil).toBe(true);
    }
  });
});

describe('the template and its columns', () => {
  const { headers, rows } = parseCsv(TEMPLATE);
  const mapping = autoMap(headers);
  it('the template maps every column by its own name', () => {
    for (const f of IMPORT_FIELDS) expect(mapping[f], f).toBe(headers.indexOf(f));
  });
  it('the three example rows are valid as written', () => {
    for (const r of rows) {
      const out = normalizeRow(r, mapping, 'Australia/Melbourne');
      expect(out.errors, r[0]).toEqual([]);
    }
    const [sale, rent, sold] = rows.map((r) => normalizeRow(r, mapping, 'Australia/Melbourne').row!) as [NonNullable<ReturnType<typeof normalizeRow>['row']>, NonNullable<ReturnType<typeof normalizeRow>['row']>, NonNullable<ReturnType<typeof normalizeRow>['row']>];
    expect(sale.listing).toMatchObject({ priceDisplay: 'Offers over $780,000', priceFrom: 780000, priceTo: 820000 });
    expect(sale.photoUrls).toHaveLength(3);
    expect(sale.agentEmails).toEqual(['jane.citizen@example.com']);
    expect(rent.property).toMatchObject({ unit: '2', streetNumber: '6E' });
    expect(rent.agentEmails).toEqual(['sam.agent@example.com', 'jane.citizen@example.com']);
    expect(sold.status).toBe('sold');
    expect(sold.sold).toMatchObject({ soldPrice: 925000 });
  });
  it('maps common other names', () => {
    const m = autoMap(['ID', 'Beds', 'Photos', 'Agents', 'Weekly Rent']);
    expect(m).toMatchObject({ external_id: 0, bedrooms: 1, photo_urls: 2, agent_emails: 3, rent_pw: 4 });
  });
});

describe('row checks — the form’s own rules, every problem at once, never guessed', () => {
  const headers = [...IMPORT_FIELDS];
  const mapping = autoMap(headers);
  const row = (over: Partial<Record<(typeof IMPORT_FIELDS)[number], string>>) => {
    const base: Record<string, string> = { suburb: 'Pakenham', state: 'VIC', postcode: '3810', street_number: '1', street: 'Main St', channel: 'sale', status: 'live', headline: 'Home', price_display: 'Contact agent' };
    const all = { ...base, ...over };
    return headers.map((h) => all[h] ?? '');
  };
  it('money: whole dollars or $-and-commas only; ranges and shorthand are refused, not guessed', () => {
    expect(parseMoney('850000')).toBe(850000);
    expect(parseMoney('$850,000')).toBe(850000);
    for (const bad of ['$1.2m', '850k', 'Offers over', '1,2,3.456']) expect(parseMoney(bad)).toBe('invalid');
    const out = normalizeRow(row({ price_from: '$1.2m' }), mapping, 'UTC');
    expect(out.row).toBeNull();
    expect(out.errors[0]!.message).toMatch(/whole dollars/);
  });
  it('dates are YYYY-MM-DD; 03/04/2026 is never guessed', () => {
    expect(normalizeRow(row({ listed_on: '03/04/2026' }), mapping, 'UTC').errors[0]!.message).toMatch(/YYYY-MM-DD/);
  });
  it('a sold row needs a price above 0 and a date not in the future; a live row may not carry them', () => {
    expect(normalizeRow(row({ status: 'sold' }), mapping, 'UTC').row).toBeNull();
    expect(normalizeRow(row({ status: 'sold', sold_price: '900000', sold_date: '2099-01-01' }), mapping, 'UTC').row).toBeNull();
    expect(normalizeRow(row({ status: 'sold', sold_price: '900000', sold_date: '2025-01-01' }), mapping, 'UTC').row?.sold?.soldPrice).toBe(900000);
    expect(normalizeRow(row({ sold_price: '900000' }), mapping, 'UTC').row).toBeNull();
  });
  it('rent needs weekly rent; sale needs some price statement; unknown status, type, state refused', () => {
    expect(normalizeRow(row({ channel: 'rent', price_display: '' }), mapping, 'UTC').row).toBeNull();
    expect(normalizeRow(row({ price_display: '' }), mapping, 'UTC').row).toBeNull();
    expect(normalizeRow(row({ status: 'Current' }), mapping, 'UTC').row).toBeNull();
    expect(normalizeRow(row({ property_type: 'castle' }), mapping, 'UTC').row).toBeNull();
    expect(normalizeRow(row({ state: 'XYZ' }), mapping, 'UTC').row).toBeNull();
  });
  it('photo links must be web links; agent emails must be emails; all errors reported together', () => {
    const out = normalizeRow(row({ photo_urls: 'file:///etc/passwd|https://ok.example/a.jpg', agent_emails: 'not-an-email', headline: '' }), mapping, 'UTC');
    expect(out.row).toBeNull();
    expect(out.errors.map((e) => e.column)).toEqual(expect.arrayContaining(['Headline', 'Photo links', 'Agent emails']));
  });
});
