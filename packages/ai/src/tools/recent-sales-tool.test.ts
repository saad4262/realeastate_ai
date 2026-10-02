import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@repo/db';
import type { RecentSale, RecentSalesQuery } from '@repo/core/listings';
import type { ResolvedPlace } from '@repo/core/geo/schema';
import { runRecentSales, recentSalesInput } from './recent-sales-tool';
import type { ToolContext } from './context';

const PAKENHAM: ResolvedPlace = {
  formatted: 'Pakenham VIC 3810, Australia',
  unit: null,
  streetNumber: null,
  street: null,
  suburb: 'Pakenham',
  state: 'VIC',
  postcode: '3810',
  latitude: -38.0705,
  longitude: 145.4839,
  placeId: 'p-pakenham',
  kind: 'locality',
};

function sale(over: Partial<RecentSale> = {}): RecentSale {
  return {
    listingId: 'l-1',
    propertyId: 'p-1',
    address: '32/6E Henry Street, Pakenham, VIC 3810',
    suburb: 'Pakenham',
    state: 'VIC',
    postcode: '3810',
    soldPrice: 812_000,
    soldDate: new Date('2024-03-11T00:00:00Z'),
    agencyName: 'Harcourts',
    bedrooms: 3,
    bathrooms: 2,
    carSpaces: 1,
    propertyType: 'house',
    distanceKm: null,
    latitude: -38.0705,
    longitude: 145.4839,
    mainPhotoKey: null,
    priceDisplay: 'Offers over $780,000',
    total: 1,
    onMarketNow: false,
    liveListingId: null,
    ...over,
  };
}

function ctx(sales: RecentSale[], over: Partial<ToolContext> = {}) {
  const asked: RecentSalesQuery[] = [];
  const context: ToolContext = {
    db: {} as Db,
    places: new Map(),
    scheduling: { state: 'signed_out' },
    resolvePlace: vi.fn(async () => PAKENHAM),
    search: vi.fn(async () => []),
    getListing: vi.fn(async () => null),
    nearbyMarket: vi.fn(async () => ({ listings: [], bySuburb: [], unpriced: 0 })),
    recentSales: vi.fn(async (q: RecentSalesQuery) => {
      asked.push(q);
      return { rows: sales, total: sales.length };
    }),
    ...over,
  };
  return { context, asked };
}

