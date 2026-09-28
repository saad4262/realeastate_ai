import { and, asc, desc, eq, gte, lte, or, sql, type SQL } from 'drizzle-orm';
import { agency, listing, property, type Db } from '@repo/db';
import type { Near } from '../geo/place-schema';
import { formatAddress, type ListingChannel, type SearchSort } from './listing-schema';

/**
 * A listing as a card shows it.
 *
 * Deliberately without `description`. That column is the agency's full body
 * copy — often hundreds of words — and the only thing that renders it is the
 * detail page. A search returns up to 48 rows, so carrying it here put 48 full
 * descriptions into the payload of every single search to display none of
 * them. `PublicListing` below adds it back for the one read that needs it.
 */
export type PublicListingSummary = {
  id: string;
  address: string;
  suburb: string;
  state: string;
  postcode: string;
  channel: ListingChannel;
  headline: string | null;
  priceDisplay: string | null;
  priceFrom: number | null;
  priceTo: number | null;
  rentPw: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  carSpaces: number | null;
  propertyType: string | null;
  landAreaSqm: number | null;
  latitude: number | null;
  longitude: number | null;
  /** Kilometres from the searched point. Null when no point was searched. */
  distanceKm: number | null;
  agencyName: string;
  agents: string[];
  publishedAt: Date | null;
  /**
   * The cover photo's storage KEY, or null when the listing has no photos.
   *
   * A key, not a URL — `mediaUrl()` in packages/core/src/media is the only
   * thing that turns one into the other, which is what keeps the host out of
   * every row and every component. See media/storage-key.ts.
   */
  mainPhotoKey: string | null;
};

/**
 * One listing in full, for the detail page and for the get_listing tool.
 *
 * The description is fenced and labelled as data when it reaches the model —
 * it is agency-authored free text on a multi-tenant portal, so it is exactly
 * where someone would write "ignore previous instructions". A search never
 * returns it, and a unit test asserts that.
 */
export type PublicListing = PublicListingSummary & {
  description: string | null;
  /** The physical place this ad is written against — the key to its history. */
  propertyId: string;
};

/**
 * Re-exported from ./listing-schema, which is where the vocabularies live.
 *
 * It moved because this module imports `@repo/db`, and therefore postgres.js.
 * Anything that wants only the list of sort options — a zod schema, a form —
 * was dragging a database driver in behind it to get four strings. That has
 * already happened once here, as a client component importing the barrel and
 * failing to build with `Can't resolve 'fs'`.
 *
 * Kept exported from this module so no existing call site had to change.
 */
export { SORT_OPTIONS, type SearchSort } from './listing-schema';

export type PublicSearchQuery = {
  text?: string;
  /**
   * The suburb the visitor actually chose.
   *
   * On its own this is an exact match — "Pakenham" means Pakenham, not the
   * things around it. Paired with `near` it is a union, not a narrowing:
   * everything in Pakenham PLUS everything within the radius. A large suburb
   * can be wider than the radius drawn from its centre, and dropping half of
   * Pakenham from a search for Pakenham is not something to explain away.
   */
  suburb?: string;
  /** Disambiguates the suburb. There is a Richmond in four states. */
  state?: string;
  postcode?: string;
  channel?: ListingChannel;
  /**
   * For sale these read price_from / price_to; for rent they read rent_pw.
   * A tenant filtering "up to $900" means per week, and matching that against
   * a sale price range returns every rental ever listed.
   */
  priceFrom?: number;
  priceTo?: number;
  bedrooms?: number;
  bathrooms?: number;
  carSpaces?: number;
  propertyType?: string;
  /** Minimum land size in m², for buyers who care about the block. */
  landFrom?: number;
  /** A point and a radius. Requires the property to have been geocoded. */
  near?: Near;
  sort?: SearchSort;
  limit?: number;
  /** Rows to skip. Page N of a paged search is (N - 1) * limit. */
  offset?: number;
};

