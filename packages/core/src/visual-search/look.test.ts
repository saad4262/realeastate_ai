import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Db } from '@repo/db';
import { embedPhotoBatch, FILLING_UP_AT, homesThatLookLike, lookAskFromParams, lookAskSchema, lookPageHref, lookToolResult, vectorLiteral, visualEmbedEnabled, VISUAL_DIMENSIONS, type ImageEmbedder } from './look';

vi.mock('../media/media-url', () => ({ mediaUrl: (key: string) => `https://cdn.test/${key}` }));
const dialect = new PgDialect();

const VEC = Array.from({ length: VISUAL_DIMENSIONS }, (_, i) => (i % 7) / 7);
const fakeEmbedder = (over: Partial<ImageEmbedder> = {}): ImageEmbedder => ({
  model: 'voyage-multimodal-3.5',
  embedImages: vi.fn(async (urls: string[]) => urls.map(() => VEC)),
  embedQuery: vi.fn(async () => VEC),
  ...over,
});
/** A db whose execute() answers in order and records each statement. */
function scriptedDb(answers: unknown[][]) {
  const statements: string[] = [];
  const db = {
    execute: async (q: SQL) => {
      statements.push(dialect.sqlToQuery(q).sql);
      return answers.shift() ?? [];
    },
  } as unknown as Db;
  return { db, statements };
}
const ROW = { listing_id: 'l1', media_id: 'm1', storage_key: 'listings/l1/a.jpg', caption: 'Kitchen', street: '22 Lakeview Drive', suburb: 'Officer', state: 'VIC', channel: 'sale', price_display: 'Offers over $760,000', price_from: '760000', price_to: null, rent_pw: null, bedrooms: 3, property_type: 'house' };

describe('Visual Search: what a buyer may ask (ADR 0080, C9 decision 9)', () => {
  it('words or one photo id — not both, not neither; no upload field exists', () => {
    expect(lookAskSchema.safeParse({ words: 'light-filled kitchen, timber floors' }).success).toBe(true);
    expect(lookAskSchema.safeParse({ photoId: '6f1f7a2e-3c1b-4f7e-9a51-1d2e3f4a5b6c' }).success).toBe(true);
    expect(lookAskSchema.safeParse({}).success).toBe(false);
    expect(lookAskSchema.safeParse({ words: 'timber floors', photoId: '6f1f7a2e-3c1b-4f7e-9a51-1d2e3f4a5b6c' }).success).toBe(false);
    expect(lookAskSchema.safeParse({ imageBase64: 'iVBOR…' }).success).toBe(false);
    expect(lookAskSchema.safeParse({ imageUrl: 'https://x/y.jpg' }).success).toBe(false);
    expect(lookAskSchema.safeParse({ words: 'ab' }).success).toBe(false);
    expect(lookAskSchema.parse({ words: '  big\n\nbacky ard ' }).words).toBe('big backy ard');
  });
  it('a vector is 1024 finite numbers, or nothing', () => {
    expect(vectorLiteral(VEC)?.startsWith('[0,0.14')).toBe(true);
    expect(vectorLiteral(VEC.slice(1))).toBeNull();
    expect(vectorLiteral([...VEC.slice(1), Number.NaN])).toBeNull();
    expect(vectorLiteral('[1,2]')).toBeNull();
  });
  it('the embedding batch is off unless switched on explicitly', () => {
    expect(visualEmbedEnabled({})).toBe(false);
    expect(visualEmbedEnabled({ VISUAL_EMBED_ENABLED: 'off' })).toBe(false);
    expect(visualEmbedEnabled({ VISUAL_EMBED_ENABLED: 'yes please' })).toBe(false);
    expect(visualEmbedEnabled({ VISUAL_EMBED_ENABLED: 'on' })).toBe(true);
  });
});

