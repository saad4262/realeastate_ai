import { z } from 'zod';

/**
 * What kind of place a result is.
 *
 * It decides the default radius: somebody who typed a street wants a few
 * hundred metres, somebody who typed a suburb wants the suburb, and somebody
 * who typed "Sydney" wants a region. Searching 2 km around a region centroid
 * returns the CBD and nothing else, which reads as "there is nothing for sale
 * in Sydney".
 */
export const placeKindSchema = z.enum(['address', 'locality', 'postcode', 'region']);
export type PlaceKind = z.infer<typeof placeKindSchema>;

/** Sensible starting radius per kind, in kilometres. The user can override. */
export const DEFAULT_RADIUS_KM: Record<PlaceKind, number> = {
  address: 2,
  locality: 5,
  postcode: 5,
  region: 25,
};

/** A row in the autocomplete dropdown. Cheap: no coordinates yet. */
export const placeSuggestionSchema = z.object({
  /**
   * The provider's id, or `local:<suburb>|<state>` for one of our own suburbs.
   * Opaque to the UI — it is handed straight back to resolvePlace().
   */
  id: z.string().min(1).max(512),
  /** "Bondi Beach" — what the user is choosing. */
  label: z.string().min(1),
  /** "NSW 2026, Australia" — disambiguates two suburbs of the same name. */
  secondary: z.string().nullable().default(null),
  kind: placeKindSchema,
});

export type PlaceSuggestion = z.infer<typeof placeSuggestionSchema>;

/**
 * A place with coordinates, ready to be stored on a property or used as the
 * centre of a radius search.
 *
 * Address parts come back separated because the property table stores them
 * separately — non-negotiable #1 means the physical place is modelled, not a
 * formatted string, and "12 Campbell Parade" cannot be split reliably after
 * the fact.
 */
export const resolvedPlaceSchema = z.object({
  placeId: z.string().nullable().default(null),
  formatted: z.string().min(1),
  unit: z.string().nullable().default(null),
  streetNumber: z.string().nullable().default(null),
  street: z.string().nullable().default(null),
  suburb: z.string().nullable().default(null),
  state: z.string().nullable().default(null),
  postcode: z.string().nullable().default(null),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  kind: placeKindSchema,
});

export type ResolvedPlace = z.infer<typeof resolvedPlaceSchema>;

/**
 * A geographic centre plus how far around it to look.
 *
 * Radius is capped: an uncapped one turns every search into a full table scan
 * with a distance sort bolted on, which is slower than no filter at all.
 */
export const nearSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radiusKm: z.coerce.number().min(0.1).max(200),
});

export type Near = z.infer<typeof nearSchema>;

/**
 * The port.
 *
 * Google is today's answer, not the contract. A provider that cannot be swapped
 * is a provider whose price rises are not negotiable, and the Australian
 * alternatives (GNAF, Mapbox) fit this same shape.
 */
export type GeoProvider = {
  readonly name: string;
  /** Empty array rather than a throw when the provider is unconfigured. */
  suggest(query: string, opts?: { kinds?: PlaceKind[] }): Promise<PlaceSuggestion[]>;
  /** A suggestion id, or free text when the user never opened the dropdown. */
  resolve(idOrQuery: string): Promise<ResolvedPlace | null>;
  /**
   * A point on the map back to an address.
   *
   * What makes a dragged pin usable: the agent moves the marker onto the
   * property and gets told which address they landed on, instead of being left
   * with two numbers they cannot check.
   */
  reverse(lat: number, lng: number): Promise<ResolvedPlace | null>;
};

/** The address parts a property is geocoded from. */
export type AddressParts = {
  unit?: string | null;
  streetNumber?: string | null;
  street?: string | null;
  suburb: string;
  state: string;
  postcode: string;
};

/** One line for the geocoder, and the cache key it is looked up by. */
export function addressQuery(parts: AddressParts): string {
  const street = [parts.streetNumber, parts.street].filter(Boolean).join(' ').trim();
  const line = [parts.unit ? `${parts.unit}/` : '', street].join('').trim();
  return [line, parts.suburb, parts.state, parts.postcode, 'Australia']
    .filter(Boolean)
    .join(', ');
}

/**
 * Cache key. Case and spacing are not part of what was asked for, so
 * "Bondi Beach", " bondi  beach " and "BONDI BEACH" are one row.
 */
export function cacheKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 500);
}
