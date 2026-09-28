import { sql } from 'drizzle-orm';
import { type Db } from '@repo/db';
import type { Near } from '../geo/place-schema';
import type { ListingChannel } from './listing-schema';

/**
 * "My office is here — where is the cheapest place near it?"
 *
 * A question the portal could not answer. `search_listings` can sort by price
 * OR by distance, never both, and the model is forbidden from doing the
 * arithmetic itself (non-negotiable #4: every number comes from SQL). So the
 * guide could list the cheapest anywhere in a suburb, or the nearest at any
 * price, and then had to hand-wave the trade-off in prose.
 *
 * This answers it in SQL, from one point, in two shapes at once:
 *
 *   listings  — the cheapest inside the radius, each with its own distance
 *   bySuburb  — per suburb inside the radius: how many, the cheapest, and how
 *               far the nearest one is
 *
 * The second is what turns "cheapest near me" into a useful answer. A visitor
 * asking it does not want one address; they want to know which direction to
 * look in, and that is a per-suburb question.
 *
 * ## Straight-line distance, and saying so
 *
 * ST_Distance over the geography column — the same metre-accurate great-circle
 * distance the search page already reports. It is NOT drive time. An office
 * 5 km away as the crow flies can be twenty minutes by road, and the wording
 * the guide uses has to keep that honest; a routing API would be a per-listing
 * network call and a bill, and was deliberately not taken.
 *
 * ## One query
 *
 * A CTE, then two aggregates over it. The tempting shape is one query for the
 * list and another for the breakdown, which doubles a round trip to a database
 * in another region for two halves of one answer. `query-count.test.ts` holds
 * this to one.
 */

export type NearbyListing = {
  id: string;
  address: string;
  suburb: string;
  state: string;
  postcode: string;
  bedrooms: number | null;
  bathrooms: number | null;
  carSpaces: number | null;
  propertyType: string | null;
  priceDisplay: string | null;
  /** The figure it was ranked by: sale price floor, or weekly rent. */
  price: number;
  distanceKm: number;
};

export type NearbySuburb = {
  suburb: string;
  state: string;
  postcode: string;
  /** Live, priced listings of this channel inside the radius. */
  count: number;
  cheapest: number;
  /** Kilometres from the point to the closest of them. */
  nearestKm: number;
};

export type NearbyMarket = {
  listings: NearbyListing[];
  bySuburb: NearbySuburb[];
  /**
   * Inside the radius, matching everything else, but carrying no price.
   *
   * "Contact agent" is a legal and common way to list, and such a listing
   * cannot be ranked as cheapest — including it would put an unknown price at
   * the top of a list sorted by price. Excluded from both aggregates and
   * counted here instead, so the guide can say so rather than silently
   * shrinking the market.
   */
  unpriced: number;
};

export type NearbyMarketQuery = {
  near: Near;
  channel: ListingChannel;
  bedrooms?: number;
  propertyType?: string;
  /** How many listings to return. The breakdown always covers every suburb. */
  limit?: number;
};

const DEFAULT_LIMIT = 8;
/** Enough to point somewhere; more is a results page, not an answer. */
const MAX_SUBURBS = 8;

const int = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

const dec = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

