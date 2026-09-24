import { and, desc, eq, sql } from 'drizzle-orm';
import { agency, listing, listingAgent, property, type Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import {
  formatAddress,
  ListingError,
  type ListingChannel,
  type ListingForEdit,
  type ListingStatus,
} from './listing-schema';

export type ListingRow = {
  id: string;
  address: string;
  suburb: string;
  state: string;
  postcode: string;
  channel: ListingChannel;
  status: ListingStatus;
  headline: string | null;
  priceDisplay: string | null;
  priceFrom: number | null;
  priceTo: number | null;
  rentPw: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  carSpaces: number | null;
  propertyType: string | null;
  agencyName: string;
  agents: string[];
  createdAt: Date;
};

const num = (v: string | null): number | null => (v === null ? null : Number(v));

const FORBIDDEN = new ListingError(
  'forbidden',
  'You do not have permission to view listings for this agency',
);

const SELECTION = {
  id: listing.id,
  channel: listing.channel,
  status: listing.status,
  headline: listing.headline,
  priceDisplay: listing.priceDisplay,
  priceFrom: listing.priceFrom,
  priceTo: listing.priceTo,
  rentPw: listing.rentPw,
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
  agencyName: agency.name,
  /**
   * Agent names inline instead of a second query keyed by listing id — that
   * follow-up was a full round trip to the database region for data the first
   * statement could have carried.
   */
  agentNames: sql<string[]>`coalesce((
    select array_agg(la.snapshot_name order by la.display_order)
    from listing_agent la where la.listing_id = ${listing.id}
  ), '{}')`,
  /**
   * The console's three header figures, counted by Postgres over the whole
   * result set rather than in the browser over the rows it was sent.
   *
   * They used to be `rows.filter(r => r.status === 'live').length` in the
   * table component, which is why this query had no LIMIT: the counts were
   * only right if every listing the agency had ever written was shipped to
   * the browser on every page load. An agency with four thousand listings
   * paid for four thousand rows, with their addresses and agent names, to
   * render twenty-five of them and two numbers.
   *
   * Window functions are evaluated before LIMIT, so these stay agency-wide
   * however small the page is.
   */
  totalCount: sql<number>`count(*) over()`,
  liveCount: sql<number>`count(*) filter (where ${listing.status} = 'live') over()`,
  draftCount: sql<number>`count(*) filter (where ${listing.status} = 'draft') over()`,
} as const;

type RawRow = {
  [K in keyof typeof SELECTION]: K extends 'createdAt'
    ? Date
    : K extends 'agentNames'
      ? string[]
      : K extends 'totalCount' | 'liveCount' | 'draftCount'
        ? number
        : K extends 'bedrooms' | 'carSpaces'
          ? number | null
          : K extends 'suburb' | 'state' | 'postcode' | 'agencyName' | 'id' | 'channel' | 'status'
            ? string
            : string | null;
};

function toRow(r: RawRow, agents: string[]): ListingRow {
  return {
    id: r.id,
    address: formatAddress(r),
    suburb: r.suburb,
    state: r.state,
    postcode: r.postcode,
    channel: r.channel as ListingChannel,
    status: r.status as ListingStatus,
    headline: r.headline,
    priceDisplay: r.priceDisplay,
    priceFrom: num(r.priceFrom),
    priceTo: num(r.priceTo),
    rentPw: num(r.rentPw),
    bedrooms: r.bedrooms,
    bathrooms: num(r.bathrooms),
    carSpaces: r.carSpaces,
    propertyType: r.propertyType,
    agencyName: r.agencyName,
    agents,
    createdAt: r.createdAt,
  };
}

/** What the console header shows, counted over the whole book, not the page. */
export type ListingCounts = {
  total: number;
  live: number;
  draft: number;
};

export type ListingPage = {
  rows: ListingRow[];
  counts: ListingCounts;
};

export type ListAgencyListingsOptions = {
  /** Narrow to listings the actor is named on in listing_agent — the agent desk. */
  mine?: boolean;
  /** Rows on this page. Omit for every row, which only a small book should do. */
  limit?: number;
  offset?: number;
};

/**
 * One page of the actor's agency book, plus the counts for the whole of it.
 *
 * `mine` narrows to the ones the actor is named on in listing_agent, which is
 * what the agent desk shows — the agency console shows the whole book.
 *
 * One statement, still: the agent names are sub-selected and the three counts
 * are window functions over the same scan. query-count.test.ts holds that to
 * one query, because the obvious way to add counts is a second SELECT and that
 * is a round trip to the database region for three integers.
 *
 * The ordering carries a unique tiebreaker for the same reason the public
 * search does: created_at is not unique, and a page boundary that falls inside
 * a group of rows sharing a timestamp will repeat one row on this page and
 * skip another on the next.
 */
export async function listAgencyListingsPage(
  db: Db,
  actor: Actor,
  opts: ListAgencyListingsOptions = {},
): Promise<ListingPage> {
  if (!actor.agencyId) throw FORBIDDEN;
  if (!can(actor, 'listing:read', { type: 'listing', agencyId: actor.agencyId })) {
    throw FORBIDDEN;
  }

  const base = db
    .select(SELECTION)
    .from(listing)
    .innerJoin(property, eq(property.id, listing.propertyId))
    .innerJoin(agency, eq(agency.id, listing.agencyId));

  const scoped = opts.mine
    ? base
        .innerJoin(listingAgent, eq(listingAgent.listingId, listing.id))
        .where(and(eq(listing.agencyId, actor.agencyId), eq(listingAgent.userId, actor.userId)))
    : base.where(eq(listing.agencyId, actor.agencyId));

  const ordered = scoped.orderBy(desc(listing.createdAt), desc(listing.id));
  const paged =
    opts.limit === undefined
      ? ordered
      : ordered.limit(opts.limit).offset(opts.offset ?? 0);

  const rows = (await paged) as RawRow[];

  return {
    rows: rows.map((r) => toRow(r, r.agentNames ?? [])),
    counts: {
      // Number(), and it is not defensive padding. count() returns bigint, and
      // the driver hands bigint back as a STRING — so these arrive as "3" while
      // the type above says number, which is a lie TypeScript cannot catch.
      // Left alone it reaches the console's optimistic counter as "3" + 1 and
      // publishing a listing makes the header read "Live 31".
      //
      // No rows means no window to read the counts out of, which is correct:
      // an empty page of an empty book is three zeroes.
      total: Number(rows[0]?.totalCount ?? 0),
      live: Number(rows[0]?.liveCount ?? 0),
      draft: Number(rows[0]?.draftCount ?? 0),
    },
  };
}

/**
 * Every listing, unpaged.
 *
 * Kept for callers that genuinely want the whole book — and for the tests that
 * assert the query count. New console pages should use the paged form.
 */
export async function listAgencyListings(
  db: Db,
  actor: Actor,
  opts: { mine?: boolean } = {},
): Promise<ListingRow[]> {
  return (await listAgencyListingsPage(db, actor, opts)).rows;
}

/** One listing, for the console detail view. Agency-scoped. */
export async function getAgencyListing(
  db: Db,
  actor: Actor,
  listingId: string,
): Promise<ListingRow | null> {
  if (!actor.agencyId) throw FORBIDDEN;
  if (!can(actor, 'listing:read', { type: 'listing', agencyId: actor.agencyId, id: listingId })) {
    throw FORBIDDEN;
  }

  const [row] = await db
    .select(SELECTION)
    .from(listing)
    .innerJoin(property, eq(property.id, listing.propertyId))
    .innerJoin(agency, eq(agency.id, listing.agencyId))
    .where(and(eq(listing.id, listingId), eq(listing.agencyId, actor.agencyId)))
    .limit(1);

  if (!row) return null;
  return toRow(row as RawRow, row.agentNames ?? []);
}

export async function getListingForEdit(
  db: Db,
  actor: Actor,
  listingId: string,
): Promise<ListingForEdit | null> {
  if (!actor.agencyId) throw FORBIDDEN;
  // Read permission gets the form open; listing:edit is what updateListing
  // enforces on save, and it is the narrower of the two.
  if (!can(actor, 'listing:read', { type: 'listing', agencyId: actor.agencyId, id: listingId })) {
    throw FORBIDDEN;
  }

  const [row] = await db
    .select({
      id: listing.id,
      status: listing.status,
      channel: listing.channel,
      headline: listing.headline,
      description: listing.description,
      priceDisplay: listing.priceDisplay,
      priceFrom: listing.priceFrom,
      priceTo: listing.priceTo,
      rentPw: listing.rentPw,
      propertyId: property.id,
      unit: property.unit,
      streetNumber: property.streetNumber,
      street: property.street,
      suburb: property.suburb,
      state: property.state,
      postcode: property.postcode,
      propertyType: property.propertyType,
      bedrooms: property.bedrooms,
      bathrooms: property.bathrooms,
      carSpaces: property.carSpaces,
      landAreaSqm: property.landAreaSqm,
      buildingAreaSqm: property.buildingAreaSqm,
      yearBuilt: property.yearBuilt,
      latitude: property.latitude,
      longitude: property.longitude,
      placeId: property.placeId,
      formattedAddress: property.formattedAddress,
      geocodeSource: property.geocodeSource,
    })
    .from(listing)
    .innerJoin(property, eq(property.id, listing.propertyId))
    .where(and(eq(listing.id, listingId), eq(listing.agencyId, actor.agencyId)))
    .limit(1);

  if (!row) return null;

  return {
    id: row.id,
    status: row.status as ListingStatus,
    propertyId: row.propertyId,
    property: {
      unit: row.unit,
      streetNumber: row.streetNumber,
      street: row.street,
      suburb: row.suburb,
      state: row.state,
      postcode: row.postcode,
      propertyType: row.propertyType,
      bedrooms: row.bedrooms,
      bathrooms: num(row.bathrooms),
      carSpaces: row.carSpaces,
      landAreaSqm: num(row.landAreaSqm),
      buildingAreaSqm: num(row.buildingAreaSqm),
      yearBuilt: row.yearBuilt,
      latitude: num(row.latitude),
      longitude: num(row.longitude),
      placeId: row.placeId,
      formattedAddress: row.formattedAddress,
      geocodeSource: row.geocodeSource,
    },
    listing: {
      channel: row.channel as ListingChannel,
      headline: row.headline ?? '',
      description: row.description,
      priceDisplay: row.priceDisplay,
      priceFrom: num(row.priceFrom),
      priceTo: num(row.priceTo),
      rentPw: num(row.rentPw),
    },
    address: formatAddress(row),
  };
}
