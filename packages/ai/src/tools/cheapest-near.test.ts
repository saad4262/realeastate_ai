import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@repo/db';
import type { NearbyMarket, NearbyMarketQuery } from '@repo/core/listings';
import type { ResolvedPlace } from '@repo/core/geo/schema';
import { cheapestNearInput, runCheapestNear } from './cheapest-near';
import type { ToolContext } from './context';

/**
 * "My office is in Berwick — where is the cheapest place near it?"
 *
 * The two things that make this answer trustworthy are both testable without
 * a model: the coordinates never pass through the model, and every figure the
 * model is handed was computed by Postgres and formatted, never derived.
 */

const BERWICK: ResolvedPlace = {
  suburb: 'Berwick',
  state: 'VIC',
  postcode: '3806',
  latitude: -38.0333,
  longitude: 145.3417,
  formatted: 'Berwick VIC 3806, Australia',
  kind: 'locality',
} as ResolvedPlace;

const MARKET: NearbyMarket = {
  listings: [
    {
      id: 'l-1',
      address: '3/10 Havana Parade',
      suburb: 'Pakenham',
      state: 'VIC',
      postcode: '3810',
      bedrooms: 3,
      bathrooms: 2,
      carSpaces: 1,
      propertyType: 'house',
      priceDisplay: null,
      price: 23_000,
      distanceKm: 9.83,
    },
  ],
  bySuburb: [
    {
      suburb: 'Pakenham',
      state: 'VIC',
      postcode: '3810',
      count: 2,
      cheapest: 800,
      nearestKm: 9.83,
    },
  ],
  unpriced: 3,
};

function ctx(over: Partial<ToolContext> = {}) {
  const asked: NearbyMarketQuery[] = [];
  const context: ToolContext = {
    db: {} as Db,
    places: new Map(),
    // These tests are about finding homes, not scheduling. `signed_out` is
    // the honest default: no session, so the scheduling tools refuse.
    scheduling: { state: 'signed_out' },
    resolvePlace: vi.fn(async () => BERWICK),
    search: vi.fn(async () => []),
    getListing: vi.fn(async () => null),
    // No sales unless a test says so — an empty market, not a missing tool.
    recentSales: vi.fn(async () => ({ rows: [], total: 0 })),
    nearbyMarket: vi.fn(async (q: NearbyMarketQuery) => {
      asked.push(q);
      return MARKET;
    }),
    ...over,
  };
  return { context, asked };
}

describe('cheapest_near input', () => {
  it('requires a place and a channel', () => {
    expect(cheapestNearInput.safeParse({ place: 'Berwick' }).success).toBe(false);
    expect(cheapestNearInput.safeParse({ channel: 'sale' }).success).toBe(false);
    expect(cheapestNearInput.safeParse({ place: 'Berwick', channel: 'sale' }).success).toBe(true);
  });

  it('refuses a radius outside what the portal will search', () => {
    const ok = (radiusKm: number) =>
      cheapestNearInput.safeParse({ place: 'Berwick', channel: 'sale', radiusKm }).success;
    expect(ok(0.2)).toBe(false);
    expect(ok(80)).toBe(false);
    expect(ok(20)).toBe(true);
  });

  it('strips a forged coordinate rather than passing it through', () => {
    /**
     * The schema the model sees has no lat/lng, but a schema is a description
     * and this is the guard. A model that invented one must not be able to
     * move the search point — the coordinates come from resolvePlace and
     * nowhere else.
     */
    const parsed = cheapestNearInput.parse({
      place: 'Berwick',
      channel: 'sale',
      lat: -33.8688,
      lng: 151.2093,
      near: { lat: 0, lng: 0, radiusKm: 50 },
    });
    expect(parsed).not.toHaveProperty('lat');
    expect(parsed).not.toHaveProperty('lng');
    expect(parsed).not.toHaveProperty('near');
  });
});

