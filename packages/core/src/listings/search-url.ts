import { z } from 'zod';
import { auStateSchema, listingChannelSchema, propertyTypeSchema, sortSchema } from './listing-schema';
import type { PublicSearchQuery } from './search-listings';

/**
 * The URL vocabulary of /search, written down in one place.
 *
 * The chat produces a link the visitor can open, share and keep refining with
 * the ordinary filters. That only works if it speaks exactly the dialect the
 * search page parses — a key it does not recognise is silently dropped, and a
 * filter the visitor watched the chat apply disappears on the way.
 *
 * Three things now write this vocabulary: apps/web/app/search/page.tsx parses
 * it, apps/web/components/search-bar.tsx builds it, and this builds it again.
 * That is one too many, and this constant exists so the drift is findable when
 * somebody comes to fix it.
 */
export const SEARCH_PARAM_KEYS = [
  'q',
  'channel',
  'beds',
  'baths',
  'cars',
  'type',
  'priceFrom',
  'priceTo',
  'sort',
  'suburb',
  'state',
  'postcode',
  'lat',
  'lng',
  'radius',
] as const;

export type SearchParamKey = (typeof SEARCH_PARAM_KEYS)[number];

/**
 * The keyword, once the place's own name has been discounted.
 *
 * A suburb name must never travel as free text. The text filter is ANDed over
 * everything else, so
 *   (in Pakenham OR within 50 km) AND ("pakenham" appears somewhere)
 * deletes every neighbouring suburb the radius had just added — a distance
 * filter that looks broken and is not. A real keyword beside a suburb —
 * "Pakenham" plus "pool" — still filters, because only the place's own name is
 * treated as a label rather than a term.
 *
 * This is the rule apps/web/app/search/page.tsx applies to a shared link; the
 * chat applies it before the search runs, because a model asked for "homes in
 * Pakenham" will reach for both fields.
 */
export function discountPlaceWords(
  text: string | undefined,
  place: { suburb?: string; state?: string; postcode?: string },
): string | undefined {
  const typed = text?.trim();
  if (!typed) return undefined;

  const placeWords = [place.suburb, place.state, place.postcode]
    .filter((v): v is string => Boolean(v))
    .map((v) => v.trim().toLowerCase());

  return placeWords.includes(typed.toLowerCase()) ? undefined : typed;
}

function put(params: URLSearchParams, key: SearchParamKey, value: unknown): void {
  if (value === undefined || value === null || value === '') return;
  params.set(key, String(value));
}

/**
 * A search, as a link to /search.
 *
 * Built by the server from the query it actually ran, never by the model. A
 * model asked to write the URL itself encodes it correctly most of the time
 * and produces a subtly wrong radius the rest, and nothing on the page would
 * show which one you got.
 *
 * The asymmetry around the centre is deliberate and is the fix for a bug that
 * was reported twice: when a suburb is named, emit the suburb and the radius
 * and NOT the coordinates, because /search re-resolves the centre server-side
 * from place_cache. Coordinates only travel when there is no suburb to look
 * up — the case where the visitor searched a street address.
 */
export function searchQueryToParams(query: PublicSearchQuery): URLSearchParams {
  const params = new URLSearchParams();

  put(params, 'q', discountPlaceWords(query.text, query));
  put(params, 'channel', query.channel);
  put(params, 'beds', query.bedrooms);
  put(params, 'baths', query.bathrooms);
  put(params, 'cars', query.carSpaces);
  put(params, 'type', query.propertyType);
  put(params, 'priceFrom', query.priceFrom);
  put(params, 'priceTo', query.priceTo);
  put(params, 'sort', query.sort);
  put(params, 'suburb', query.suburb);
  put(params, 'state', query.state);
  put(params, 'postcode', query.postcode);

  if (query.near) {
    put(params, 'radius', query.near.radiusKm);
    if (!query.suburb) {
      put(params, 'lat', query.near.lat);
      put(params, 'lng', query.near.lng);
    }
  }

  return params;
}

/** The same thing as a path the browser can follow. */
export function searchQueryToPath(query: PublicSearchQuery): string {
  const params = searchQueryToParams(query);
  const qs = params.toString();
  return qs ? `/search?${qs}` : '/search';
}

/**
 * A search as it is STORED, which is the URL's vocabulary and not the
 * runtime query's.
 *
 * The difference is the centre. `PublicSearchQuery` carries `near` — a
 * resolved lat/lng/radius that PostGIS can use — and a saved search must not,
 * because a stored coordinate is a snapshot of what the geocoder thought
 * months ago. It keeps `suburb` + `radiusKm` instead and the centre is looked
 * up at run time from `place_cache`, exactly as /search does on every request
 * (and for the same reason: the server owns the centre whenever a suburb is
 * named, because a browser that sends the wrong one produces a search that is
 * confidently wrong with nothing on screen to show it).
 *
 * `lat`/`lng` survive only for the case /search also trusts them in — a
 * street address, where there is no suburb to look up instead.
 *
 * This is the same shape in both directions, which is the point: what can be
 * linked to can be saved, and what is saved can be linked to.
 */
