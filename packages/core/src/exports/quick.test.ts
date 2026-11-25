import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { parseCsv } from '../imports/csv';
import { autoMap, normalizeRow, IMPORT_FIELDS } from '../imports/columns';
import { contactAutoMap, normalizeContactRow, CONTACT_IMPORT_FIELDS } from '../imports/contact-columns';
import { CONTACT_EXPORT_HEADERS, EXPORT_PAGE, ExportError, LISTING_EXPORT_HEADERS, startQuickExport } from './quick';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const owner: Actor = { userId: 'u-owner', agencyId: A, membershipRole: 'owner' };
const agent: Actor = { userId: 'u-agent', agencyId: A, membershipRole: 'agent' };

/** Records every WHERE, the audit insert and its update; each awaited select takes the next queued result. */
function fakeDb(results: unknown[][]) {
  const dialect = new PgDialect();
  const wheres: { sql: string; params: unknown[] }[] = [];
  const audits: Record<string, unknown>[] = [];
  const updates: { sql: string; params: unknown[] }[] = [];
  const select = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'innerJoin', 'leftJoin', 'orderBy', 'limit', 'offset']) chain[m] = () => chain;
    chain.where = (c: SQL) => {
      wheres.push(dialect.sqlToQuery(c));
      return chain;
    };
    chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(results.shift() ?? []).then(res, rej);
    return chain;
  };
  const db = {
    select,
    insert: () => ({ values: (v: Record<string, unknown>) => (audits.push(v), { returning: async () => [{ id: 'audit-1' }] }) }),
    update: () => ({ set: (v: { detail: SQL }) => ({ where: async () => void updates.push(dialect.sqlToQuery(v.detail)) }) }),
  };
  return { db: db as unknown as Db, wheres, audits, updates };
}

async function drain(gen: AsyncGenerator<string>): Promise<string> {
  let out = '';
  for await (const c of gen) out += c;
  return out;
}

const TZ = [{ tz: 'Australia/Melbourne' }];

const contactRow = (over: Record<string, unknown> = {}) => ({
  id: '0190a000-0000-7000-8000-000000000001',
  name: 'Olivia Bennett',
  email: 'olivia@example.com',
  phone: '0411 222 333',
  addressLine: '9 Glenferrie Road',
  suburb: 'Hawthorn',
  state: 'VIC',
  postcode: '3122',
  roles: '{buyer,past_client}',
  assignedEmail: 'sam@agency.test',
  nextAction: 'Call about the auction',
  nextActionAt: new Date('2026-12-01T22:00:00Z'), // 2 Dec, 9 am in Melbourne
  source: 'manual',
  archivedAt: null,
  createdAt: new Date('2026-11-01T00:00:00Z'),
  ...over,
});

const listingRow = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  externalId: 'AG-1001',
  unit: null,
  streetNumber: '14',
  street: 'Henry Street',
  suburb: 'Pakenham',
  state: 'VIC',
  postcode: '3810',
  propertyType: 'house',
  bedrooms: 4,
  bathrooms: '2.0',
  carSpaces: 2,
  landAreaSqm: '612.00',
  buildingAreaSqm: null,
  yearBuilt: 2008,
  channel: 'sale',
  status: 'live',
  headline: 'Family home walking distance to the station',
  description: 'Four bedrooms, "two" living areas,\nand a yard.',
  priceDisplay: 'Offers over $780,000',
  priceFrom: '780000.00',
  priceTo: '820000.00',
  rentPw: null,
  availableFrom: null,
  auctionDate: new Date('2027-02-13T00:00:00Z'), // 11:00 AEDT
  publishedAt: new Date('2026-09-19T15:00:00Z'), // 20 Sep in Melbourne
  soldPrice: null,
  soldDate: null,
  createdAt: new Date('2026-09-19T15:00:00Z'),
  agentEmails: 'jane@agency.test;sam@agency.test',
  photos: ['listing/aaaa/front.jpg', 'listing/aaaa/kitchen.jpg'],
  floorplans: null,
  videos: ['youtube:dQw4w9WgXcQ'],
  tours: null,
  openHomes: [['2027-02-06T23:00:00+00:00', '2027-02-06T23:30:00+00:00']], // Sun 7 Feb 10:00-10:30 AEDT
};