describe('Visual Search: the search (decisions 10–11)', () => {
  it('below 500 searchable photos it says so — and never calls the embedder', async () => {
    const e = fakeEmbedder();
    const { db, statements } = scriptedDb([[{ photos: 1, searchable: 0 }]]);
    expect(await homesThatLookLike(db, lookAskSchema.parse({ words: 'timber floors' }), { embedder: e })).toEqual({ status: 'filling_up', photos: 1, searchable: 0, threshold: FILLING_UP_AT });
    expect(e.embedQuery).not.toHaveBeenCalled();
    expect(statements).toHaveLength(1);
  });
  it('words: one query embedding, two reads; the filters are in the SQL; the card has no score', async () => {
    const e = fakeEmbedder();
    const { db, statements } = scriptedDb([[{ photos: 600, searchable: 600 }], [ROW]]);
    const out = await homesThatLookLike(db, lookAskSchema.parse({ words: 'timber floors', suburbs: ['Officer'], priceTo: 800000, bedrooms: 3 }), { embedder: e });
    expect(e.embedQuery).toHaveBeenCalledTimes(1);
    expect(statements).toHaveLength(2);
    expect(statements[1]).toMatch(/l\.status = /);
    expect(statements[1]).toMatch(/lower\(p\.suburb\) in/);
    expect(statements[1]).toMatch(/<= /);
    expect(out.status === 'found' && out.homes[0]).toMatchObject({ listingId: 'l1', price: 'Offers over $760,000', photo: { mediaId: 'm1', caption: 'Kitchen' } });
    expect(JSON.stringify(out)).not.toMatch(/distance|score|similarity|percent/i);
  });
  it('a photo: its own stored vector (no embedder call), its own listing left out; not public → not found', async () => {
    const e = fakeEmbedder();
    const { db, statements } = scriptedDb([[{ photos: 600, searchable: 600 }], [{ vector: vectorLiteral(VEC), listing_id: 'l0' }], [ROW]]);
    const out = await homesThatLookLike(db, lookAskSchema.parse({ photoId: '6f1f7a2e-3c1b-4f7e-9a51-1d2e3f4a5b6c' }), { embedder: null });
    expect(out.status).toBe('found');
    expect(e.embedQuery).not.toHaveBeenCalled();
    expect(statements[2]).toMatch(/l\.id <> /);
    const none = scriptedDb([[{ photos: 600, searchable: 600 }], []]);
    expect((await homesThatLookLike(none.db, lookAskSchema.parse({ photoId: '6f1f7a2e-3c1b-4f7e-9a51-1d2e3f4a5b6c' }), { embedder: e })).status).toBe('photo_not_found');
  });
  it('no embedder, a failed call or a malformed vector is "unavailable" — never a guess', async () => {
    const ask = lookAskSchema.parse({ words: 'timber floors' });
    expect((await homesThatLookLike(scriptedDb([[{ photos: 600, searchable: 600 }]]).db, ask, { embedder: null })).status).toBe('unavailable');
    expect((await homesThatLookLike(scriptedDb([[{ photos: 600, searchable: 600 }]]).db, ask, { embedder: fakeEmbedder({ embedQuery: async () => { throw new Error('429'); } }) })).status).toBe('unavailable');
    expect((await homesThatLookLike(scriptedDb([[{ photos: 600, searchable: 600 }]]).db, ask, { embedder: fakeEmbedder({ embedQuery: async () => [1, 2, 3] }) })).status).toBe('unavailable');
  });
  it('the guide’s result: facts and the rules, no distance or score', () => {
    const r = lookToolResult({ status: 'found', basis: 'words', homes: [{ listingId: 'l1', address: '22 Lakeview Drive, Officer', suburb: 'Officer', state: 'VIC', price: '$1', bedrooms: 3, propertyType: 'house', photo: { mediaId: 'm1', url: 'https://cdn/x.jpg', caption: 'Kitchen' } }], searchable: 600 }, '/look?words=x');
    expect(JSON.stringify(r)).not.toMatch(/distance|score"|similarity|cdn/);
    expect(r.rules).toMatch(/never give a score/);
    expect(lookToolResult({ status: 'filling_up', photos: 1, searchable: 0, threshold: 500 }, '/look').note).toMatch(/still filling up: 0 searchable photos/);
  });
});

describe('Visual Search: the embedding batch (decision 8; off by default — the user)', () => {
  it('off: removes the vectors of listings no longer public, and embeds nothing', async () => {
    const e = fakeEmbedder();
    const { db, statements } = scriptedDb([[{ media_id: 'gone' }]]);
    expect(await embedPhotoBatch(db, e, { enabled: false })).toEqual({ removed: 1, embedded: 0, skipped: 'off' });
    expect(statements[0]).toMatch(/delete from media_embedding/);
    expect(e.embedImages).not.toHaveBeenCalled();
  });
  it('on: the oldest public photos without a vector, one call, one insert', async () => {
    const e = fakeEmbedder();
    const { db, statements } = scriptedDb([[], [{ n: 0 }], [{ media_id: 'm1', listing_id: 'l1', storage_key: 'listings/l1/a.jpg' }, { media_id: 'm2', listing_id: 'l1', storage_key: 'listings/l1/b.jpg' }], []]);
    expect(await embedPhotoBatch(db, e, { enabled: true })).toEqual({ removed: 0, embedded: 2, skipped: null });
    expect(e.embedImages).toHaveBeenCalledTimes(1);
    expect(statements[3]).toMatch(/insert into media_embedding/);
  });
  it('the daily cap stops it; a failed or short answer writes nothing', async () => {
    const e = fakeEmbedder();
    expect((await embedPhotoBatch(scriptedDb([[], [{ n: 2000 }]]).db, e, { enabled: true })).skipped).toBe('daily_cap');
    expect(e.embedImages).not.toHaveBeenCalled();
    const due = [{ media_id: 'm1', listing_id: 'l1', storage_key: 'listings/l1/a.jpg' }];
    const failing = scriptedDb([[], [{ n: 0 }], due]);
    expect((await embedPhotoBatch(failing.db, fakeEmbedder({ embedImages: async () => { throw new Error('500'); } }), { enabled: true })).skipped).toBe('failed');
    expect(failing.statements).toHaveLength(3);
    const short = scriptedDb([[], [{ n: 0 }], due]);
    expect((await embedPhotoBatch(short.db, fakeEmbedder({ embedImages: async () => [] }), { enabled: true })).skipped).toBe('failed');
    expect((await embedPhotoBatch(scriptedDb([[], [{ n: 0 }], due]).db, null, { enabled: true })).skipped).toBe('no_embedder');
  });
});

describe('Visual Search: the page address (decision 9)', () => {
  it('round-trips words and filters; a photo id; junk asks nothing', () => {
    const ask = lookAskFromParams({ words: 'timber floors', suburb: 'Officer, Pakenham', state: 'vic', price: '800000', beds: '3' })!;
    expect(ask).toMatchObject({ words: 'timber floors', suburbs: ['Officer', 'Pakenham'], state: 'VIC', priceTo: 800000, bedrooms: 3, channel: 'sale' });
    expect(lookAskFromParams(Object.fromEntries(new URL(`https://x${lookPageHref(ask)}`).searchParams))).toEqual(ask);
    expect(lookAskFromParams({ photo: '6f1f7a2e-3c1b-4f7e-9a51-1d2e3f4a5b6c' })?.photoId).toBe('6f1f7a2e-3c1b-4f7e-9a51-1d2e3f4a5b6c');
    expect(lookAskFromParams({})).toBeNull();
    expect(lookAskFromParams({ photo: 'x' })).toBeNull();
    expect(lookAskFromParams({ words: 'timber floors', state: 'XX' })).toBeNull();
  });
});
