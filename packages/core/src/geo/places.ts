import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { listing, placeCache, property, type Db } from '@repo/db';
import { googleGeoProvider, isGeoProviderConfigured } from './provider-google';
import {
  addressQuery,
  cacheKey,
  type AddressParts,
  type GeoProvider,
  type PlaceKind,
  type PlaceSuggestion,
  type ResolvedPlace,
} from './place-schema';

/**
 * A suggestion id that points at our own data rather than the provider's.
 *
 * Without a Google key the dropdown still has to offer something, and the
 * suburbs we already hold listings in are the ones an agent is most likely to
 * be typing. These ids never reach Google.
 */
const LOCAL_PREFIX = 'local:';

function localId(suburb: string, state: string): string {
  return `${LOCAL_PREFIX}${suburb}|${state}`;
}

function parseLocalId(id: string): { suburb: string; state: string } | null {
  if (!id.startsWith(LOCAL_PREFIX)) return null;
  const [suburb, state] = id.slice(LOCAL_PREFIX.length).split('|');
  if (!suburb) return null;
  return { suburb, state: state ?? '' };
}

const num = (v: string | number | null): number | null => {
  if (v === null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Suburbs this database already knows about, for the dropdown.
 *
 * `liveOnly` is what the consumer site wants — offering a suburb with nothing
 * in it produces an empty results page and looks broken. The console wants the
 * opposite: an agent assigns a territory before there is anything listed in it.
 */
async function localSuggestions(
  db: Db,
  query: string,
  opts: { liveOnly?: boolean; limit?: number } = {},
): Promise<PlaceSuggestion[]> {
  const like = `%${query.trim().toLowerCase()}%`;
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 20);

  const base = db
    .selectDistinct({
      suburb: property.suburb,
      state: property.state,
      postcode: property.postcode,
    })
    .from(property);

  const rows = opts.liveOnly
    ? await base
        .innerJoin(listing, eq(listing.propertyId, property.id))
        .where(and(eq(listing.status, 'live'), sql`lower(${property.suburb}) like ${like}`))
        .limit(limit)
    : await base.where(sql`lower(${property.suburb}) like ${like}`).limit(limit);

  return rows.map((r) => ({
    id: localId(r.suburb, r.state),
    label: r.suburb,
    secondary: `${r.state} ${r.postcode}`,
    kind: 'locality' as PlaceKind,
  }));
}

/**
 * Autocomplete for a location box.
 *
 * Falls back to our own suburbs when the provider is unconfigured or silent,
 * so the feature degrades to something useful instead of to an empty list the
 * user reads as a bug.
 */
export async function suggestPlaces(
  db: Db,
  query: string,
  opts: { kinds?: PlaceKind[]; liveOnly?: boolean; provider?: GeoProvider } = {},
): Promise<PlaceSuggestion[]> {
  const input = query.trim();
  if (input.length < 2) return [];

  const provider = opts.provider ?? googleGeoProvider;
  const remote = isGeoProviderConfigured()
    ? await provider.suggest(input, { kinds: opts.kinds })
    : [];

  if (remote.length) return remote;
  return localSuggestions(db, input, { liveOnly: opts.liveOnly });
}

async function readCache(db: Db, key: string): Promise<ResolvedPlace | null> {
  const [row] = await db
    .select()
    .from(placeCache)
    .where(eq(placeCache.lookupKey, key))
    .limit(1);

  if (!row) return null;
  const lat = num(row.latitude);
  const lng = num(row.longitude);
  if (lat === null || lng === null) return null;

  // A street address cached before the cache held street parts. Answering it
  // would hand the form nulls for the fields the provider filled, and the form
  // would blank them on screen. Treat it as a miss: the provider is asked once
  // more and writeCache replaces the row with a complete one.
  if (row.kind === 'address' && row.street === null) return null;

  return {
    placeId: row.placeId,
    formatted: row.formatted,
    unit: row.unit,
    streetNumber: row.streetNumber,
    street: row.street,
    suburb: row.suburb,
    state: row.state,
    postcode: row.postcode,
    latitude: lat,
    longitude: lng,
    kind: row.kind as PlaceKind,
  };
}

async function writeCache(db: Db, key: string, place: ResolvedPlace): Promise<void> {
  try {
    await db
      .insert(placeCache)
      .values({
        lookupKey: key,
        provider: 'google',
        placeId: place.placeId,
        formatted: place.formatted,
        unit: place.unit,
        streetNumber: place.streetNumber,
        street: place.street,
        suburb: place.suburb,
        state: place.state,
        postcode: place.postcode,
        latitude: place.latitude.toFixed(6),
        longitude: place.longitude.toFixed(6),
        kind: place.kind,
      })
      .onConflictDoUpdate({
        target: placeCache.lookupKey,
        set: {
          placeId: place.placeId,
          formatted: place.formatted,
          unit: place.unit,
          streetNumber: place.streetNumber,
          street: place.street,
          suburb: place.suburb,
          state: place.state,
          postcode: place.postcode,
          latitude: place.latitude.toFixed(6),
          longitude: place.longitude.toFixed(6),
          kind: place.kind,
          updatedAt: sql`now()`,
        },
      });
  } catch {
    // A cache that cannot be written is a slower system, not a broken one.
    // Losing a search because the cache table is missing would be the bug.
  }
}

/**
 * A suburb centre taken from properties we have already pinned.
 *
 * The average of every pinned property in a suburb is not its official
 * centroid, but it is the centre of the part of the suburb this platform
 * actually has listings in, which is the more useful thing to search around.
 */
async function localCentre(db: Db, suburb: string, state: string): Promise<ResolvedPlace | null> {
  const conditions = [
    sql`lower(${property.suburb}) = ${suburb.trim().toLowerCase()}`,
    isNotNull(property.latitude),
  ];
  if (state) conditions.push(eq(property.state, state));

  const [row] = await db
    .select({
      lat: sql<string>`avg(${property.latitude})`,
      lng: sql<string>`avg(${property.longitude})`,
      state: sql<string>`min(${property.state})`,
      postcode: sql<string>`min(${property.postcode})`,
    })
    .from(property)
    .where(and(...conditions));

  const lat = num(row?.lat ?? null);
  const lng = num(row?.lng ?? null);
  if (lat === null || lng === null) return null;

  return {
    placeId: null,
    formatted: [suburb, row?.state, row?.postcode].filter(Boolean).join(' '),
    unit: null,
    streetNumber: null,
    street: null,
    suburb,
    state: row?.state ?? state ?? null,
    postcode: row?.postcode ?? null,
    latitude: lat,
    longitude: lng,
    kind: 'locality',
  };
}

/**
 * Turn a suggestion id, or raw typed text, into coordinates.
 *
 * Order matters: cache, then provider, then our own data. Every provider bills
 * per call and a consumer refining a search re-resolves the same suburb over
 * and over, so the cache is a cost control, not just a latency one.
 */
export async function resolvePlace(
  db: Db,
  idOrQuery: string,
  opts: { provider?: GeoProvider } = {},
): Promise<ResolvedPlace | null> {
  const value = idOrQuery.trim();
  if (!value) return null;

  const local = parseLocalId(value);
  if (local) return localCentre(db, local.suburb, local.state);

  const key = cacheKey(value);
  const cached = await readCache(db, key);
  if (cached) return cached;

  if (isGeoProviderConfigured()) {
    const provider = opts.provider ?? googleGeoProvider;
    const resolved = await provider.resolve(value);
    if (resolved) {
      await writeCache(db, key, resolved);
      return resolved;
    }
  }

  // No key, or the provider had nothing: treat what was typed as a suburb we
  // may already hold. Text search still works without this — it only means a
  // radius cannot be applied.
  return localCentre(db, value, '');
}

/**
 * A point on the map back to an address.
 *
 * Cached like every other lookup, keyed on the rounded coordinates — a marker
 * nudged by a pixel is the same question, and this is the call an agent makes
 * most while fiddling with a pin.
 */
export async function reverseGeocode(
  db: Db,
  lat: number,
  lng: number,
  opts: { provider?: GeoProvider } = {},
): Promise<ResolvedPlace | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (!isGeoProviderConfigured()) return null;

  const key = cacheKey(`reverse:${lat.toFixed(5)},${lng.toFixed(5)}`);
  const cached = await readCache(db, key);
  if (cached) return cached;

  const provider = opts.provider ?? googleGeoProvider;
  const place = await provider.reverse(lat, lng);
  if (!place) return null;

  // Stored under the point that was asked about, not the one Google snapped to
  // — otherwise the next drag to the same spot misses the cache.
  await writeCache(db, key, place);
  return place;
}

/**
 * Coordinates for a property being saved.
 *
 * Returns null rather than throwing: a listing whose address the geocoder does
 * not recognise must still save. It simply will not appear in radius searches
 * until someone pins it, and suburb and postcode search still find it.
 */
export async function geocodeAddress(
  db: Db,
  parts: AddressParts,
  opts: { provider?: GeoProvider } = {},
): Promise<{
  latitude: number;
  longitude: number;
  placeId: string | null;
  /** The provider's own one-line address for the pin, stored beside it. */
  formatted: string;
  kind: PlaceKind;
} | null> {
  const resolved = await resolvePlace(db, addressQuery(parts), opts);
  if (!resolved) return null;
  return {
    latitude: resolved.latitude,
    longitude: resolved.longitude,
    placeId: resolved.placeId,
    formatted: resolved.formatted,
    kind: resolved.kind,
  };
}