const num = (v: string | number | null): number | null => {
  if (v === null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * The consumer site shows live listings only.
 *
 * Drafts are the agency's working copy and withdrawn ones are gone on purpose,
 * so this is the single place that decides what the public can see — no caller
 * gets to widen it by passing a status.
 */
export const PUBLIC_STATUS = 'live' as const;

/** A rental's price lives in a different column from a sale's. */
function isRental(channel: ListingChannel | undefined): boolean {
  return channel === 'rent' || channel === 'leased';
}

/**
 * The generated geography column.
 *
 * Referenced as raw SQL because it is deliberately absent from the Drizzle
 * schema: Drizzle has no geography type, and a hand-modelled duplicate would
 * be a second place for a property's location to live — and would tempt the
 * next `drizzle-kit generate` into rewriting a column Postgres maintains.
 */
export const PROPERTY_GEOM = sql`${property}.geom`;

/** The name this file has always used. Same expression, one definition. */
const GEOM = PROPERTY_GEOM;

/**
 * Distance to the searched point, in kilometres.
 *
 * geom is indexed with GiST (migration 0006), so this is a spatial operation
 * rather than trigonometry over every row.
 */
function distanceExpr(near: Near | undefined) {
  if (!near) return sql<string | null>`null::numeric`;
  return sql<string | null>`round((ST_Distance(
    ${GEOM},
    ST_SetSRID(ST_MakePoint(${near.lng}, ${near.lat}), 4326)::geography
  ) / 1000)::numeric, 2)`;
}

/** The columns a card needs. No description — see PublicListingSummary. */
function selection(near: Near | undefined) {
  return {
    id: listing.id,
    channel: listing.channel,
    headline: listing.headline,
    priceDisplay: listing.priceDisplay,
    priceFrom: listing.priceFrom,
    priceTo: listing.priceTo,
    rentPw: listing.rentPw,
    publishedAt: listing.publishedAt,
    createdAt: listing.createdAt,
    unit: property.unit,
    streetNumber: property.streetNumber,
    street: property.street,
    suburb: property.suburb,
    state: property.state,
    postcode: property.postcode,
    bedrooms: property.bedrooms,
    bathrooms: property.bathrooms,
    carSpaces: property.carSpaces,
    propertyType: property.propertyType,
    landAreaSqm: property.landAreaSqm,
    latitude: property.latitude,
    longitude: property.longitude,
    distanceKm: distanceExpr(near),
    agencyName: agency.name,
    /**
     * Agent names inline instead of a second query keyed by listing id — that
     * follow-up was a full round trip to the database region for data the
     * first statement could have carried.
     */
    agentNames: sql<string[]>`coalesce((
      select array_agg(la.snapshot_name order by la.display_order)
      from listing_agent la where la.listing_id = ${listing.id}
    ), '{}')`,
    /**
     * The cover photo, in the SAME statement.
     *
     * The tempting shape is to fetch the rows and then ask for each one's main
     * photo, which on a page of 24 results is 24 extra round trips to a
     * database in another region — the N+1 that query-count.test.ts exists to
     * refuse, and the one that would be easiest to introduce here because it
     * reads perfectly well in a component.
     *
     * `is_main desc` then `sort_order` rather than `where is_main` alone: a
     * listing whose cover was deleted has photos and no main one for as long
     * as it takes the promotion in removeListingPhoto to run, and a gallery
     * that empties itself mid-delete is worse than one showing the next photo.
     */
    mainPhotoKey: sql<string | null>`(
      select m.storage_key from media m
      where m.listing_id = ${listing.id} and m.kind = 'photo'
      order by m.is_main desc, m.sort_order asc, m.created_at asc
      limit 1
    )`,
    /**
     * How many rows matched before LIMIT, counted by the same statement.
     *
     * A window function rather than a second SELECT, so a paged search still
     * costs exactly one round trip to the database region and query-count.test
     * stays true. A separate COUNT(*) would also have to re-run every filter,
     * including the PostGIS distance predicate, to answer a question this
     * statement has already done the work for.
     */
    totalCount: sql<number>`count(*) over()`,
  } as const;
}

/** The same columns plus the body copy, for the single-listing read. */
function detailSelection() {
  return {
    ...selection(undefined),
    description: listing.description,
    // Detail only. The property's history is keyed by the property — a
    // property outlives its listings (#1) — and there is no way to ask for it
    // without this. Deliberately NOT on the summary: a search returns 48 rows
    // and none of them needs it.
    propertyId: listing.propertyId,
  } as const;
}

function toSummary(r: Record<string, unknown>, agents: string[]): PublicListingSummary {
  const row = r as {
    id: string; channel: string; headline: string | null;
    priceDisplay: string | null; priceFrom: string | null; priceTo: string | null;
    rentPw: string | null; publishedAt: Date | null; unit: string | null;
    streetNumber: string | null; street: string | null; suburb: string; state: string;
    postcode: string; bedrooms: number | null; bathrooms: string | null;
    carSpaces: number | null; propertyType: string | null; landAreaSqm: string | null;
    latitude: string | null; longitude: string | null; distanceKm: string | null;
    agencyName: string; mainPhotoKey: string | null;
  };
  return {
    id: row.id,
    address: formatAddress(row),
    suburb: row.suburb,
    state: row.state,
    postcode: row.postcode,
    channel: row.channel as ListingChannel,
    headline: row.headline,
    priceDisplay: row.priceDisplay,
    priceFrom: num(row.priceFrom),
    priceTo: num(row.priceTo),
    rentPw: num(row.rentPw),
    bedrooms: row.bedrooms,
    bathrooms: num(row.bathrooms),
    carSpaces: row.carSpaces,
    propertyType: row.propertyType,
    landAreaSqm: num(row.landAreaSqm),
    latitude: num(row.latitude),
    longitude: num(row.longitude),
    distanceKm: num(row.distanceKm),
    agencyName: row.agencyName,
    agents,
    publishedAt: row.publishedAt,
    mainPhotoKey: row.mainPhotoKey ?? null,
  };
}

function toDetail(r: Record<string, unknown>, agents: string[]): PublicListing {
  const row = r as { description: string | null; propertyId: string };
  return { ...toSummary(r, agents), description: row.description, propertyId: row.propertyId };
}

/**
 * Everything but the geography, so the filter list has one definition.
 */
function baseFilters(query: PublicSearchQuery): SQL[] {
  const filters: SQL[] = [eq(listing.status, PUBLIC_STATUS)];

  if (query.channel) filters.push(eq(listing.channel, query.channel));

  // Suburb and radius are decided together in locationFilter below, because
  // they combine rather than stack.
  if (query.bedrooms !== undefined) filters.push(gte(property.bedrooms, query.bedrooms));
  if (query.bathrooms !== undefined) {
    filters.push(gte(property.bathrooms, String(query.bathrooms)));
  }
  if (query.carSpaces !== undefined) filters.push(gte(property.carSpaces, query.carSpaces));
  if (query.landFrom !== undefined) {
    filters.push(gte(property.landAreaSqm, String(query.landFrom)));
  }
  if (query.propertyType) {
    filters.push(
      eq(sql`lower(coalesce(${property.propertyType}, ''))`, query.propertyType.trim().toLowerCase()),
    );
  }

  if (isRental(query.channel)) {
    // One number per rental, so both bounds read the same column. A listing
    // with no rent set is not excluded by a bound it never claimed.
    if (query.priceTo !== undefined) {
      filters.push(or(lte(listing.rentPw, String(query.priceTo)), sql`${listing.rentPw} is null`)!);
    }
    if (query.priceFrom !== undefined) {
      filters.push(
        or(gte(listing.rentPw, String(query.priceFrom)), sql`${listing.rentPw} is null`)!,
      );
    }
  } else {
    // An asking range overlaps the searched range if it starts below the top
    // and ends above the bottom. Price filters read price_from / price_to,
    // never price_display — non-negotiable #6: the display string is copy, and
    // parsing "Offers over $1.2M" at query time is how the two drift apart.
    if (query.priceTo !== undefined) {
      filters.push(
        or(lte(listing.priceFrom, String(query.priceTo)), sql`${listing.priceFrom} is null`)!,
      );
    }
    if (query.priceFrom !== undefined) {
      filters.push(
        or(gte(listing.priceTo, String(query.priceFrom)), sql`${listing.priceTo} is null`)!,
      );
    }
  }

  const text = query.text?.trim();
  if (text) {
    const like = `%${text.toLowerCase()}%`;
    filters.push(
      or(
        sql`lower(${property.suburb}) like ${like}`,
        sql`lower(coalesce(${property.street}, '')) like ${like}`,
        sql`lower(coalesce(${listing.headline}, '')) like ${like}`,
        sql`${property.postcode} like ${like}`,
      )!,
    );
  }

  return filters;
}

/** Listings whose address is in this suburb, by name rather than by distance. */
function suburbMatch(query: PublicSearchQuery): SQL | null {
  const suburb = query.suburb?.trim();
  if (!suburb) return null;

  const parts: SQL[] = [eq(sql`lower(${property.suburb})`, suburb.toLowerCase())];
  // There is a Richmond in NSW, VIC, QLD, SA and TAS. When the visitor picked
  // from the dropdown we know which one they meant, so we say so.
  if (query.state) parts.push(eq(sql`upper(${property.state})`, query.state.trim().toUpperCase()));
  if (query.postcode) parts.push(eq(property.postcode, query.postcode.trim()));

  return and(...parts)!;
}

/**
 * Where to look: the named suburb, the circle around it, or both.
 *
 * Both is the case that matters and the one that was wrong. "Pakenham" alone
 * means exactly Pakenham. "Pakenham within 10 km" means Pakenham **and** its
 * surrounds — the radius adds neighbours, it does not filter Pakenham down to
 * the part of itself that sits near its own centroid. Pakenham is about 8 km
 * across, so a 5 km radius from the middle would have silently dropped homes
 * on its edges from a search for their own suburb.
 *
 * The union also removes the need for a separate unpinned-listing fallback: a
 * property with no coordinates is invisible to ST_DWithin but still matches
 * its suburb by name.
 */
function locationFilter(query: PublicSearchQuery): SQL | null {
  const byName = suburbMatch(query);

  if (!query.near) return byName;

  const centre = sql`ST_SetSRID(ST_MakePoint(${query.near.lng}, ${query.near.lat}), 4326)::geography`;
  const within = sql`ST_DWithin(${GEOM}, ${centre}, ${query.near.radiusKm * 1000})`;

  return byName ? or(byName, within)! : within;
}

/**
 * Every ordering ends with the listing id, and that is not decoration.
 *
 * None of these was deterministic before it. Two listings published in the same
 * second tie on published_at and created_at; two priced the same tie outright;
 * every listing with no price at all ties in the NULLS LAST bucket. Postgres is
 * free to return tied rows in any order it likes, and it does not have to
 * choose the same one twice.
 *
 * That is invisible on a single page of results and breaks the moment there is
 * a second one: a row that ties across the page boundary can appear on both
 * pages, or on neither. A unique tiebreaker is what makes paging through a
 * result set mean anything.
 */
function orderFor(sort: SearchSort | undefined, near: Near | undefined) {
  switch (sort) {
    case 'price_asc':
      // NULLS LAST, or every "contact agent" listing crowds the top of a list
      // the user sorted precisely because they care about price.
      return [
        sql`coalesce(${listing.priceFrom}, ${listing.rentPw}) asc nulls last`,
        asc(listing.id),
      ];
    case 'price_desc':
      return [
        sql`coalesce(${listing.priceFrom}, ${listing.rentPw}) desc nulls last`,
        desc(listing.id),
      ];
    case 'newest':
      return [desc(listing.publishedAt), desc(listing.createdAt), desc(listing.id)];
    default:
      // Nearest first when a point was given — that is what "relevance" means
      // to somebody who just searched a location. Otherwise, newest.
      return near
        ? [sql`${distanceExpr(near)} asc nulls last`, desc(listing.publishedAt), asc(listing.id)]
        : [desc(listing.publishedAt), desc(listing.createdAt), desc(listing.id)];
  }
}

/**
 * One page of a public search, plus how many rows there were in total.
 *
 * Offset rather than a keyset cursor, and that is a deliberate reversal of what
 * was planned. A keyset scheme is the right answer for an unbounded feed; this
 * is a bounded result set that people read as "page 2 of 5" and whose summary
 * line already quotes a total. Offset keeps the total and the page numbers,
 * both of which a cursor gives up — and the keyset predicate for these
 * orderings would need three branches each to handle ASC/DESC with NULLS LAST,
 * which is a lot of surface to get subtly wrong for a result set measured in
 * hundreds.
 *
 * The duplicate-and-skip problem offset is usually accused of comes from ties,
 * not from offset: see orderFor, where every ordering now ends with the id.
 */
export async function searchPublicListingsPage(
  db: Db,
  query: PublicSearchQuery = {},
): Promise<{ rows: PublicListingSummary[]; total: number }> {
  const limit = Math.min(Math.max(query.limit ?? 24, 1), 100);
  const offset = Math.max(query.offset ?? 0, 0);
  const filters = baseFilters(query);

  const location = locationFilter(query);
  if (location) filters.push(location);

  const rows = await db
    .select(selection(query.near))
    .from(listing)
    .innerJoin(property, eq(property.id, listing.propertyId))
    .innerJoin(agency, eq(agency.id, listing.agencyId))
    .where(and(...filters))
    .orderBy(...orderFor(query.sort, query.near))
    .limit(limit)
    .offset(offset);

  return {
    rows: rows.map((r) => toSummary(r, (r.agentNames as string[]) ?? [])),
    // count(*) over() is on every row and identical; no rows means no matches.
    total: Number((rows[0] as { totalCount?: number } | undefined)?.totalCount ?? 0),
  };
}

/**
 * Public listing search. Live only, and never widened by a caller.
 *
 * Reads through the paged version rather than building its own statement, so
 * the two can never drift apart on a filter or an ordering.
 */
export async function searchPublicListings(
  db: Db,
  query: PublicSearchQuery = {},
): Promise<PublicListingSummary[]> {
  return (await searchPublicListingsPage(db, query)).rows;
}

/** One live listing for the public detail page. Drafts stay invisible. */
export async function getPublicListing(db: Db, id: string): Promise<PublicListing | null> {
  const [row] = await db
    .select(detailSelection())
    .from(listing)
    .innerJoin(property, eq(property.id, listing.propertyId))
    .innerJoin(agency, eq(agency.id, listing.agencyId))
    .where(and(eq(listing.id, id), eq(listing.status, PUBLIC_STATUS)))
    .limit(1);

  if (!row) return null;
  return toDetail(row, (row.agentNames as string[]) ?? []);
}

/** Suburbs that currently have something live, for the search box. */
export async function liveSuburbs(db: Db): Promise<string[]> {
  const rows = await db
    .selectDistinct({ suburb: property.suburb })
    .from(listing)
    .innerJoin(property, eq(property.id, listing.propertyId))
    .where(eq(listing.status, PUBLIC_STATUS))
    .orderBy(property.suburb);
  return rows.map((r) => r.suburb);
}

/**
 * Property types with something live in them, so the filter only ever offers
 * a choice that can return a result.
 */
export async function livePropertyTypes(db: Db): Promise<string[]> {
  const rows = await db
    .selectDistinct({ propertyType: property.propertyType })
    .from(listing)
    .innerJoin(property, eq(property.id, listing.propertyId))
    .where(and(eq(listing.status, PUBLIC_STATUS), sql`${property.propertyType} is not null`))
    .orderBy(property.propertyType);
  return rows.map((r) => r.propertyType).filter((t): t is string => Boolean(t));
}
