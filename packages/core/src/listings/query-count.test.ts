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
import { listContacts } from '../contacts/list-contacts';
import { getContact, type ReadableContact } from '../contacts/get-contact';
import { listContactTimeline } from '../contacts/timeline';
import { listContactProperties } from '../contacts/properties';
import { contactCounts } from '../contacts/counts';
import { listContactNotes } from '../contacts/notes';
import { listBuyerRequirements } from '../contacts/buyer-requirements';
import { listAppointments } from '../appointments/appointments';
import { checkEmailLimits } from '../email/limits';
import { listMySkills, listSkillLibrary } from '../skills/skills';
import { agencyNotificationRecipients } from '../agency/notification-recipients';
import type { Actor } from '../permissions';
import { planHomes } from '../inspections/homes';
import { listNotebooks, notebooksForSummary } from '../inspections/notes';
import { forYou, hiddenHomes, similarHomes } from '../discovery/discovery';
import { findOpportunities } from '../buyer-opportunities/find';
import { getTask, listTasks } from '../tasks/manage';
import { buildTaskReport } from '../tasks/report';
import { automationLog, listAutomations } from '../automation/manage';
import { detectEvents } from '../automation/tick';
import { messageFacts } from '../agent-messages/message';
import { listingExtras, unreadFloorplans } from '../media/extras';
import { zoningSubject } from '../development/zoning';

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
  it('a day plan is three queries for eight homes: the homes, their open times, the distances (ADR 0080 C6)', async () => {
    const { db, count } = countingDb();
    await planHomes(db, Array.from({ length: 8 }, (_, i) => `0000000${i}-0000-4000-8000-000000000000`));
    expect(count()).toBe(3);
  });

  it('the inspection notebooks list is one query, photo counts included; the summary reads one more', async () => {
    const buyer = { userId: 'u-1' };
    const list = countingDb();
    await listNotebooks(list.db, buyer);
    expect(list.count()).toBe(1);
    const books = countingDb();
    await notebooksForSummary(books.db, buyer);
    expect(books.count()).toBe(1);
  });

  it('Similar homes are two queries: the listing, then every candidate with its distance (ADR 0080 C7)', async () => {
    const { db, count } = countingDb();
    await similarHomes(db, 'l-1');
    expect(count()).toBe(2);
  });

  it('For you is the profile (six) plus two: homes for sale and homes not for sale, never one per suburb (C7)', async () => {
    const { db, count } = countingDb();
    const out = await forYou(db, { userId: 'u-1' }, {});
    expect(out.state).toBe('ready');
    expect(count()).toBe(8);
  });

  it('hidden homes are one query (C7)', async () => {
    const { db, count } = countingDb();
    await hiddenHomes(db, { userId: 'u-1' });
    expect(count()).toBe(1);
  });

  it('Opportunities are three queries for any area: the homes with their signals, the site median, the sale counts (C7)', async () => {
    const { db, count } = countingDb();
    await findOpportunities(db, { suburbs: ['pakenham', 'officer', 'berwick'], state: 'VIC', priceTo: null, bedrooms: null, propertyType: null, signals: [] });
    expect(count()).toBe(3);
  });

  it('C8: tasks list is one query; a task with its reports is two; the automations list and log are one each', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const auto = { id, userId: 'u-1', trigger: 'price_reduced', scope: 'shortlist', searchId: null, action: 'tell', delivery: 'daily', timeZone: 'Australia/Sydney', status: 'active', checkedAt: new Date(), createdAt: new Date(), updatedAt: new Date() };
    const task = { userId: 'u-1', id, kind: 'task', name: 'T', query: {}, sections: [], cadence: 'daily', sendAtMinute: 420, sendOnWeekday: null, status: 'active', skipEmpty: true, nextRunAt: new Date(), lastRunAt: null, createdAt: new Date() };
    const cases: [(db: Db) => Promise<unknown>, unknown[], number][] = [
      [(db) => listTasks(db, { userId: 'u-1' }), [task], 1],
      [(db) => getTask(db, { userId: 'u-1' }, id), [task], 2],
      [(db) => listAutomations(db, { userId: 'u-1' }), [{ a: auto, searchName: null }], 1],
      [(db) => automationLog(db, { userId: 'u-1' }), [{ e: { id, listingId: null, propertyId: null, text: 'x', actionTaken: null, undoneAt: null, createdAt: new Date(), emailedAt: null }, a: auto, searchName: null, address: 'A' }], 1],
      [(db) => messageFacts(db, id), [{ street: '1 A St', suburb: 'Pakenham', state: 'VIC', agencyName: 'A', priceDisplay: null, priceFrom: null, priceTo: null, startsAt: new Date() }], 2],
    ];
    for (const [fn, rows, n] of cases) {
      const { db, count } = countingDb(rows);
      await fn(db);
      expect(count()).toBe(n);
    }
  });

  it('C8: a task report is one read per section (three for opportunities), never one per home', async () => {
    const { db, count } = countingDb([]);
    await buildTaskReport(db, { search: async () => [] }, { userId: 'u-1', query: { suburb: 'Pakenham', state: 'VIC' }, runtimeQuery: {}, sections: ['sold', 'price_reduced', 'watched', 'open_homes'], since: null, previousListingIds: [], now: new Date(), timeZone: 'Australia/Melbourne' });
    expect(count()).toBe(1 + 3 + 1 + 1);
  });

  it('C8: an automation’s check is one read, whatever it watches', async () => {
    const { db, count } = countingDb([]);
    const a = { id: 'a', userId: 'u-1', trigger: 'price_reduced', scope: 'both', searchId: null, action: 'tell', delivery: 'daily', timeZone: 'Australia/Sydney', status: 'active', checkedAt: new Date(), createdAt: new Date(), updatedAt: new Date() };
    for (const trigger of ['price_reduced', 'open_home_added', 'sold', 'listed']) await detectEvents(db, { ...a, trigger }, new Date(), { search: async () => [], resolvePlace: async () => null });
    expect(count()).toBe(4);
  });

  it('C9: a listing’s floorplans, videos and tours are one query; the floorplans waiting to be read, one more', async () => {
    const one = countingDb([{ id: 'm', kind: 'video', key: 'youtube:dQw4w9WgXcQ', width: null, height: null, tags: null }]);
    expect((await listingExtras(one.db, 'l-1')).videos).toHaveLength(1);
    expect(one.count()).toBe(1);
    const two = countingDb([]);
    await unreadFloorplans(two.db);
    expect(two.count()).toBe(1);
  });

  it('C9: the land-and-zoning subject is one query — the latest ad’s land size is a subquery, not a second read', async () => {
    const { db, count } = countingDb([{ state: 'VIC', lat: '-38.075000', lng: '145.487000', source: 'google', land: '612.00' }]);
    expect(await zoningSubject(db, '6f1f7a2e-3c1b-4f7e-9a51-1d2e3f4a5b6c')).toMatchObject({ state: 'VIC', at: { lat: -38.075, lng: 145.487 }, landAreaSqm: 612 });
    expect(count()).toBe(1);
  });

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

  it('the contact directory is one query, roles and total included', async () => {
    // Roles are a sub-select and the total a window function. Fetching roles
    // per contact is the N+1 this refuses; three rows so a loop would show.
    const contactRow = (id: string) => ({
      id, name: 'A', email: `${id}@example.test`, phone: null, source: 'enquiry',
      assignedTo: null, assigneeName: null, assigneeEmail: null, createdAt: new Date(),
      roles: '{buyer}', total: '3',
    });
    const { db, count } = countingDb([contactRow('c1'), contactRow('c2'), contactRow('c3')]);
    const page = await listContacts(db, actor, { q: '0412 345 678', role: 'buyer' });
    expect(page.rows).toHaveLength(3);
    expect(page.rows[0]?.roles).toEqual(['buyer']);
    expect(count()).toBe(1);
  });

  it('opening one contact is one query for an agent, two for an admin (duplicates)', async () => {
    const head = {
      id: '99999999-9999-9999-9999-999999999999', agencyId: actor.agencyId, name: 'A',
      email: null, phone: '0412 345 678', phoneKey: '61412345678', source: 'manual',
      assignedTo: 'u-agent', assigneeName: null, assigneeEmail: null, nextAction: null,
      nextActionAt: null, marketingConsentAt: null, marketingConsentNote: null,
      consentByName: null, consentByEmail: null, emailOptOutAt: null, mergedIntoId: null,
      createdAt: new Date(), updatedAt: new Date(), roles: null, inferredRoles: null,
      leadAssigneeIds: null, listingAgentIds: null,
    };
    const agentActor: Actor = { ...actor, userId: 'u-agent', membershipRole: 'agent' };
    const forAgent = countingDb([head]);
    await getContact(forAgent.db, agentActor, head.id);
    expect(forAgent.count()).toBe(1);

    const forAdmin = countingDb([head]);
    await getContact(forAdmin.db, actor, head.id);
    expect(forAdmin.count()).toBe(2);
  });

  it("each Contact 360 tab's read is one query, whatever it unions", async () => {
    /**
     * The timeline is four sources and the properties tab two; each is one
     * UNION ALL, not a query per source — and certainly not one per row.
     */
    const ref = { id: '99999999-9999-9999-9999-999999999999', agencyId: actor.agencyId } as ReadableContact;
    const reads = [
      (db: Db) => listContactTimeline(db, actor, ref),
      (db: Db) => listContactProperties(db, actor, ref),
      (db: Db) => contactCounts(db, actor, ref),
      (db: Db) => listContactNotes(db, actor, ref),
      (db: Db) => listBuyerRequirements(db, actor, ref),
    ];
    for (const read of reads) {
      const { db, count } = countingDb([]);
      await read(db);
      expect(count()).toBe(1);
    }
  });

  it('a calendar page is one query, and the sending-limit check is one', async () => {
    const calendar = countingDb([]);
    await listAppointments(calendar.db, actor, { when: 'upcoming' });
    expect(calendar.count()).toBe(1);
    const limits = countingDb([{ agency: '3', agent: '1' }]);
    const check = await checkEmailLimits(limits.db, { agencyId: actor.agencyId!, userId: 'u-1' }, { perAgentDay: 1, perAgencyDay: 200 });
    expect(limits.count()).toBe(1);
    // Driver bigints as strings, and the agent's cap reached.
    expect(check).toMatchObject({ ok: false, agentUsed: 1, agencyUsed: 3 });
  });

  it('the skills page is one query for your skills and one for the library', async () => {
    const mine = countingDb([]);
    await listMySkills(mine.db, actor);
    expect(mine.count()).toBe(1);
    const lib = countingDb([]);
    await listSkillLibrary(lib.db, actor);
    expect(lib.count()).toBe(1);
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
