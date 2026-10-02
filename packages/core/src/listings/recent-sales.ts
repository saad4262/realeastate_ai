import { and, asc, desc, eq, gte, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import { agency, listing, property, type Db } from '@repo/db';
import { formatAddress } from './listing-schema';
import type { Near } from '../geo/place-schema';

/**
 * What has recently SOLD in an area.
 *
 * Deliberately its own read rather than a flag on `searchPublicListings`. That
 * function is the single place that decides what the public may see of the
 * LIVE market, and `PUBLIC_STATUS` is the constant that decides it — widening
 * it with a parameter would put "show me sold ones" one argument away from
 * every caller, including the alerts scheduler and the email digests. The two
 * questions are different questions, so they are different statements.
 *
 * ## What it may return, and why that is not a leak
 *
 * `status = 'sold'` only. That status is in `HISTORIC_STATUSES` — the list that
 * decides what a member of the public was ever allowed to see — so every row
 * here is an ad that was public while it ran, with a price the agency entered
 * and published. Drafts, pending and withdrawn are all excluded by the same
 * rule that keeps them off the property timeline.
 *
 * `sold_price is not null` as well: a sold row with no figure tells a visitor
 * nothing and cannot be ranked. `pnpm smoke` refuses to find such a row, so in
 * practice this filter removes nothing — it is here so this read does not
 * depend on that check still existing.
 */
export type RecentSale = {
  listingId: string;
  /** The property, so a caller can link to its page when it has one. */
  propertyId: string;
  address: string;
  suburb: string;
  state: string;
  postcode: string;
  soldPrice: number;
  soldDate: Date;
  agencyName: string;
  bedrooms: number | null;
  bathrooms: number | null;
  carSpaces: number | null;
  propertyType: string | null;
  /** How many sales matched before LIMIT. Same on every row. */
  total: number;
  /** Straight-line kilometres from the searched point, when one was given. */
  distanceKm: number | null;
  /**
   * The pin, so a sale can go on the same map a live result does.
   *
   * Null when the address was never geocoded — it is simply not placeable, and
   * the map counts those rather than dropping them silently.
   */
  latitude: number | null;
  longitude: number | null;
  /** The cover photo's storage KEY. A key, not a URL — `mediaUrl` makes those. */
  mainPhotoKey: string | null;
  /** What the ad said before it sold, when it said anything. */
  priceDisplay: string | null;
  /**
   * Whether this address is back on the market.
   *
   * A sale is history; the property it happened to may have been re-listed
   * since. A caller offering a link to /property/[id] has to know, because that
   * page refuses to exist while anything at the address is live or under offer
   * — and a link that 404s is worse than no link.
   */
  onMarketNow: boolean;
  /**
   * The live ad at this address now, when there is one.
   *
   * Narrower than `onMarketNow`: an `under_offer` listing is on the market but
   * has no public page. When this is set the sale's history lives on that
   * listing's page, which carries it — see `saleHistoryPath`.
   */
  liveListingId: string | null;
};

export { saleHistoryPath } from './format';

export type RecentSalesQuery = {
  suburb?: string;
  state?: string;
  near?: Near;
  /** Only sales on or after this date. */
  since?: Date;
  bedrooms?: number;
  propertyType?: string;
  /**
   * `newest` (the default) is by sale date. `nearest` needs `near` and falls
   * back to `newest` without one — a distance from nowhere orders nothing.
   */
  sort?: RecentSalesSort;
  limit?: number;
  offset?: number;
};

export type RecentSalesSort = 'newest' | 'price_asc' | 'price_desc' | 'nearest';

/** A page of sales, with the total for the pager. */
export type RecentSalesPage = {
  rows: RecentSale[];
  total: number;
};

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 48;

function orderFor(sort: RecentSalesSort | undefined, centre: SQL | null): SQL[] {
  switch (sort) {
    case 'price_asc':
      return [asc(listing.soldPrice), desc(listing.soldDate)];
    case 'price_desc':
      return [desc(listing.soldPrice), desc(listing.soldDate)];
    case 'nearest':
      if (centre) {
        return [
          sql`ST_Distance(${sql.raw('property.geom')}, ${centre}) asc nulls last`,
          desc(listing.soldDate),
        ];
      }
      return [desc(listing.soldDate)];
    default:
      return [desc(listing.soldDate)];
  }
}

/** numeric and decimal arrive from the driver as strings. Never NaN. */
const num = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

export async function recentSales(db: Db, query: RecentSalesQuery): Promise<RecentSale[]> {
  const centre = query.near
    ? sql`ST_SetSRID(ST_MakePoint(${query.near.lng}, ${query.near.lat}), 4326)::geography`
    : null;

  const filters: SQL[] = [
    eq(listing.status, 'sold'),
    isNotNull(listing.soldPrice),
    isNotNull(listing.soldDate),
  ];

  /**
   * The suburb itself, OR the circle around it — the union /search draws.
   *
   * ANDing the two meant "within 30 km of Pakenham" could only ever return
   * Pakenham: the radius narrowed the suburb instead of widening it, and a
   * neighbour 5 km away never appeared. State belongs to the suburb half; the
   * circle is already exact.
   */
  const inSuburb = query.suburb
    ? and(
        sql`lower(${property.suburb}) = lower(${query.suburb})`,
        query.state ? sql`upper(${property.state}) = upper(${query.state})` : undefined,
      )
    : query.state
      ? sql`upper(${property.state}) = upper(${query.state})`
      : undefined;
  if (query.since) filters.push(gte(listing.soldDate, query.since));
  if (query.bedrooms !== undefined) filters.push(sql`${property.bedrooms} >= ${query.bedrooms}`);
  if (query.propertyType) {
    filters.push(sql`lower(${property.propertyType}) = lower(${query.propertyType})`);
  }
  if (centre) {
    // geom is the generated geography column, GiST-indexed (migration 0006).
    // A property with no pin cannot be placed and is near nothing, so it drops
    // out of the circle rather than appearing at distance zero.
    const inCircle = sql`ST_DWithin(${sql.raw('property.geom')}, ${centre}, ${query.near!.radiusKm * 1000})`;
    filters.push(inSuburb ? (or(inSuburb, inCircle) as SQL) : inCircle);
  } else if (inSuburb) {
    filters.push(inSuburb);
  }

  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  const rows = await db
    .select({
      listingId: listing.id,
      propertyId: listing.propertyId,
      unit: property.unit,
      streetNumber: property.streetNumber,
      street: property.street,
      suburb: property.suburb,
      state: property.state,
      postcode: property.postcode,
      soldPrice: listing.soldPrice,
      soldDate: listing.soldDate,
      agencyName: agency.name,
      bedrooms: property.bedrooms,
      bathrooms: property.bathrooms,
      carSpaces: property.carSpaces,
      propertyType: property.propertyType,
      latitude: property.latitude,
      longitude: property.longitude,
      priceDisplay: listing.priceDisplay,
      mainPhotoKey: sql<string | null>`(
        select m.storage_key from media m
        where m.listing_id = ${listing.id} and m.kind = 'photo'
        order by m.is_main desc, m.sort_order asc, m.created_at asc
        limit 1
      )`,
      /** Counted by the same statement, so a paged browse still costs one query. */
      totalCount: sql<number>`count(*) over()`,
      distanceKm: centre
        ? sql<string | null>`ST_Distance(${sql.raw('property.geom')}, ${centre}) / 1000`
        : sql<string | null>`null`,
      /**
       * Is this address live again right now?
       *
       * An inline EXISTS rather than a second query per row — that would be an
       * N+1 that grows with the number of sales shown, and query-count.test.ts
       * holds this read to one statement.
       */
      onMarketNow: sql<boolean>`exists (
        select 1 from listing relisted
        where relisted.property_id = ${listing.propertyId}
          and relisted.status in ('live', 'under_offer')
      )`,
      /** Same statement, same reason. At most one live ad per address. */
      liveListingId: sql<string | null>`(
        select live.id from listing live
        where live.property_id = ${listing.propertyId}
          and live.status = 'live'
        order by live.published_at desc nulls last
        limit 1
      )`,
    })
    .from(listing)
    .innerJoin(property, eq(property.id, listing.propertyId))
    .innerJoin(agency, eq(agency.id, listing.agencyId))
    .where(and(...filters))
    // Newest sale first unless asked otherwise. `id` breaks every tie so
    // paging and repeat calls are stable.
    .orderBy(...orderFor(query.sort, centre), desc(listing.id))
    .limit(limit)
    .offset(Math.max(query.offset ?? 0, 0));

  return rows.map((r) => ({
    listingId: r.listingId,
    propertyId: r.propertyId,
    address: formatAddress(r),
    suburb: r.suburb,
    state: r.state,
    postcode: r.postcode,
    // numeric arrives from the driver as a string; the filters above guarantee
    // neither of these is null.
    soldPrice: Number(r.soldPrice),
    soldDate: r.soldDate as Date,
    agencyName: r.agencyName,
    bedrooms: r.bedrooms,
    bathrooms: num(r.bathrooms),
    carSpaces: r.carSpaces,
    propertyType: r.propertyType,
    total: Number(r.totalCount ?? 0),
    distanceKm: num(r.distanceKm),
    latitude: num(r.latitude),
    longitude: num(r.longitude),
    priceDisplay: r.priceDisplay,
    mainPhotoKey: r.mainPhotoKey ?? null,
    onMarketNow: Boolean(r.onMarketNow),
    liveListingId: r.liveListingId ?? null,
  }));
}

/**
 * The same read, with the total beside it, for a page somebody can browse.
 *
 * Delegates rather than duplicating the query, so the browse page and the
 * guide can never disagree about what has sold — the same reason
 * `searchPublicListings` delegates to its paged form.
 */
export async function recentSalesPage(
  db: Db,
  query: RecentSalesQuery,
): Promise<RecentSalesPage> {
  const rows = await recentSales(db, query);
  // `total` is a window function, so every row carries the same figure and an
  // empty result simply has nowhere to carry one.
  return { rows, total: rows[0]?.total ?? 0 };
}
