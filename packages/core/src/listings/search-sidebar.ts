import { and, eq, sql, type SQL } from 'drizzle-orm';
import { agency, listing, listingAgent, property, type Db } from '@repo/db';
import type { Near } from '../geo/place-schema';
import type { ListingChannel } from './listing-schema';
import { PROPERTY_GEOM, PUBLIC_STATUS } from './search-listings';

/**
 * The two panels beside a results page, and nothing else.
 *
 * A portal's sidebar is mostly market data — medians, days on market, rental
 * yield, twelve-month trends. This platform has no market data source, and a
 * plausible-looking median is exactly the invented number non-negotiable #4
 * exists to forbid. So the sidebar is built from the only two things this
 * database can actually answer: who is selling in this suburb, and where else
 * has something for sale nearby.
 *
 * Both are aggregates over live listings. Each is ONE query — a per-suburb or
 * per-agent follow-up would be an N+1 on a page that already runs a search,
 * and query-count.test.ts holds both to one.
 */

/** Both panels are small on purpose: a sidebar, not a second results list. */
const DEFAULT_LIMIT = 4;

/**
 * count(*) comes back as a string.
 *
 * Postgres counts in bigint, which node-postgres hands over as text because a
 * bigint does not fit a JS number safely. The type says `number` and the value
 * is `"3"`, so `total + 1` is `"31"` — the first shape of the boundary bug
 * ARCHITECTURE.md § 6 names. Converted here, where the lie is created.
 */
const int = (v: string | number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** numeric comes back as a string too, and a null distance must stay null. */
const dec = (v: string | number | null): number | null => {
  if (v === null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

export type PublicSuburbAgent = {
  userId: string;
  name: string;
  agencyName: string;
  /** Live listings this agent is on, in this suburb. A real count, not a rank. */
  listingCount: number;
};

export type PublicNearbySuburb = {
  suburb: string;
  state: string;
  postcode: string;
  listingCount: number;
  /**
   * Kilometres from the searched centre to the closest listing in that suburb.
   * Null when the search had no centre, or when nothing there is geocoded.
   */
  distanceKm: number | null;
};

type Scope = {
  suburb?: string;
  state?: string;
  channel?: ListingChannel;
  limit?: number;
};

/** Live only, and the same channel the visitor is browsing. */
function scopeFilters(scope: Scope): SQL[] {
  const filters: SQL[] = [eq(listing.status, PUBLIC_STATUS)];
  if (scope.channel) filters.push(eq(listing.channel, scope.channel));
  if (scope.state) filters.push(sql`lower(${property.state}) = lower(${scope.state})`);
  return filters;
}

/**
 * The agents with the most live listings in a suburb.
 *
 * Grouped by `user_id` rather than by the snapshot name. listing_agent
 * snapshots a name per listing on purpose — the ad keeps showing who to call
 * after that person changes their number or leaves — so an agent who was
 * "Dan Vance" on one listing and "Daniel Vance" on the next would otherwise
 * appear twice with half their count each. `max()` picks one spelling; the
 * count is over distinct listings either way.
 */
export async function topSuburbAgents(
  db: Db,
  scope: Scope & { suburb: string },
): Promise<PublicSuburbAgent[]> {
  const listings = sql<string>`count(distinct ${listing.id})`;

  const rows = await db
    .select({
      userId: listingAgent.userId,
      name: sql<string>`max(${listingAgent.snapshotName})`,
      agencyName: sql<string>`max(${agency.name})`,
      listingCount: listings,
    })
    .from(listingAgent)
    .innerJoin(listing, eq(listing.id, listingAgent.listingId))
    .innerJoin(property, eq(property.id, listing.propertyId))
    .innerJoin(agency, eq(agency.id, listing.agencyId))
    .where(
      and(
        ...scopeFilters(scope),
        sql`lower(${property.suburb}) = lower(${scope.suburb})`,
      ),
    )
    .groupBy(listingAgent.userId)
    .orderBy(sql`${listings} desc, max(${listingAgent.snapshotName}) asc`)
    .limit(scope.limit ?? DEFAULT_LIMIT);

  return rows.map((r) => ({
    userId: r.userId,
    name: r.name,
    agencyName: r.agencyName,
    listingCount: int(r.listingCount),
  }));
}

/**
 * Other suburbs worth a look, ordered by how close they actually are.
 *
 * With a centre, distance is `min(ST_Distance(...))` over that suburb's
 * geocoded listings — the closest one, because "Officer is 5 km away" should
 * mean its nearest property, not the average of a suburb's spread. geom is
 * GiST-indexed (migration 0006), and this is an aggregate over rows the search
 * scope has already narrowed.
 *
 * Without a centre there is nothing to measure from, so the order falls back to
 * how much is listed — which is the useful answer to "where else should I
 * look" when the visitor has not named a place.
 *
 * A suburb that spans two postcodes appears once per postcode. That is what the
 * data says, and collapsing it would mean picking a postcode to show.
 */
export async function nearbySuburbs(
  db: Db,
  scope: Scope & { near?: Near } = {},
): Promise<PublicNearbySuburb[]> {
  const listings = sql<string>`count(distinct ${listing.id})`;

  const distance = scope.near
    ? sql<string | null>`round((min(ST_Distance(
        ${PROPERTY_GEOM},
        ST_SetSRID(ST_MakePoint(${scope.near.lng}, ${scope.near.lat}), 4326)::geography
      )) / 1000)::numeric, 1)`
    : sql<string | null>`null::numeric`;

  const filters = scopeFilters(scope);
  // The suburb the visitor is already looking at is not a suggestion.
  if (scope.suburb) {
    filters.push(sql`lower(${property.suburb}) <> lower(${scope.suburb})`);
  }

  const rows = await db
    .select({
      suburb: property.suburb,
      state: property.state,
      postcode: property.postcode,
      listingCount: listings,
      distanceKm: distance,
    })
    .from(listing)
    .innerJoin(property, eq(property.id, listing.propertyId))
    .where(and(...filters))
    .groupBy(property.suburb, property.state, property.postcode)
    .orderBy(
      // `nulls last` matters: a suburb whose listings have never been geocoded
      // has no distance, and Postgres sorts nulls first ascending by default —
      // which would put the one suburb we cannot place at the top of a list
      // whose whole claim is that it is sorted by distance.
      scope.near
        ? sql`min(ST_Distance(${PROPERTY_GEOM}, ST_SetSRID(ST_MakePoint(${scope.near.lng}, ${scope.near.lat}), 4326)::geography)) asc nulls last`
        : sql`${listings} desc, ${property.suburb} asc`,
    )
    .limit(scope.limit ?? DEFAULT_LIMIT + 2);

  return rows.map((r) => ({
    suburb: r.suburb,
    state: r.state,
    postcode: r.postcode,
    listingCount: int(r.listingCount),
    distanceKm: dec(r.distanceKm),
  }));
}
