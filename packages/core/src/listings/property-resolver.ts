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
 * The physical attributes of a dwelling, as opposed to the ad over it.
 *
 * Shared by create and update because they are facts about the place, not the
 * campaign: a fourth bedroom added between two listings is true for both.
 *
 * Every field, blanks as NULL. Right for a new property, and for an agent
 * editing the property their own listing already stands on — clearing a wrong
 * bedroom count has to be possible. NOT right for joining a property somebody
 * else described; see `providedPhysicalFields`.
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

/**
 * Only the facts this draft actually states.
 *
 * For a listing joining an EXISTING property — another agency re-listing a
 * house, or an edit that moves a listing onto an address already on file. A
 * field left blank on the new ad means "not given", not "this house has none":
 * writing it as NULL erased the bedrooms, land size and so on that the earlier
 * agency recorded, from the property every listing at the address reads.
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
export async function upsertProperty(
  tx: DbOrTx,
  p: PropertyDraft,
  pin: ResolvedPin,
  opts: {
    /**
     * The property the listing being edited stands on now. When the address
     * still resolves to it, blanks clear fields — the agent is correcting their
     * own record. Anything else is joining a property, and only what the draft
     * states is written.
     */
    editingPropertyId?: string;
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
      .set({
        ...(existing.id === opts.editingPropertyId
          ? physicalFields(p)
          : providedPhysicalFields(p)),
        ...(write ?? {}),
        updatedAt: sql`now()`,
      })
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
