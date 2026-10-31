import { and, eq, sql } from 'drizzle-orm';
import { property, type Db, type DbOrTx } from '@repo/db';
import { geocodeAddress } from '../geo/places';
import { ListingError, formatAddress, type PropertyDraft } from './listing-schema';
import { addressKey } from './address-key';

/** numeric columns take strings; passing a JS number loses precision at scale. */
export function money(value: number | undefined): string | null {
  return value === undefined ? null : value.toFixed(2);
}

/**
 * The physical attributes the form states, every field, blanks as NULL.
 *
 * ADR 0075: these are written to the LISTING (the facts as this ad states them — clearing a wrong
 * bedroom count is the agent's to do), and to a property row only when the row is new. The address is
 * shared by every agency; see `providedPhysicalFields` for what a listing may add to an existing one.
 */
export function physicalFields(p: PropertyDraft) {
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

/**
 * Only the facts this draft actually states — for an EXISTING property, where (ADR 0075) a listing may
 * only fill a fact the address does not have yet, never change one. A blank on the ad means "not given".
 */
function providedPhysicalFields(p: PropertyDraft) {
  const all = physicalFields(p);
  return Object.fromEntries(
    Object.entries(all).filter(([, v]) => v !== null),
  ) as Partial<typeof all>;
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
 * house sold in 2019 and re-listed today by a different agency is one property
 * with two listings, and the history is why the tables are separate.
 *
 * ## Matching
 *
 * On `addressKey`, not the raw columns. The agency re-listing an address types
 * it themselves, and "6E Henry St" against "6e Henry Street" used to create a
 * second property — so the new listing showed none of the sale history and the
 * old sale lived on as a different house. The candidates are every property in
 * the same suburb, postcode and state (already a narrow set, and this runs once
 * per save), and the key decides among them in one place that is unit-tested.
 *
 * ## Two agencies at once
 *
 * There is no unique index to lean on, so two saves for the same new address
 * racing each other would both find nothing and both insert. A transaction-
 * scoped advisory lock on the address key serialises exactly those two and
 * nothing else; the second waits, then finds the first one's row. It releases
 * itself at commit or rollback.
 */
/** ADR 0075: anything of ANOTHER agency at this address — then its pin is not ours to move. One query. */
export async function usedByAnotherAgency(tx: DbOrTx, propertyId: string, agencyId: string): Promise<boolean> {
  const [r] = await tx.execute<{ used: boolean }>(sql`select (
    exists (select 1 from listing where property_id = ${propertyId} and agency_id <> ${agencyId})
    or exists (select 1 from deal where property_id = ${propertyId} and agency_id <> ${agencyId})
    or exists (select 1 from appointment where property_id = ${propertyId} and agency_id <> ${agencyId})
    or exists (select 1 from lead where property_id = ${propertyId} and agency_id <> ${agencyId})
    or exists (select 1 from contact_property cp join contact c on c.id = cp.contact_id where cp.property_id = ${propertyId} and c.agency_id <> ${agencyId})
  ) as used`);
  return Boolean(r?.used);
}

export async function upsertProperty(
  tx: DbOrTx,
  p: PropertyDraft,
  pin: ResolvedPin,
  opts: {
    /**
     * ADR 0075: the agency saving. A pin it carries moves an existing address's pin only while no OTHER
     * agency has anything at that address (a listing, a deal, an appointment, a lead, a contact's link).
     * Omitted: the pin is only ever written to an address that has none.
     */
    agencyId?: string;
    /**
     * Use an existing property exactly as it is. For a contact's address
     * (ADR 0018): tying a person to a home is not a statement about the home,
     * and must not move another agency's pin or rewrite its facts.
     */
    leaveExisting?: boolean;
  } = {},
): Promise<string> {
  const key = addressKey(p);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);

  const candidates = await tx
    .select({
      id: property.id,
      latitude: property.latitude,
      unit: property.unit,
      streetNumber: property.streetNumber,
      street: property.street,
      suburb: property.suburb,
      state: property.state,
      postcode: property.postcode,
    })
    .from(property)
    .where(
      and(
        eq(sql`lower(trim(${property.suburb}))`, p.suburb.trim().toLowerCase()),
        eq(property.postcode, p.postcode),
        eq(property.state, p.state),
      ),
    )
    // Oldest first, so if duplicates already exist from before this matching,
    // every new listing joins the one with the longest history.
    .orderBy(property.createdAt);

  const existing = candidates.find((c) => addressKey(c) === key);

  if (existing && opts.leaveExisting) return existing.id;

  if (existing) {
    // ADR 0075: the address is shared by every agency and a listing never rewrites it. Facts: only the
    // ones the address does not have yet are filled (the ad's own facts live on the listing). Pin: an
    // address with none takes it; a pin the caller carries (the autocomplete's, or one the agent dragged)
    // moves it only while no other agency has anything at this address.
    const carriesPin = p.latitude !== undefined && p.longitude !== undefined;
    const write = existing.latitude === null || (carriesPin && opts.agencyId !== undefined && !(await usedByAnotherAgency(tx, existing.id, opts.agencyId))) ? pin : null;
    const fill = Object.fromEntries(
      Object.entries(providedPhysicalFields(p)).map(([k, v]) => [k, sql`coalesce(${property[k as keyof ReturnType<typeof physicalFields>]}, ${v})`]),
    );

    await tx
      .update(property)
      .set({ ...fill, ...(write ?? {}), updatedAt: sql`now()` })
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
