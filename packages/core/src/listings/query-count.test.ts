import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import {
  listAgencyListings,
  listAgencyListingsPage,
  getListingForEdit,
} from './list-listings';
import { searchPublicListings, liveSuburbs, livePropertyTypes } from './search-listings';
import { nearbySuburbs, topSuburbAgents } from './search-sidebar';
import { searchFacets } from './search-facets';
import { nearbyMarket } from './nearby-market';
import { recentSales } from './recent-sales';
import { formerListingDestination } from './listing-detail';
import {
  getOffMarketProperty,
  listingAgentCards,
  listingInspections,
  propertyTimeline,
} from './listing-detail';
import { createPrivateOffer } from '../leads/create-private-offer';
import { listAgencyLeads } from '../leads/list-leads';
import { agencyNotificationRecipients } from '../agency/notification-recipients';
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
  // Raw SQL goes through execute() rather than the builder, and it is just as
  // much a round trip. Without this line a hand-written statement was invisible
  // to every count in this file.
  chain.execute = terminal;
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

  it('a page of the agency book is one query, counts included', async () => {
    const { db, count } = countingDb();
    await listAgencyListingsPage(db, actor, { limit: 25, offset: 50 });
    // The three header figures are window functions over the same scan. The
    // obvious way to add them is a second SELECT, which is a round trip to the
    // database region for three integers — this is what refuses that.
    expect(count()).toBe(1);
  });

  it("a page of the agent desk's own listings is also one query", async () => {
    const { db, count } = countingDb();
    await listAgencyListingsPage(db, actor, { mine: true, limit: 25 });
    expect(count()).toBe(1);
  });

  /**
   * The listing page's three extra reads.
   *
   * One query each, and the page starts all three together with the listing
   * itself — so the page costs one round trip's latency, not four. If any of
   * these ever becomes two, it is because someone fetched something per row.
   */
  it('the inspection times are one query', async () => {
    const { db, count } = countingDb();
    await listingInspections(db, 'l-1');
    expect(count()).toBe(1);
  });

  it("the property's history is one query", async () => {
    const { db, count } = countingDb();
    await propertyTimeline(db, 'p-1');
    expect(count()).toBe(1);
  });

  it('recent sales are one query, including the re-listed check', async () => {
    /**
     * `onMarketNow` is an inline EXISTS, not a lookup per sale. Asking "is this
     * address live again" once per row would be an N+1 that grows with the
     * number of sales shown — and the guide asks for eight of them.
     */
    const { db, count } = countingDb([
      { listingId: 'l-1', propertyId: 'p-1', suburb: 'Pakenham', state: 'VIC', postcode: '3810',
        soldPrice: '812000.00', soldDate: new Date('2024-03-11'), agencyName: 'A',
        bedrooms: 3, bathrooms: '2', carSpaces: 1, propertyType: 'house',
        distanceKm: null, onMarketNow: false },
      { listingId: 'l-2', propertyId: 'p-2', suburb: 'Pakenham', state: 'VIC', postcode: '3810',
        soldPrice: '640000.00', soldDate: new Date('2024-01-02'), agencyName: 'B',
        bedrooms: 2, bathrooms: '1', carSpaces: 1, propertyType: 'unit',
        distanceKm: null, onMarketNow: true },
    ]);
    const sales = await recentSales(db, { suburb: 'Pakenham', near: { lat: -38, lng: 145, radiusKm: 10 } });
    expect(sales).toHaveLength(2);
    expect(count()).toBe(1);
  });

  it('an old listing link is resolved in one query', async () => {
    // Where a bookmark of a sold listing goes: the live listing, the history
    // page, or nowhere. Every request for a dead link pays this, so it is one
    // statement rather than three lookups.
    const { db, count } = countingDb([{ property_id: 'p-1', live_id: 'l-live', off_market: false }]);
    await expect(formerListingDestination(db, 'l-old')).resolves.toBe('/listing/l-live');
    expect(count()).toBe(1);
  });

  it('the off-market gate is one query, both conditions included', async () => {
    /**
     * Two questions — is anything on the market at this address, and was
     * anything here ever public — answered by two correlated EXISTS inside one
     * statement, not by two round trips or by counting every listing.
     *
     * An explicit property-shaped row rather than THREE_ROWS: this read ends in
     * .limit(1) and returns the place itself, so the shared listing fixture
     * would prove nothing about it.
     */
    const { db, count } = countingDb([{ id: 'p-1', suburb: 'Pakenham', state: 'VIC', postcode: '3810' }]);
    await getOffMarketProperty(db, 'p-1');
    expect(count()).toBe(1);
  });

  it('the agent cards are one query, profile join included', async () => {
    const { db, count } = countingDb();
    await listingAgentCards(db, 'l-1');
    // The profile is a join, not a lookup per agent. Fetching agent_profile
    // per listing_agent row is the N+1 this number exists to refuse.
    expect(count()).toBe(1);
  });

  it('recording a private offer is one query, agency resolved by the database', async () => {
    /**
     * The check and the write are one INSERT ... SELECT, not a read followed by
     * an insert — see create-private-offer.ts for the window a two-step version
     * leaves open. Two here would mean somebody split it.
     */
    const { db, count } = countingDb([{ id: 'lead-1', agency_id: 'a-1' }]);
    await createPrivateOffer(
      db,
      'p-1',
      { userId: 'u-1', email: 'jane@example.test' },
      {
        name: 'Jane Buyer',
        message: 'I have been watching this street and would like to buy.',
        offerAmount: 905_000,
      },
    );
    expect(count()).toBe(1);
  });

  it('the offer notification recipients are one query, not one per member', async () => {
    /**
     * The tempting N+1: list the memberships, then look up each user. Fed more
     * than one row on purpose — a zero-row fake cannot catch a per-row query
     * because the loop never runs.
     */
    const { db, count } = countingDb([
      { userId: 'u-1', email: 'owner@example.test', name: 'Owner' },
      { userId: 'u-2', email: 'admin@example.test', name: 'Admin' },
    ]);
    const recipients = await agencyNotificationRecipients(db, 'a-1');
    expect(recipients).toHaveLength(2);
    expect(count()).toBe(1);
  });

  it('the lead inbox is one query, tab counts included', async () => {
    /**
     * The three tab counts are window functions over the same scan. The obvious
     * way to add them is a second SELECT, which is a round trip to the database
     * region for three integers — and a third for the offers count.
     */
    const { db, count } = countingDb([
      { id: 'lead-1', kind: 'enquiry', status: 'new', name: 'A', email: 'a@example.test',
        phone: null, message: null, offerAmount: null, propertyId: 'p-1', listingId: 'l-1',
        createdAt: new Date(), unit: null, streetNumber: '1', street: 'X', suburb: 'Pakenham',
        state: 'VIC', postcode: '3810', totalCount: '2', unreadCount: '1', offerCount: '0' },
      { id: 'lead-2', kind: 'offer', status: 'new', name: 'B', email: 'b@example.test',
        phone: null, message: null, offerAmount: '905000.00', propertyId: 'p-2', listingId: null,
        createdAt: new Date(), unit: null, streetNumber: '2', street: 'Y', suburb: 'Pakenham',
        state: 'VIC', postcode: '3810', totalCount: '2', unreadCount: '1', offerCount: '0' },
    ]);
    const page = await listAgencyLeads(db, actor, { limit: 25 });
    expect(page.rows).toHaveLength(2);
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

  it('every filter option on the search page is one query, not six', async () => {
    // Beds, baths, car spaces, property types, price bounds and the suburb
    // list, split by channel — all of it in a single statement with FILTER
    // aggregates. A query per facet is six round trips to the database region
    // on the first paint of the most-visited page on the site.
    const { db, count } = countingDb([{ saleTotal: '3', rentTotal: '0' }]);
    await searchFacets(db);
    expect(count()).toBe(1);
  });

  it('"cheapest near here" is one query, not one per shape', async () => {
    // It answers two questions — the cheapest listings with their distances,
    // and a per-suburb breakdown — and the obvious shape is a query each.
    // That doubles a round trip to another region for two halves of one
    // answer, on a route where a turn already pays for a geocode.
    const { db, count } = countingDb([{ listings: [], by_suburb: [], unpriced: 0 }]);
    await nearbyMarket(db, {
      near: { lat: -38.0777, lng: 145.4819, radiusKm: 20 },
      channel: 'sale',
      bedrooms: 3,
      propertyType: 'house',
    });
    expect(count()).toBe(1);
  });

  it('each results-page sidebar panel is one query', async () => {
    // Both are aggregates. The tempting shape — list the suburbs, then count
    // each one — is a query per suburb on a page that already ran a search.
    const agents = countingDb();
    await topSuburbAgents(agents.db, { suburb: 'Pakenham', state: 'VIC', channel: 'sale' });
    expect(agents.count()).toBe(1);

    const suburbs = countingDb();
    await nearbySuburbs(suburbs.db, {
      suburb: 'Pakenham',
      state: 'VIC',
      channel: 'sale',
      near: { lat: -38.0777, lng: 145.4819, radiusKm: 30 },
    });
    expect(suburbs.count()).toBe(1);
  });

  it('a sidebar with a centre costs no more queries than one without', async () => {
    const plain = countingDb();
    await nearbySuburbs(plain.db, { suburb: 'Pakenham' });

    const radius = countingDb();
    await nearbySuburbs(radius.db, {
      suburb: 'Pakenham',
      near: { lat: -38.0777, lng: 145.4819, radiusKm: 30 },
    });

    expect(radius.count()).toBe(plain.count());
  });
});

