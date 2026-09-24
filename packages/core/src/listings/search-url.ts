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