export async function nearbyMarket(
  db: Db,
  query: NearbyMarketQuery,
): Promise<NearbyMarket> {
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), 20);
  const isRent = query.channel === 'rent' || query.channel === 'leased';

  /**
   * What "cheapest" means, per channel.
   *
   * A sale listing is ranked by its floor — a range of $600k–$650k competes at
   * $600k, which is the number a buyer compares. A rental is ranked by
   * rent_pw, because a weekly rent and a sale price are different orders of
   * magnitude and must never be sorted in the same column.
   */
  const price = isRent
    ? sql`l.rent_pw`
    : sql`coalesce(l.price_from, l.price_to)`;

  const centre = sql`ST_SetSRID(ST_MakePoint(${query.near.lng}, ${query.near.lat}), 4326)::geography`;
  const withinMetres = query.near.radiusKm * 1000;

  const filters = [
    sql`l.status = 'live'`,
    sql`l.channel = ${query.channel}`,
    // geom is the generated geography column, GiST-indexed (migration 0006).
    // A property with no coordinates cannot be placed and is simply not near
    // anything — it drops out here rather than appearing at distance zero.
    sql`ST_DWithin(p.geom, ${centre}, ${withinMetres})`,
  ];
  if (query.bedrooms !== undefined) filters.push(sql`p.bedrooms >= ${query.bedrooms}`);
  if (query.propertyType) filters.push(sql`lower(p.property_type) = lower(${query.propertyType})`);

  const where = sql.join(filters, sql` and `);

  const rows = await db.execute(sql`
    with matched as (
      select
        l.id,
        l.price_display,
        p.suburb, p.state, p.postcode,
        p.unit, p.street_number, p.street,
        p.bedrooms, p.bathrooms, p.car_spaces, p.property_type,
        ${price} as price,
        round((ST_Distance(p.geom, ${centre}) / 1000)::numeric, 2) as distance_km
      from listing l
      join property p on p.id = l.property_id
      where ${where}
    ),
    priced as (select * from matched where price is not null)
    select
      (
        select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
          select * from priced
          -- Cheapest first, and the nearest of any tie. Two listings at the
          -- same price are not equally useful when one is twice as far.
          order by price asc, distance_km asc
          limit ${limit}
        ) t
      ) as listings,
      (
        select coalesce(json_agg(row_to_json(s)), '[]'::json) from (
          select suburb, state, postcode,
                 count(*)::int as count,
                 min(price) as cheapest,
                 min(distance_km) as nearest_km
          from priced
          group by suburb, state, postcode
          order by min(price) asc
          limit ${MAX_SUBURBS}
        ) s
      ) as by_suburb,
      (select count(*)::int from matched where price is null) as unpriced
  `);

  const row = (rows as unknown as Record<string, unknown>[])[0];
  if (!row) return { listings: [], bySuburb: [], unpriced: 0 };

  const rawListings = (row.listings ?? []) as Record<string, unknown>[];
  const rawSuburbs = (row.by_suburb ?? []) as Record<string, unknown>[];

  return {
    unpriced: int(row.unpriced),
    listings: rawListings.map((r) => ({
      id: String(r.id),
      address: formatParts(r),
      suburb: String(r.suburb),
      state: String(r.state),
      postcode: String(r.postcode),
      bedrooms: dec(r.bedrooms),
      bathrooms: dec(r.bathrooms),
      carSpaces: dec(r.car_spaces),
      propertyType: r.property_type === null ? null : String(r.property_type),
      priceDisplay: r.price_display === null ? null : String(r.price_display),
      // Non-null by construction — `priced` filters them out — but coerced
      // anyway: numeric through json_agg is a JSON number today and has been a
      // string at every other boundary in this codebase.
      price: dec(r.price) ?? 0,
      distanceKm: dec(r.distance_km) ?? 0,
    })),
    bySuburb: rawSuburbs.map((r) => ({
      suburb: String(r.suburb),
      state: String(r.state),
      postcode: String(r.postcode),
      count: int(r.count),
      cheapest: dec(r.cheapest) ?? 0,
      nearestKm: dec(r.nearest_km) ?? 0,
    })),
  };
}

/**
 * "12/1A Rogers Street" from its parts.
 *
 * Deliberately the street half only — the suburb, state and postcode are
 * separate fields on the row, and `formatAddress` in listing-schema.ts builds
 * the full one-line form from the same parts. Repeating the locality here
 * would make the guide say "Pakenham" twice in one sentence.
 */
function formatParts(r: Record<string, unknown>): string {
  const unit = r.unit ? `${String(r.unit)}/` : '';
  const number = r.street_number ? String(r.street_number) : '';
  const street = r.street ? String(r.street) : '';
  const line = `${unit}${number} ${street}`.trim();
  return line || String(r.suburb);
}