beforeEach(() => vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://media.example.test'));
afterEach(() => vi.unstubAllEnvs());

describe('quick export (ADR 0101)', () => {
  it('refuses an actor with no agency, or a platform view, before reading or logging anything', async () => {
    for (const actor of [{ userId: 'x' }, { ...owner, via: 'platform' as const, viewerId: 'p' }] as Actor[]) {
      const f = fakeDb([]);
      await expect(startQuickExport(f.db, actor, 'contacts')).rejects.toBeInstanceOf(ExportError);
      expect(f.wheres).toHaveLength(0);
      expect(f.audits).toHaveLength(0);
    }
  });

  it("narrows an agent's customers to their own and not an owner's", async () => {
    const a = fakeDb([TZ, []]);
    await drain((await startQuickExport(a.db, agent, 'contacts')).chunks);
    expect(a.wheres[1]!.sql).toContain('c.assigned_to = ');
    expect(a.wheres[1]!.params).toContain('u-agent');
    expect(a.audits[0]!.detail).toMatchObject({ dataset: 'contacts', scope: 'own' });

    const o = fakeDb([TZ, []]);
    await drain((await startQuickExport(o.db, owner, 'contacts')).chunks);
    expect(o.wheres[1]!.sql).not.toContain('c.assigned_to = ');
    expect(o.wheres[1]!.params).toContain(A);
    expect(o.wheres[1]!.params).not.toContain(B);
    expect(o.audits[0]!.detail).toMatchObject({ scope: 'agency' });
  });

  it("narrows an agent's listings to the ones they are named on, and not an owner's", async () => {
    const a = fakeDb([TZ, []]);
    await drain((await startQuickExport(a.db, agent, 'listings')).chunks);
    expect(a.wheres[1]!.sql).toContain('"listing_agent"');
    expect(a.wheres[1]!.params).toContain('u-agent');
    const o = fakeDb([TZ, []]);
    await drain((await startQuickExport(o.db, owner, 'listings')).chunks);
    expect(o.wheres[1]!.sql).not.toContain('"listing_agent"');
  });

  it('keeps the directory filters, so the file is the rows the screen selected', async () => {
    const f = fakeDb([TZ, []]);
    await drain((await startQuickExport(f.db, owner, 'contacts', { role: 'buyer', archived: 'all', page: 3 })).chunks);
    expect(f.wheres[1]!.sql).toContain('r.role = ');
    expect(f.wheres[1]!.params).toContain('buyer');
    expect(f.audits[0]!.detail).toMatchObject({ filters: ['role', 'archived'] });
  });

  it('writes a BOM, the headers, and a formula-safe cell; logs the count when done', async () => {
    const f = fakeDb([TZ, [contactRow({ name: '=HYPERLINK("http://evil.test","x")' })]]);
    const { filename, chunks } = await startQuickExport(f.db, owner, 'contacts');
    const csv = await drain(chunks);
    expect(filename).toMatch(/^customers-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(csv.startsWith('﻿"name","email"')).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.test"",""x"")"`);
    expect(f.updates[0]!.params.join()).toContain('"rows":1,"complete":true');
  });

  it('pages by id until a short page, never by offset', async () => {
    const full = Array.from({ length: EXPORT_PAGE }, (_, i) => contactRow({ id: `0190a000-0000-7000-8000-${String(i).padStart(12, '0')}` }));
    const f = fakeDb([TZ, full, [contactRow({ id: 'ffffffff-0000-7000-8000-000000000000' })]]);
    const csv = await drain((await startQuickExport(f.db, owner, 'contacts')).chunks);
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(EXPORT_PAGE + 2);
    expect(f.wheres[2]!.params).toContain(full[EXPORT_PAGE - 1]!.id);
    expect(f.updates[0]!.params.join()).toContain(`"rows":${EXPORT_PAGE + 1}`);
  });

  it('logs how far a cut download got', async () => {
    const f = fakeDb([TZ, [contactRow()]]);
    const { chunks } = await startQuickExport(f.db, owner, 'contacts');
    await chunks.next(); // the header
    await chunks.return(undefined);
    expect(f.updates[0]!.params.join()).toContain('"rows":0,"complete":false');
  });

  it('a customer row goes back in through the contacts import unchanged', async () => {
    const f = fakeDb([TZ, [contactRow()]]);
    const { headers, rows } = parseCsv((await drain((await startQuickExport(f.db, owner, 'contacts')).chunks)).slice(1));
    expect(headers).toEqual([...CONTACT_EXPORT_HEADERS]);
    const mapping = contactAutoMap(headers);
    for (const field of CONTACT_IMPORT_FIELDS.filter((x) => !['first_name', 'last_name', 'note'].includes(x))) expect(mapping[field]).not.toBeNull();
    const { row, errors } = normalizeContactRow(rows[0]!, mapping, 'Australia/Melbourne');
    expect(errors).toEqual([]);
    expect(row).toMatchObject({
      name: 'Olivia Bennett', email: 'olivia@example.com', phone: '0411 222 333', addressLine: '9 Glenferrie Road', addressSuburb: 'Hawthorn',
      roles: ['buyer', 'past_client'], assignedEmail: 'sam@agency.test', nextAction: 'Call about the auction', nextActionAt: '2026-12-01T22:00:00.000Z',
    });
  });

  it('a listing row goes back in through the listings import with the same facts, links and times', async () => {
    const f = fakeDb([TZ, [listingRow]]);
    const csv = await drain((await startQuickExport(f.db, owner, 'listings')).chunks);
    const { headers, rows } = parseCsv(csv.slice(1));
    expect(headers).toEqual([...LISTING_EXPORT_HEADERS]);
    const mapping = autoMap(headers);
    for (const field of IMPORT_FIELDS) expect(mapping[field]).not.toBeNull();
    const { row, errors, warnings } = normalizeRow(rows[0]!, mapping, 'Australia/Melbourne');
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(row).toMatchObject({
      externalId: 'AG-1001',
      status: 'live',
      listedOn: '2026-09-20',
      agentEmails: ['jane@agency.test', 'sam@agency.test'],
      photoUrls: ['https://media.example.test/storage/v1/object/public/media/listing/aaaa/front.jpg', 'https://media.example.test/storage/v1/object/public/media/listing/aaaa/kitchen.jpg'],
      mediaLinks: ['https://youtu.be/dQw4w9WgXcQ'],
      openHomes: [{ startsAt: '2027-02-06T23:00:00.000Z', endsAt: '2027-02-06T23:30:00.000Z' }],
    });
    expect(row!.property).toMatchObject({ streetNumber: '14', bedrooms: 4, bathrooms: 2, landAreaSqm: 612 });
    expect(row!.listing).toMatchObject({ priceFrom: 780000, priceTo: 820000, auctionDate: '2027-02-13T00:00:00.000Z', description: 'Four bedrooms, "two" living areas,\nand a yard.' });
  });
});
