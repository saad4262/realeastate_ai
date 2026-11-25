import { z } from 'zod';
import {
  auStateSchema,
  listingChannelSchema,
  MAX_SEARCH_PLACES,
  PROPERTY_TYPES,
  propertyTypeSchema,
  sortSchema,
} from './listing-schema';
import type { PublicSearchQuery } from './search-listings';
export { parseSearchText, type ParsedSearch } from './search-text';

/**
 * The URL vocabulary of /search, written down in one place.
 *
 * The chat produces a link the visitor can open, share and keep refining with
 * the ordinary filters. That only works if it speaks exactly the dialect the
 * search page parses — a key it does not recognise is silently dropped, and a
 * filter the visitor watched the chat apply disappears on the way.
 *
 * Three things now write this vocabulary: apps/web/app/search/page.tsx parses
 * it, apps/web/components/home-search.tsx builds it, and this builds it again.
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
  'loc',
  'new',
  'lat',
  'lng',
  'radius',
] as const;

export type SearchParamKey = (typeof SEARCH_PARAM_KEYS)[number];

/** A suburb as a multi-suburb search names it, without a centre (the server finds that). */
export type PlaceRef = { suburb: string; state?: string; postcode?: string };

/**
 * One `loc` value: `Pakenham|VIC|3810` (ADR 0099). A pipe never appears in an
 * Australian suburb name, so the three parts need no escaping. State and
 * postcode are optional, as they are for `suburb=`.
 */
export function formatLoc(p: PlaceRef): string {
  return [p.suburb, p.state ?? '', p.postcode ?? ''].join('|').replace(/\|+$/, '');
}

const placeRefSchema = z
  .object({
    suburb: z.string().trim().min(1).max(120),
    state: auStateSchema.optional(),
    postcode: z.string().trim().regex(/^\d{3,4}$/).optional(),
  })
  .strict();

