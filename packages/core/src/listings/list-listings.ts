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
} as const;

type RawRow = {
  [K in keyof typeof SELECTION]: K extends 'createdAt'
    ? Date
    : K extends 'agentNames'
      ? string[]
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

/**
 * Every listing belonging to the actor's agency, drafts included.
 *
 * `mine` narrows to the ones the actor is named on in listing_agent, which is
 * what the agent desk shows — the agency console shows the whole book.
 */
export async function listAgencyListings(
  db: Db,
  actor: Actor,
  opts: { mine?: boolean } = {},
): Promise<ListingRow[]> {
  if (!actor.agencyId) throw FORBIDDEN;
  if (!can(actor, 'listing:read', { type: 'listing', agencyId: actor.agencyId })) {
    throw FORBIDDEN;
  }

  const base = db
    .select(SELECTION)
    .from(listing)
    .innerJoin(property, eq(property.id, listing.propertyId))
    .innerJoin(agency, eq(agency.id, listing.agencyId));

  const rows = opts.mine
    ? await base
        .innerJoin(listingAgent, eq(listingAgent.listingId, listing.id))
        .where(and(eq(listing.agencyId, actor.agencyId), eq(listingAgent.userId, actor.userId)))
        .orderBy(desc(listing.createdAt))
    : await base.where(eq(listing.agencyId, actor.agencyId)).orderBy(desc(listing.createdAt));

  return rows.map((r) => toRow(r as RawRow, r.agentNames ?? []));
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