describe('runCheapestNear', () => {
  it('searches from the resolved point, not from anything the model said', async () => {
    const { context, asked } = ctx();
    await runCheapestNear({ place: 'my office in Berwick', channel: 'sale' }, context);

    expect(asked).toHaveLength(1);
    expect(asked[0]!.near.lat).toBe(BERWICK.latitude);
    expect(asked[0]!.near.lng).toBe(BERWICK.longitude);
  });

  it('defaults to a radius somebody would actually commute', async () => {
    const { context, asked } = ctx();
    await runCheapestNear({ place: 'Berwick', channel: 'sale' }, context);
    expect(asked[0]!.near.radiusKm).toBe(20);

    const second = ctx();
    await runCheapestNear({ place: 'Berwick', channel: 'sale', radiusKm: 5 }, second.context);
    expect(second.asked[0]!.near.radiusKm).toBe(5);
  });

  it('hands the model formatted figures, never raw numbers to do sums on', async () => {
    const { context } = ctx();
    const out = await runCheapestNear({ place: 'Berwick', channel: 'sale' }, context);
    const result = out.result as {
      cheapest: { price: string; distance: string }[];
      bySuburb: { suburb: string; cheapest: string; nearest: string; listings: number }[];
    };

    expect(result.cheapest[0]!.price).toBe('$23,000');
    expect(result.cheapest[0]!.distance).toBe('9.8 km');
    expect(result.bySuburb[0]!.suburb).toBe('Pakenham VIC 3810');
    expect(result.bySuburb[0]!.cheapest).toBe('$800');
    expect(result.bySuburb[0]!.nearest).toBe('9.8 km');
    expect(result.bySuburb[0]!.listings).toBe(2);
  });

  it('says the distance is a straight line, in the payload', async () => {
    // Otherwise the model is free to call 9.8 km "about twelve minutes", which
    // is a number no tool gave it and which a road can easily double.
    const { context } = ctx();
    const out = await runCheapestNear({ place: 'Berwick', channel: 'sale' }, context);
    expect(JSON.stringify(out.result)).toContain('not drive time');
  });

  it('reports the listings it could not rank', async () => {
    // "Contact agent" carries no price and cannot be sorted as cheapest.
    // Dropping them silently would shrink the market without saying so.
    const { context } = ctx();
    const out = await runCheapestNear({ place: 'Berwick', channel: 'sale' }, context);
    const result = out.result as { unpriced?: number; unpricedNote?: string };
    expect(result.unpriced).toBe(3);
    expect(result.unpricedNote).toContain('contact agent');
  });

  it('prices a rental per week, not as a sale figure', async () => {
    const { context } = ctx();
    const out = await runCheapestNear({ place: 'Berwick', channel: 'rent' }, context);
    const result = out.result as { cheapest: { price: string }[] };
    expect(result.cheapest[0]!.price).toContain('per week');
  });

  it('carries the point into the slots, so the deep link matches the answer', async () => {
    const { context } = ctx();
    const out = await runCheapestNear({ place: 'Berwick', channel: 'sale' }, context);
    expect(out.slots?.channel).toBe('sale');
    expect(out.slots?.suburb).toBe('Berwick');
    expect(out.slots?.near?.radiusKm).toBe(20);
  });

  it('asks for a suburb rather than guessing when the place is unknown', async () => {
    const { context, asked } = ctx({ resolvePlace: vi.fn(async () => null) });
    const out = await runCheapestNear({ place: 'somewhere nice', channel: 'sale' }, context);

    expect(asked).toHaveLength(0);
    expect(JSON.stringify(out.result)).toContain('could not be located');
  });

  it('offers to widen rather than reporting an empty market as a fact', async () => {
    const { context } = ctx({
      nearbyMarket: vi.fn(async () => ({ listings: [], bySuburb: [], unpriced: 0 })),
    });
    const out = await runCheapestNear({ place: 'Berwick', channel: 'sale' }, context);
    expect(JSON.stringify(out.result)).toContain('widen the radius');
  });
});