export const savedSearchQuerySchema = z
  .object({
    text: z.string().trim().min(1).max(200).optional(),
    suburb: z.string().trim().min(1).max(120).optional(),
    state: auStateSchema.optional(),
    postcode: z.string().trim().min(3).max(4).optional(),
    channel: listingChannelSchema.optional(),
    priceFrom: z.number().nonnegative().optional(),
    priceTo: z.number().nonnegative().optional(),
    bedrooms: z.number().int().min(0).max(20).optional(),
    bathrooms: z.number().int().min(0).max(20).optional(),
    carSpaces: z.number().int().min(0).max(20).optional(),
    propertyType: propertyTypeSchema.optional(),
    landFrom: z.number().nonnegative().optional(),
    /** Widen beyond the suburb. Meaningless without a suburb or a lat/lng. */
    radiusKm: z.number().positive().max(200).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    sort: sortSchema.optional(),
  })
  .strict();

export type SavedSearchQuery = z.infer<typeof savedSearchQuerySchema>;

function numOf(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Read a `/search?…` query string back into a saved search.
 *
 * The inverse of `searchQueryToParams`, and the reason this module's header
 * note existed: three places wrote this vocabulary and nothing read it, so
 * "what did the visitor actually ask for" could only be recovered by
 * reimplementing the parse. apps/web/app/search/page.tsx still has its own
 * copy — it also resolves the centre and pages the results, which is more
 * than this does — but a new reader should use this one.
 *
 * Every field goes through zod, so anything hand-edited into the URL is
 * dropped rather than stored. Unknown keys are ignored here rather than
 * refused: a link is not a form, and an old link with a retired parameter
 * should still save the parts that are still real.
 */
export function parseSearchParams(params: URLSearchParams): SavedSearchQuery {
  const candidate = {
    text: params.get('q')?.trim() || undefined,
    suburb: params.get('suburb')?.trim() || undefined,
    state: params.get('state')?.trim().toUpperCase() || undefined,
    postcode: params.get('postcode')?.trim() || undefined,
    channel: params.get('channel')?.trim() || undefined,
    priceFrom: numOf(params.get('priceFrom')),
    priceTo: numOf(params.get('priceTo')),
    bedrooms: numOf(params.get('beds')),
    bathrooms: numOf(params.get('baths')),
    carSpaces: numOf(params.get('cars')),
    propertyType: params.get('type')?.trim() || undefined,
    landFrom: numOf(params.get('landFrom')),
    radiusKm: numOf(params.get('radius')),
    lat: numOf(params.get('lat')),
    lng: numOf(params.get('lng')),
    sort: params.get('sort')?.trim() || undefined,
  };

  // Field by field, so one bad value costs that filter and not the search.
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (value === undefined) continue;
    const field = savedSearchQuerySchema.shape[key as keyof SavedSearchQuery];
    const parsed = field.safeParse(value);
    if (parsed.success && parsed.data !== undefined) out[key] = parsed.data;
  }

  const saved = out as SavedSearchQuery;

  // A suburb's own name must never also travel as free text — the text filter
  // is ANDed, so it deletes every neighbouring suburb a radius just added.
  if (saved.text) {
    saved.text = discountPlaceWords(saved.text, saved);
    if (!saved.text) delete saved.text;
  }

  // A centre with no radius is a suburb search; a radius with no centre is
  // meaningless. Drop coordinates nothing will use rather than store them.
  if (saved.radiusKm === undefined) {
    delete saved.lat;
    delete saved.lng;
  }

  return saved;
}

/** A saved search, back as a link. The inverse of `parseSearchParams`. */
export function savedQueryToPath(query: SavedSearchQuery): string {
  const params = new URLSearchParams();

  put(params, 'q', query.text);
  put(params, 'channel', query.channel);
  put(params, 'beds', query.bedrooms);
  put(params, 'baths', query.bathrooms);
  put(params, 'cars', query.carSpaces);
  put(params, 'type', query.propertyType);
  put(params, 'priceFrom', query.priceFrom);
  put(params, 'priceTo', query.priceTo);
  put(params, 'sort', query.sort);
  put(params, 'suburb', query.suburb);
  put(params, 'state', query.state);
  put(params, 'postcode', query.postcode);

  if (query.radiusKm !== undefined) {
    put(params, 'radius', query.radiusKm);
    // Same asymmetry as searchQueryToParams: a named suburb is re-resolved by
    // /search, so sending coordinates alongside it can only disagree with it.
    if (!query.suburb) {
      put(params, 'lat', query.lat);
      put(params, 'lng', query.lng);
    }
  }

  const qs = params.toString();
  return qs ? `/search?${qs}` : '/search';
}

/**
 * Describe a saved search in words, for an email subject and a list row.
 *
 * Built from the stored filters by the server. The model never writes this —
 * #4 — and neither does the browser.
 */
export function describeSavedQuery(query: SavedSearchQuery): string {
  const bits: string[] = [];

  if (query.bedrooms) bits.push(`${query.bedrooms}+ bed`);
  bits.push(query.propertyType ? `${query.propertyType}s` : 'homes');
  if (query.channel === 'rent') bits.push('to rent');
  else if (query.channel === 'sale') bits.push('for sale');

  if (query.suburb) {
    bits.push(query.radiusKm ? `in ${query.suburb} and within ${query.radiusKm} km` : `in ${query.suburb}`);
  } else if (query.radiusKm) {
    bits.push(`within ${query.radiusKm} km`);
  }

  if (query.priceTo) {
    // A rental cap is per week and a sale cap is not. Saying "under $700"
    // about a rental without the "a week" is the kind of number that reads as
    // a typo — and prices are never parsed back out of this string.
    const amount = query.priceTo.toLocaleString('en-AU');
    bits.push(query.channel === 'rent' ? `under $${amount} a week` : `under $${amount}`);
  }

  return bits.join(' ');
}