describe('the recent sales tool', () => {
  it('hands the model formatted figures and never raw numbers', async () => {
    const { context } = ctx([sale()]);
    const outcome = await runRecentSales({ suburb: 'Pakenham' }, context);
    const result = outcome.result as { sales: Record<string, unknown>[] };

    /**
     * Non-negotiable #4. The model may copy these strings; it may not do
     * arithmetic on them, and nothing here gives it the raw numbers to try —
     * which is what makes "do not average them" in the prompt enforceable
     * rather than merely requested.
     */
    expect(result.sales[0]?.soldFor).toBe('$812,000');
    expect(result.sales[0]?.soldOn).toBe('11 March 2024');
    expect(JSON.stringify(result)).not.toContain('812000');
  });

  it('puts the link on the CARD, not in the text the model reads', async () => {
    /**
     * The bug this replaces: the tool handed the model a `historyPath`, the
     * prompt forbids writing links out, so the guide refused to give one — and
     * then invented that the sale was visible in a panel that was empty.
     *
     * The path lives on the frame the interface renders. The model is told the
     * sales are on screen and points there; it never needs a URL.
     */
    const { context } = ctx([sale({ onMarketNow: false })]);
    const outcome = await runRecentSales({ suburb: 'Pakenham' }, context);

    expect(outcome.salesFrame?.sales[0]?.historyPath).toBe('/property/p-1');
    // And nothing resembling a path reaches the model.
    expect(JSON.stringify(outcome.result)).not.toContain('/property/');
  });

  it('links a re-listed address to its live listing, and says it is for sale', async () => {
    // The live listing carries the same history, and its enquiry reaches the
    // agency selling the house now — not the off-market page, which is gone.
    const { context } = ctx([sale({ onMarketNow: true, liveListingId: 'l-live' })]);
    const outcome = await runRecentSales({ suburb: 'Pakenham' }, context);

    expect(outcome.salesFrame?.sales[0]?.historyPath).toBe('/listing/l-live');
    expect(outcome.salesFrame?.sales[0]?.forSaleNow).toBe(true);
    expect(JSON.stringify(outcome.result)).not.toContain('/listing/');
  });

  it('withholds the link when the address is under offer again', async () => {
    // Under offer has no public page at all — neither /property nor /listing —
    // so a card linking anywhere would 404.
    const { context } = ctx([sale({ onMarketNow: true, liveListingId: null })]);
    const outcome = await runRecentSales({ suburb: 'Pakenham' }, context);

    expect(outcome.salesFrame?.sales[0]?.historyPath).toBeNull();
    // The model still gets the fact, because it is worth saying out loud.
    const result = outcome.result as { sales: Record<string, unknown>[] };
    expect(String(result.sales[0]?.note)).toMatch(/on the market again/i);
  });

  it('formats every figure on the card, so the panel never renders model output', async () => {
    const { context } = ctx([sale({ distanceKm: 4.21 })]);
    const card = (await runRecentSales({ suburb: 'Pakenham', radiusKm: 10 }, context))
      .salesFrame?.sales[0];

    expect(card?.price).toBe('$812,000');
    expect(card?.soldOn).toBe('11 March 2024');
    expect(card?.distance).toBe('4.2 km');
    expect(card?.address).toContain('Henry Street');
  });

  it('defaults to two years and honours a period the visitor named', async () => {
    const { context, asked } = ctx([sale()]);
    await runRecentSales({ suburb: 'Pakenham' }, context);
    const defaulted = asked[0]?.since as Date;

    const { context: sixCtx, asked: sixAsked } = ctx([sale()]);
    await runRecentSales({ suburb: 'Pakenham', months: 6 }, sixCtx);
    const six = sixAsked[0]?.since as Date;

    // Both are computed from the clock at call time, which is safe here and
    // would not be in a system prompt (#5) — a tool input is never cached.
    expect(defaulted.getTime()).toBeLessThan(six.getTime());
  });

  it('resolves a radius itself and never takes coordinates from the model', async () => {
    expect(Object.keys(recentSalesInput.shape)).not.toContain('lat');
    expect(Object.keys(recentSalesInput.shape)).not.toContain('lng');

    const { context, asked } = ctx([sale({ distanceKm: 4.21 })]);
    const outcome = await runRecentSales({ suburb: 'Pakenham', radiusKm: 10 }, context);

    expect(asked[0]?.near).toEqual({ lat: -38.0705, lng: 145.4839, radiusKm: 10 });
    const result = outcome.result as { sales: Record<string, unknown>[]; distanceIs?: string };
    expect(result.sales[0]?.distance).toBe('4.2 km');
    // Straight-line, said in the payload rather than left for the model to
    // assume — the same rule cheapest_near follows.
    expect(result.distanceIs).toMatch(/straight-line/);
  });

  it('tells the model an empty result is not a quiet market', async () => {
    const { context } = ctx([]);
    const outcome = await runRecentSales({ suburb: 'Pakenham' }, context);
    const result = outcome.result as { found: number; note: string };

    expect(result.found).toBe(0);
    // The portal knows its own agencies' sales and nothing else. Reading
    // silence as "nothing sold" invents an observation from missing data.
    expect(result.note).toMatch(/does not mean the suburb is quiet/i);
  });

  it('warns the model these are not homes anyone can buy', async () => {
    const { context } = ctx([sale()]);
    const outcome = await runRecentSales({ suburb: 'Pakenham' }, context);
    expect(String((outcome.result as { note: string }).note)).toMatch(/not listings the visitor can buy/i);
  });

  it('does not guess a channel the visitor never gave', async () => {
    // Somebody asking what sold has not said they are buying. Filling in
    // `channel` here would put a filter in the sidebar they never chose.
    const { context } = ctx([sale()]);
    const outcome = await runRecentSales({ suburb: 'Pakenham' }, context);
    expect(outcome.slots).toEqual({ suburb: 'Pakenham' });
  });
});
