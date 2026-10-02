import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import {
  getOffMarketProperty,
  HISTORIC_STATUSES,
  listingAgentCards,
  ON_MARKET_STATUSES,
  propertyTimeline,
} from './listing-detail';

/**
 * A builder that answers with whatever rows the test hands it.
 *
 * It cannot check a WHERE clause — that is Postgres's job and `pnpm smoke`
 * asks the real one. What it can check is everything this module does in
 * TypeScript after the rows come back, which is where the privacy decisions
 * live.
 */
function fakeDb(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  // `limit` returns the chain rather than resolving: a read that ends in
  // .limit(1) is still awaited through `then`, and making it a terminal here
  // would hide the difference between "one row" and "the first of many".
  for (const m of ['select', 'from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit']) {
    chain[m] = () => chain;
  }
  chain.then = (res: (v: unknown) => unknown) => Promise.resolve(rows).then(res);
  return chain as unknown as Db;
}

describe("a property's public history", () => {
  /**
   * The one that matters.
   *
   * A property outlives its listings (#1), so every ad an agency ever wrote
   * against this address shares its property_id — including the drafts they
   * are working on today. Selecting by property_id without this filter would
   * publish an agency's unpublished pipeline on the address it belongs to.
   */
  it('never includes a status the public was not allowed to see', () => {
    expect(HISTORIC_STATUSES).not.toContain('draft');
    expect(HISTORIC_STATUSES).not.toContain('pending');
    // Public once, so not a leak — but "listed and pulled" is a claim about
    // why a sale did not happen, and this page has no idea.
    expect(HISTORIC_STATUSES).not.toContain('withdrawn');
    expect([...HISTORIC_STATUSES].sort()).toEqual(['live', 'sold', 'under_offer']);
  });

  it('turns the driver s numeric string into a number', async () => {
    // sold_price is numeric, and the driver hands numeric back as a STRING —
    // the same lie the bigint counts told. "1200000" reaching a chart or a
    // sum is the bug this prevents.
    const [entry] = await propertyTimeline(
      fakeDb([
        {
          listingId: 'l-1',
          channel: 'sold',
          status: 'sold',
          priceDisplay: 'Sold $1.20m',
          soldPrice: '1200000.00',
          soldDate: new Date('2023-06-15'),
          publishedAt: null,
          agencyName: 'Harcourts',
        },
      ]),
      'p-1',
    );

    expect(entry?.soldPrice).toBe(1_200_000);
    expect(typeof entry?.soldPrice).toBe('number');
  });

  it('keeps a missing sold price as null rather than NaN', async () => {
    const [entry] = await propertyTimeline(
      fakeDb([
        {
          listingId: 'l-2',
          channel: 'sale',
          status: 'live',
          priceDisplay: 'Offers over $700,000',
          soldPrice: null,
          soldDate: null,
          publishedAt: new Date('2026-09-01'),
          agencyName: 'Harcourts',
        },
      ]),
      'p-1',
    );

    // Number(null) is 0, which would read as "sold for nothing".
    expect(entry?.soldPrice).toBeNull();
  });
});

/**
 * When a property's history may be read at all.
 *
 * The requirement: while an address is on the market, what it last sold for is
 * the vendor's business and the selling agency's. These tests cover the two
 * constants and what the gate does with a row once Postgres has answered — the
 * WHERE clause itself is `pnpm smoke`'s job, as the fake's own docstring says.
 */
describe('what counts as on the market', () => {
  it('treats a property under offer as on the market, not off it', () => {
    /**
     * The one that is easy to get wrong. An `under_offer` listing has no public
     * page — `getPublicListing` returns `live` only — so keying this off `live`
     * alone would make a property mid-transaction read as off-market: its last
     * sale price published, and a private offer invited, aimed at the agency
     * currently selling it. See docs/adr/0012.
     */
    expect(ON_MARKET_STATUSES).toContain('under_offer');
    expect([...ON_MARKET_STATUSES].sort()).toEqual(['live', 'under_offer']);
  });

  it('does not treat a sold listing as on the market', () => {
    // A sale is what MAKES a property off-market. If this ever contains 'sold'
    // the off-market page can never render for anyone.
    expect(ON_MARKET_STATUSES).not.toContain('sold');
    expect(ON_MARKET_STATUSES).not.toContain('withdrawn');
  });

  it('is a subset of what the public was ever allowed to see', () => {
    /**
     * Why the gate's second condition looks redundant and is kept anyway.
     *
     * Everything on the market is also historic, so once "nothing on the market"
     * has been established the "at least one historic listing" test can only
     * match a sold row. That redundancy is deliberate: the day HISTORIC_STATUSES
     * changes, the gate changes with it. This is the assertion that says the two
     * lists are related on purpose rather than by coincidence.
     */
    for (const status of ON_MARKET_STATUSES) {
      expect(HISTORIC_STATUSES).toContain(status);
    }
  });
});

