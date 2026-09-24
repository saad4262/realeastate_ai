import { and, eq, isNull, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { property, type Db, type DbOrTx } from '@repo/db';
import { geocodeAddress } from '../geo/places';
import { ListingError, formatAddress, type PropertyDraft } from './listing-schema';

/** numeric columns take strings; passing a JS number loses precision at scale. */
export function money(value: number | undefined): string | null {
  return value === undefined ? null : value.toFixed(2);
}

/**
 * The physical attributes of a dwelling, as opposed to the ad over it.
 *
 * Shared by create and update because they are facts about the place, not the
 * campaign: a fourth bedroom added between two listings is true for both.
 */
function physicalFields(p: PropertyDraft) {
  return {
    propertyType: p.propertyType || null,
    bedrooms: p.bedrooms ?? null,
    bathrooms: p.bathrooms === undefined ? null : String(p.bathrooms),
    carSpaces: p.carSpaces ?? null,
    landAreaSqm: money(p.landAreaSqm),
    buildingAreaSqm: money(p.buildingAreaSqm),
    yearBuilt: p.yearBuilt ?? null,
  };
}

/** What gets written to the pin columns, or null when there is nothing to pin. */
export type ResolvedPin = {
  latitude: string;
  longitude: string;
  placeId: string | null;
  formattedAddress: string | null;
  geocodedAt: Date;
  geocodeSource: 'google' | 'manual';
} | null;

/**
 * Work out the pin, **before** any transaction is opened.
 *
 * This is the only part of saving a listing that talks to the network, and it
 * can take seconds when the geocoder is slow. Inside a transaction it would
 * hold a pooled connection open and keep rows locked for the length of an HTTP
 * call to Google — one slow response turning into a stalled pool. So the
 * network happens first and the transaction that follows does nothing but write.
 *
 * Returns null rather than throwing: a listing whose address the geocoder does
 * not recognise must still save. It simply will not appear in radius searches
 * until somebody pins it.
 */
export async function resolvePin(db: Db, p: PropertyDraft): Promise<ResolvedPin> {
  if (p.latitude !== undefined && p.longitude !== undefined) {
    const manual = p.pinSource === 'manual';
    return {
      latitude: p.latitude.toFixed(6),
      longitude: p.longitude.toFixed(6),
      // A dragged pin has no place id of its own — it is a point on the map,
      // not one of Google's places — and keeping the old one would say this
      // spot is that address when the agent has just said it is not.
      placeId: manual ? null : p.placeId || null,
      // The browser already has the provider's own line for this pin; falling
      // back to the parts keeps the column meaning "what was pinned" rather
      // than sometimes meaning nothing.
      formattedAddress: manual ? null : p.formattedAddress || formatAddress(p),
      geocodedAt: new Date(),
      geocodeSource: manual ? 'manual' : 'google',
    };
  }

  try {
    const hit = await geocodeAddress(db, {
      unit: p.unit,
      streetNumber: p.streetNumber,
      street: p.street,
      suburb: p.suburb,
      state: p.state,
      postcode: p.postcode,
    });
    if (!hit) return null;
    // A street address that geocodes to a suburb or a state is not this
    // property: Google answers "3/Sahiwal, Rafigardens 86/B jaksd" with the
    // centroid of New South Wales, which would drop a pin 400 km inland and
    // put the listing into radius searches it has no business being in.
    if (hit.kind !== 'address') return null;
    return {
      latitude: hit.latitude.toFixed(6),
      longitude: hit.longitude.toFixed(6),
      placeId: hit.placeId,
      formattedAddress: hit.formatted,
      geocodedAt: new Date(),
      geocodeSource: 'google',
    };
  } catch {
    // A geocoder outage must not stop an agent saving a listing.
    return null;
  }
}

/**
 * Find or create the property row for this address, and keep its facts current.
 *
 * Takes a transaction handle and does nothing but database work, so the caller
 * decides what is atomic with what. Reuse is the point (non-negotiable #1): a
 * house sold in 2019 and re-listed today is one property with two listings, and
 * the history is why the tables are separate. Matching is on the parts that
 * identify a dwelling — NULL never equals NULL in SQL, so each optional part
 * needs its own is-null branch.
 */
export async function upsertProperty(
  tx: DbOrTx,
  p: PropertyDraft,
  pin: ResolvedPin,
): Promise<string> {
  const matches = (col: AnyPgColumn, value: string | undefined) =>
    value === undefined || value === '' ? isNull(col) : eq(col, value);

  const [existing] = await tx
    .select({ id: property.id, latitude: property.latitude })
    .from(property)
    .where(
      and(
        eq(sql`lower(${property.suburb})`, p.suburb.toLowerCase()),
        eq(property.postcode, p.postcode),
        eq(property.state, p.state),
        matches(property.unit, p.unit),
        matches(property.streetNumber, p.streetNumber),
        matches(property.street, p.street),
      ),
    )
    .limit(1);

  if (existing) {
    // A pin the caller is carrying always wins: it is either the one the
    // autocomplete just resolved or the one the agent dragged, and both are
    // newer than whatever is in the row. Otherwise a pin is only written when
    // this row has never had one — writing on every edit would quietly discard
    // a pin somebody placed by hand while they were fixing a typo elsewhere.
    const carriesPin = p.latitude !== undefined && p.longitude !== undefined;
    const write = carriesPin || existing.latitude === null ? pin : null;

    await tx
      .update(property)
      .set({ ...physicalFields(p), ...(write ?? {}), updatedAt: sql`now()` })
      .where(eq(property.id, existing.id));

    return existing.id;
  }

  const [row] = await tx
    .insert(property)
    .values({
      unit: p.unit || null,
      streetNumber: p.streetNumber || null,
      street: p.street || null,
      suburb: p.suburb,
      state: p.state,
      postcode: p.postcode,
      ...physicalFields(p),
      ...(pin ?? {}),
    })
    .returning({ id: property.id });

  if (!row) throw new ListingError('unknown', 'Could not save the property');
  return row.id;
}
