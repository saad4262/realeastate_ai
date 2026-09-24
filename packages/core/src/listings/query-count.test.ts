import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import { listAgencyListings, getListingForEdit } from './list-listings';
import { searchPublicListings, liveSuburbs, livePropertyTypes } from './search-listings';
import type { Actor } from '../permissions';

/**
 * How many times each read talks to the database.
 *
 * These numbers are the point. An N+1 does not break a test that checks the
 * rows — it returns exactly the right answer, and costs a round trip per row to
 * a database in another region. It shows up as "the app got slow" months later,
 * with nothing to point at.
 *
 * Every number here was measured, not guessed. When one of them changes, the
 * question is whether the extra query is worth it — not whether the test is
 * wrong.
 */
/**
 * Three rows, because zero rows hide an N+1.
 *
 * The first version of this file returned an empty array and a deliberately
 * introduced per-row query went unnoticed — the loop never ran. A fake that
 * returns nothing cannot catch a bug that costs one query per row.
 */
const THREE_ROWS = [
  { id: 'l-1', suburb: 'Pakenham', state: 'VIC', postcode: '3810', channel: 'sale', status: 'live', agentNames: [] },
  { id: 'l-2', suburb: 'Pakenham', state: 'VIC', postcode: '3810', channel: 'sale', status: 'live', agentNames: [] },
  { id: 'l-3', suburb: 'Officer', state: 'VIC', postcode: '3809', channel: 'rent', status: 'live', agentNames: [] },
];

function countingDb(rows: unknown[] = THREE_ROWS) {
  let queries = 0;
  const chain: Record<string, unknown> = {};

  for (const m of ['select', 'selectDistinct', 'from', 'innerJoin', 'leftJoin', 'where',
                   'orderBy', 'groupBy', 'update', 'set', 'insert', 'values', 'delete',
                   'onConflictDoUpdate']) {
    chain[m] = () => chain;
  }

  // A Drizzle builder reaches the database when it is awaited, or when a
  // terminal like returning is. These are the only places to count.
  //
  // limit() is NOT one of them any more: a paged search continues .limit().
  // offset(), so limit has to hand the builder back. Awaiting is what counts,
  // and every read ends in an await either way.
  const terminal = () => {
    queries += 1;
    return Promise.resolve(rows);
  };
  chain.limit = () => chain;
  chain.offset = () => chain;
  chain.returning = terminal;
  chain.then = (res: (v: unknown) => unknown) => terminal().then(res);
  chain.transaction = async (fn: (tx: unknown) => unknown) => fn(chain);

  return { db: chain as unknown as Db, count: () => queries };
}

const actor: Actor = {
  userId: 'u-1',
  agencyId: '11111111-1111-1111-1111-111111111111',
  membershipRole: 'owner',
};

describe('reads cost a fixed number of queries', () => {
  it('the agency listings table is one query, agent names included', async () => {
    const { db, count } = countingDb();
    await listAgencyListings(db, actor);
    // The agent names are sub-selected into the same statement. Fetching them
    // per listing afterwards was a round trip per row and is the exact
    // regression this guards.
    expect(count()).toBe(1);
  });

  it("the agent desk's own listings are also one query", async () => {
    const { db, count } = countingDb();
    await listAgencyListings(db, actor, { mine: true });
    expect(count()).toBe(1);
  });

  it('opening one listing for editing is one query', async () => {
    const { db, count } = countingDb();
    await getListingForEdit(db, actor, '99999999-9999-9999-9999-999999999999');
    expect(count()).toBe(1);
  });

  it('a public search is one query, however many filters are on it', async () => {
    const { db, count } = countingDb();
    await searchPublicListings(db, {
      suburb: 'Pakenham',
      state: 'VIC',
      postcode: '3810',
      channel: 'sale',
      bedrooms: 3,
      bathrooms: 2,
      carSpaces: 1,
      propertyType: 'House',
      priceFrom: 100_000,
      priceTo: 2_000_000,
      landFrom: 300,
      text: 'pool',
      sort: 'price_asc',
      near: { lat: -38.0777, lng: 145.4819, radiusKm: 10 },
    });
    // Filters are clauses, not extra statements. A filter that needed its own
    // lookup would show up here before it reached production.
    expect(count()).toBe(1);
  });

  it('a radius search costs no more queries than a plain one', async () => {
    const plain = countingDb();
    await searchPublicListings(plain.db, { suburb: 'Pakenham' });

    const radius = countingDb();
    await searchPublicListings(radius.db, {
      suburb: 'Pakenham',
      near: { lat: -38.0777, lng: 145.4819, radiusKm: 10 },
    });

    // The distance is computed in the same statement by PostGIS. Resolving the
    // centre is the caller's job and is cached separately.
    expect(radius.count()).toBe(plain.count());
  });

  it('the filter lists are one query each', async () => {
    const a = countingDb();
    await liveSuburbs(a.db);
    expect(a.count()).toBe(1);

    const b = countingDb();
    await livePropertyTypes(b.db);
    expect(b.count()).toBe(1);
  });
});