describe('the property behind an off-market page', () => {
  const row = {
    id: 'p-1',
    unit: null,
    streetNumber: '14',
    street: 'Henry Road',
    suburb: 'Pakenham',
    state: 'VIC',
    postcode: '3810',
    propertyType: 'house',
    bedrooms: 4,
    bathrooms: '2.5',
    carSpaces: 2,
    landAreaSqm: '650.00',
    latitude: '-38.070000',
    longitude: '145.480000',
  };

  it('returns null when Postgres finds nothing, rather than an empty shell', async () => {
    // The gate refuses three different states with one empty result — on the
    // market, never publicly listed, or no such property. The page turns this
    // into a 404, and distinguishing them would tell a uuid-guesser which.
    expect(await getOffMarketProperty(fakeDb([]), 'p-1')).toBeNull();
  });

  it('builds the address from the parts and coerces every numeric string', async () => {
    const p = await getOffMarketProperty(fakeDb([row]), 'p-1');
    expect(p?.address).toBe('14 Henry Road, Pakenham, VIC 3810');
    // numeric and decimal arrive from the driver as strings.
    expect(p?.bathrooms).toBe(2.5);
    expect(p?.landAreaSqm).toBe(650);
    expect(p?.latitude).toBe(-38.07);
    expect(typeof p?.longitude).toBe('number');
  });

  it('keeps an unknown measurement null rather than zero', async () => {
    const p = await getOffMarketProperty(
      fakeDb([{ ...row, bathrooms: null, landAreaSqm: null, latitude: null, longitude: null }]),
      'p-1',
    );
    // Number(null) is 0, and a house with 0 bathrooms on 0 m² is a claim.
    expect(p?.bathrooms).toBeNull();
    expect(p?.landAreaSqm).toBeNull();
    expect(p?.latitude).toBeNull();
  });

  it('describes the place and never a campaign', async () => {
    /**
     * There is no current ad, so there is nothing to price. A `priceDisplay` or
     * an `agencyName` leaking in here would put a figure on the page that no
     * live listing backs, beside the history this page exists to show — and the
     * history is the only place a price belongs.
     */
    const p = await getOffMarketProperty(fakeDb([{ ...row, priceDisplay: 'Sold $1.2m' }]), 'p-1');
    expect(Object.keys(p ?? {}).sort()).toEqual([
      'address', 'bathrooms', 'bedrooms', 'carSpaces', 'id', 'landAreaSqm',
      'latitude', 'longitude', 'postcode', 'propertyType', 'state', 'suburb',
    ]);
  });
});

describe('the agents on a public listing', () => {
  const agent = (over: Record<string, unknown> = {}) => ({
    name: 'Daniel Vance',
    phone: '0412 884 920',
    role: 'lead',
    isPublic: true,
    photoUrl: 'https://example.test/daniel.jpg',
    bio: 'Fifteen years in the south east.',
    licenceNumber: '081292L',
    ...over,
  });

  it('shows the profile of an agent who has made it public', async () => {
    const [card] = await listingAgentCards(fakeDb([agent()]), 'l-1');
    expect(card?.photoUrl).toBe('https://example.test/daniel.jpg');
    expect(card?.bio).toContain('south east');
    expect(card?.licenceNumber).toBe('081292L');
  });

  /**
   * `agent_profile.public` exists to answer "may this person's details be
   * shown to the public", and this is the page that has to ask. A profile the
   * agent has not published must not appear on an unauthenticated page just
   * because they are named on a listing.
   */
  it('withholds photo, bio and licence when the profile is not public', async () => {
    const [card] = await listingAgentCards(fakeDb([agent({ isPublic: false })]), 'l-1');
    expect(card?.photoUrl).toBeNull();
    expect(card?.bio).toBeNull();
    expect(card?.licenceNumber).toBeNull();
    // The ad still has to say who to call.
    expect(card?.name).toBe('Daniel Vance');
    expect(card?.phone).toBe('0412 884 920');
  });

  it('treats a missing profile row the same as a private one', async () => {
    // LEFT JOIN: an agent with no agent_profile at all still appears on their
    // own listing rather than vanishing from it.
    const [card] = await listingAgentCards(
      fakeDb([agent({ isPublic: null, photoUrl: null, bio: null, licenceNumber: null })]),
      'l-1',
    );
    expect(card?.name).toBe('Daniel Vance');
    expect(card?.photoUrl).toBeNull();
  });

  it('never returns an email address', async () => {
    // listing_agent carries snapshot_email and this deliberately does not
    // select it. A phone number on a property ad is the convention; an email
    // rendered into a public page is harvested within days.
    const [card] = await listingAgentCards(
      fakeDb([{ ...agent(), snapshotEmail: 'daniel@example.test' }]),
      'l-1',
    );
    expect(JSON.stringify(card)).not.toContain('@');
    expect(Object.keys(card ?? {})).not.toContain('email');
  });
});