/**
 * The counts these panels return are bigints, and a bigint arrives as text.
 *
 * This is the third file in this repo to need the same assertion. The value
 * test passes either way — `"3"` and `3` both render as "3" — so it is the
 * TYPE that has to be asserted, which is the one line ARCHITECTURE.md § 6 says
 * actually catches this. Delete the Number() in search-sidebar.ts and only
 * these two tests go red.
 */
describe('the sidebar counts are numbers, not the strings Postgres sends', () => {
  it('an agent listing count is a number', async () => {
    const { db } = countingDb([
      { userId: 'u-1', name: 'Daniel Vance', agencyName: 'Harcourts', listingCount: '54' },
    ]);
    const [agent] = await topSuburbAgents(db, { suburb: 'Pakenham' });
    expect(typeof agent?.listingCount).toBe('number');
    expect(agent?.listingCount).toBe(54);
  });

  it('a nearby suburb count is a number and its distance is a number or null', async () => {
    const { db } = countingDb([
      { suburb: 'Officer', state: 'VIC', postcode: '3809', listingCount: '3', distanceKm: '5.6' },
      { suburb: 'Berwick', state: 'VIC', postcode: '3806', listingCount: '1', distanceKm: null },
    ]);
    const [officer, berwick] = await nearbySuburbs(db, { suburb: 'Pakenham' });
    expect(typeof officer?.listingCount).toBe('number');
    expect(typeof officer?.distanceKm).toBe('number');
    expect(officer?.distanceKm).toBe(5.6);
    // Never 0. A suburb nothing has geocoded is unknown, not on top of you.
    expect(berwick?.distanceKm).toBeNull();
  });
});
