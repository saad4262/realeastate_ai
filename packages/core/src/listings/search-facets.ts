import { sql } from 'drizzle-orm';
import { listing, property, type Db } from '@repo/db';
import type { ListingChannel } from './listing-schema';
import { PUBLIC_STATUS } from './search-listings';

/**
 * What the search filters may offer, taken from what is actually listed.
 *
 * ## The bug this exists to remove
 *
 * Every filter on `/search` except property type offered a hard-coded ladder.
 * The sale price ladder started at $750,000; every live listing in this
 * database is under $50,000. So "From $0.75M" returned nothing, "5+ beds"
 * returned nothing, "4+ baths" returned nothing, "3+ car" returned nothing,
 * and the Rent tab returned nothing at all because there is not one rental on
 * the platform. Four of the six controls could only ever empty the page.
 *
 * Property type already had the right rule and said so in a comment — "only
 * types with something live in them, so no choice here can produce an empty
 * page by itself". This applies that rule to the rest.
 *
 * ## One query
 *
 * All of it, in a single statement, split by channel with FILTER. The
 * tempting shape is a query per facet — six round trips to a database in
 * another region for six short lists — and `query-count.test.ts` holds this to
 * one.
 *
 * ## Everything comes back as a string
 *
 * `numeric` columns arrive as text, `count(*)` as text because it is a bigint,
 * and `array_agg` as an array of text. That is the boundary bug
 * ARCHITECTURE.md § 6 names, in all three of its shapes, in one row. Converted
 * here, where the lie is created, and the tests assert the TYPE rather than
 * the value — `expect(x).toBe(3)` passes for `"3"`.
 */

/** One channel's worth of what exists. */
export type ChannelFacets = {
  /** Live listings in this channel. Zero means the whole tab is empty. */
  total: number;
  /**
   * Bedroom counts actually present, ascending. The UI offers these as "N+",
   * so the largest one is the largest that can still return a result.
   */
  bedrooms: number[];
  bathrooms: number[];
  carSpaces: number[];
  propertyTypes: string[];
  /**
   * The cheapest and dearest figure in this channel, in dollars.
   *
   * For sale that is `price_from` at the bottom and `price_to` (falling back
   * to `price_from`) at the top — a range listing's ceiling is its upper
   * bound, not its lower one. For rent it is `rent_pw` both ways.
   *
   * Null when nothing in the channel carries a price, which is possible: a
   * rental with no `rent_pw` is legal and shows as "Contact agent".
   */
  priceMin: number | null;
  priceMax: number | null;
};

export type SearchFacets = {
  sale: ChannelFacets;
  rent: ChannelFacets;
  /** Suburbs with something live, either channel. */
  suburbs: string[];
};

const int = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

const dec = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Distinct, ascending, and never a null or a nonsense value. */
function numbers(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<number>();
  for (const v of raw) {
    const n = Number(v);
    // Room counts are capped at 20 by the listing contract (phase 11), so
    // anything above that is a repaired-but-not-yet-repaired row rather than a
    // filter option worth offering.
    if (Number.isFinite(n) && n > 0 && n <= 20) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

function strings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const v of raw) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (s) out.add(s);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/**
 * `array_agg(distinct x) filter (where …)` per channel.
 *
 * `filter` rather than `case when` so the aggregate skips the row entirely
 * instead of folding a null into the array — the difference between
 * `{3,null}` and `{3}`, and the reason the helpers above do not have to strip
 * nulls they should never have been handed.
 */
function agg(column: ReturnType<typeof sql>, channel: ListingChannel) {
  return sql`array_agg(distinct ${column}) filter (where ${listing.channel} = ${channel} and ${column} is not null)`;
}

export async function searchFacets(db: Db): Promise<SearchFacets> {
  const saleTop = sql`coalesce(${listing.priceTo}, ${listing.priceFrom})`;

  const [row] = await db
    .select({
      suburbs: sql<string[]>`array_agg(distinct ${property.suburb})`,

      saleTotal: sql<string>`count(*) filter (where ${listing.channel} = 'sale')`,
      saleBedrooms: agg(sql`${property.bedrooms}`, 'sale'),
      saleBathrooms: agg(sql`${property.bathrooms}`, 'sale'),
      saleCarSpaces: agg(sql`${property.carSpaces}`, 'sale'),
      saleTypes: agg(sql`${property.propertyType}`, 'sale'),
      salePriceMin: sql<string | null>`min(${listing.priceFrom}) filter (where ${listing.channel} = 'sale')`,
      salePriceMax: sql<string | null>`max(${saleTop}) filter (where ${listing.channel} = 'sale')`,

      rentTotal: sql<string>`count(*) filter (where ${listing.channel} = 'rent')`,
      rentBedrooms: agg(sql`${property.bedrooms}`, 'rent'),
      rentBathrooms: agg(sql`${property.bathrooms}`, 'rent'),
      rentCarSpaces: agg(sql`${property.carSpaces}`, 'rent'),
      rentTypes: agg(sql`${property.propertyType}`, 'rent'),
      rentPriceMin: sql<string | null>`min(${listing.rentPw}) filter (where ${listing.channel} = 'rent')`,
      rentPriceMax: sql<string | null>`max(${listing.rentPw}) filter (where ${listing.channel} = 'rent')`,
    })
    .from(listing)
    .innerJoin(property, sql`${property.id} = ${listing.propertyId}`)
    .where(sql`${listing.status} = ${PUBLIC_STATUS}`);

  const empty: ChannelFacets = {
    total: 0,
    bedrooms: [],
    bathrooms: [],
    carSpaces: [],
    propertyTypes: [],
    priceMin: null,
    priceMax: null,
  };

  // No live listings at all: the aggregate returns one row of nulls, not no
  // rows, so this is about `row` being undefined only if the table is empty of
  // everything — but either way the filters have nothing to offer.
  if (!row) return { sale: empty, rent: { ...empty }, suburbs: [] };

  return {
    suburbs: strings(row.suburbs),
    sale: {
      total: int(row.saleTotal),
      bedrooms: numbers(row.saleBedrooms),
      bathrooms: numbers(row.saleBathrooms),
      carSpaces: numbers(row.saleCarSpaces),
      propertyTypes: strings(row.saleTypes),
      priceMin: dec(row.salePriceMin),
      priceMax: dec(row.salePriceMax),
    },
    rent: {
      total: int(row.rentTotal),
      bedrooms: numbers(row.rentBedrooms),
      bathrooms: numbers(row.rentBathrooms),
      carSpaces: numbers(row.rentCarSpaces),
      propertyTypes: strings(row.rentTypes),
      priceMin: dec(row.rentPriceMin),
      priceMax: dec(row.rentPriceMax),
    },
  };
}

export { priceLadder } from './price-ladder';