/** The inverse of `formatLoc`; null for anything that is not a real place. */
export function parseLoc(raw: string): PlaceRef | null {
  const [suburb, state, postcode] = raw.split('|').map((v) => v.trim());
  const parsed = placeRefSchema.safeParse({
    suburb,
    state: state ? state.toUpperCase() : undefined,
    postcode: postcode || undefined,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * A suburb suggestion straight to a `loc`, with no second request: the
 * provider's `{label: 'Officer', secondary: 'VIC, Australia'}` or our own
 * `{label: 'Pakenham', secondary: 'VIC 3810'}`. The server finds the centre,
 * so a chip needs only the name and state. Null when the state cannot be read:
 * then the caller resolves the place properly.
 */
export function suggestionToPlace(s: {
  label: string;
  secondary: string | null;
  kind: string;
}): PlaceRef | null {
  if (s.kind !== 'locality') return null;
  const state = s.secondary?.match(/^\s*(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b/i)?.[1];
  if (!state) return null;
  const postcode = s.secondary?.match(/\b(\d{4})\b/)?.[1];
  return parseLoc([s.label, state, postcode ?? ''].join('|'));
}

const placeKey = (p: { suburb?: string; state?: string; postcode?: string }) =>
  [p.suburb?.toLowerCase(), p.state?.toUpperCase(), p.postcode].join('|');

/**
 * The places of a search, cleaned the one way every reader needs.
 *
 * Dropped: a repeat, and the single `suburb=` if it is also listed. Capped at
 * MAX_SEARCH_PLACES. When what is left is ONE place and there is no single
 * suburb, it becomes `suburb`/`state`/`postcode` — the path every other part of
 * the site (results headings, chat, alerts) has always understood — so a
 * one-suburb search reads the same however the box wrote it.
 */
export function normalisePlaces<T extends { suburb?: string; state?: string; postcode?: string; places?: PlaceRef[] }>(
  query: T,
): T {
  const seen = new Set(query.suburb ? [placeKey(query)] : []);
  const places: PlaceRef[] = [];
  for (const p of query.places ?? []) {
    const key = placeKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    places.push(p);
    if (places.length + (query.suburb ? 1 : 0) >= MAX_SEARCH_PLACES) break;
  }

  const out = { ...query };
  delete out.places;
  const [only] = places;
  if (!query.suburb && places.length === 1 && only) {
    out.suburb = only.suburb;
    if (only.state) out.state = only.state;
    else delete out.state;
    if (only.postcode) out.postcode = only.postcode;
    else delete out.postcode;
  } else if (places.length) {
    out.places = places;
  }
  return out;
}

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
  place: { suburb?: string; state?: string; postcode?: string; places?: PlaceRef[] },
): string | undefined {
  const typed = text?.trim();
  if (!typed) return undefined;

  const placeWords = [place, ...(place.places ?? [])]
    .flatMap((p) => [p.suburb, p.state, p.postcode])
    .filter((v): v is string => Boolean(v))
    .map((v) => v.trim().toLowerCase());

  return placeWords.includes(typed.toLowerCase()) ? undefined : typed;
}

function put(params: URLSearchParams, key: SearchParamKey, value: unknown): void {
  if (value === undefined || value === null || value === '') return;
  params.set(key, String(value));
}

/** The repeatable keys: one `loc` per place, one `type` per extra property type. */
function putLists(
  params: URLSearchParams,
  query: { places?: PlaceRef[]; propertyTypes?: string[] },
): void {
  for (const p of query.places ?? []) params.append('loc', formatLoc(p));
  for (const t of query.propertyTypes ?? []) params.append('type', t);
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
  if (query.newBuild) put(params, 'new', 1);
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
  putLists(params, {
    places: query.places?.map(({ suburb, state, postcode }) => ({ suburb, state, postcode })),
    propertyTypes: query.propertyTypes,
  });

  // A multi-suburb search carries its radius on each place's centre; the
  // radius is the same for all of them (one Distance control).
  const near = query.near ?? query.places?.find((p) => p.near)?.near;
  if (near && !query.near) put(params, 'radius', near.radiusKm);
  if (query.near) {
    put(params, 'radius', query.near.radiusKm);
    if (!query.suburb && !query.places?.length) {
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
    /** More suburbs beside `suburb` (ADR 0099). The radius applies to each. */
    places: z.array(placeRefSchema).min(1).max(MAX_SEARCH_PLACES).optional(),
    channel: listingChannelSchema.optional(),
    /** ADR 0099: the Build tab — new homes only. */
    newBuild: z.literal(true).optional(),
    priceFrom: z.number().nonnegative().optional(),
    priceTo: z.number().nonnegative().optional(),
    bedrooms: z.number().int().min(0).max(20).optional(),
    bathrooms: z.number().int().min(0).max(20).optional(),
    carSpaces: z.number().int().min(0).max(20).optional(),
    propertyType: propertyTypeSchema.optional(),
    /** Any of these (the Filters panel). Set only when more than one was picked. */
    propertyTypes: z.array(propertyTypeSchema).min(2).max(PROPERTY_TYPES.length).optional(),
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
    newBuild: params.get('new') === '1' ? true : undefined,
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

  // The repeatable keys, item by item for the same reason.
  const places = params
    .getAll('loc')
    .map(parseLoc)
    .filter((p): p is PlaceRef => p !== null);
  if (places.length) out.places = places;

  const types = [
    ...new Set(
      params
        .getAll('type')
        .map((t) => propertyTypeSchema.safeParse(t))
        .flatMap((r) => (r.success ? [r.data] : [])),
    ),
  ];
  if (types.length > 1) {
    delete out.propertyType;
    out.propertyTypes = types.slice(0, PROPERTY_TYPES.length);
  } else if (types.length === 1) {
    out.propertyType = types[0];
  }

  const saved = normalisePlaces(out as SavedSearchQuery);

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
  if (query.newBuild) put(params, 'new', 1);
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
  putLists(params, query);

  if (query.radiusKm !== undefined) {
    put(params, 'radius', query.radiusKm);
    // Same asymmetry as searchQueryToParams: a named suburb is re-resolved by
    // /search, so sending coordinates alongside it can only disagree with it.
    if (!query.suburb && !query.places) {
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
  const types = query.propertyTypes ?? (query.propertyType ? [query.propertyType] : []);
  bits.push(
    (query.newBuild ? 'new ' : '') + (types.length ? listOf(types.map((t) => `${t}s`), 'or') : 'homes'),
  );
  if (query.channel === 'rent') bits.push('to rent');
  else if (query.channel === 'sale') bits.push('for sale');

  const names = [query.suburb, ...(query.places ?? []).map((p) => p.suburb)].filter(
    (n): n is string => Boolean(n),
  );
  if (names.length > 1) {
    const where = `in ${listOf(names, 'or')}`;
    bits.push(query.radiusKm ? `${where} and within ${query.radiusKm} km of each` : where);
  } else if (query.suburb) {
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

/** "a, b or c" */
function listOf(items: string[], word: 'or' | 'and'): string {
  return items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} ${word} ${items[items.length - 1]}`;
}

/** The Distance control's steps, in km. A typed distance snaps to the nearest one. */
export const DISTANCE_STEPS_KM = [2, 5, 10, 20, 50] as const;

/**
 * "10 mins walk from …": travel time, which we have no data for (ADR 0099).
 * The box says so instead of guessing with a straight line.
 */
export function asksForTravelTime(text: string): boolean {
  return /\b\d+\s*(?:min|mins|minutes?|hrs?|hours?)\b.*\b(?:walk|drive|driving|walking|cycle|bike|train|commute)\b/i.test(text)
    || /\b(?:walk|drive|walking|driving)\s+(?:from|to)\b/i.test(text);
}
