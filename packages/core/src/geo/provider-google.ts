import {
  type GeoProvider,
  type PlaceKind,
  type PlaceSuggestion,
  type ResolvedPlace,
} from './place-schema';

/**
 * Google Places + Geocoding.
 *
 * The key is read at call time, not at import, so a server that starts before
 * the key is set picks it up on the next request rather than on a redeploy.
 * Requests are server-side only: the key is never sent to a browser, which is
 * also why no NEXT_PUBLIC_ variant of it exists.
 *
 * Two generations of the Places API exist and they are separate products in
 * the Google console, listed as "Places API" and "Places API (New)" — enabling
 * one does not enable the other, and the names are close enough that enabling
 * the wrong one is the ordinary outcome. Rather than make that a support
 * problem, this asks the new endpoint first and falls back to the old one, so
 * autocomplete works with either enabled.
 */
const AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const DETAILS_URL = 'https://places.googleapis.com/v1/places';
const LEGACY_AUTOCOMPLETE_URL =
  'https://maps.googleapis.com/maps/api/place/autocomplete/json';
const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

/** Australia only. A NSW agency has no use for a Bondi in California. */
const REGION = 'au';

/** A geocoder is never worth blocking a page render on. */
const TIMEOUT_MS = 4000;

type GoogleComponent = {
  longText?: string;
  shortText?: string;
  types?: string[];
};

type GooglePlace = {
  id?: string;
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  addressComponents?: GoogleComponent[];
  types?: string[];
};

export function googleApiKey(): string | null {
  const key = process.env.GOOGLE_MAPS_API_KEY?.trim();
  return key ? key : null;
}

/** Whether address autocomplete can work at all right now. */
export function isGeoProviderConfigured(): boolean {
  return googleApiKey() !== null;
}

async function fetchJson<T>(
  url: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    // A timeout, a DNS failure or a quota refusal are all the same to the
    // caller: no suggestion. Search still works on suburb text.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Primary types Google will accept, per kind we care about. */
const PRIMARY_TYPES: Record<PlaceKind, string[]> = {
  address: ['street_address', 'premise', 'subpremise'],
  locality: ['locality', 'sublocality', 'postal_code'],
  postcode: ['postal_code'],
  region: ['administrative_area_level_1', 'administrative_area_level_2'],
};

function kindFromTypes(types: string[] | undefined): PlaceKind {
  const t = new Set(types ?? []);
  if (t.has('street_address') || t.has('premise') || t.has('subpremise')) return 'address';
  if (t.has('postal_code')) return 'postcode';
  if (t.has('locality') || t.has('sublocality') || t.has('sublocality_level_1')) return 'locality';
  if (t.has('administrative_area_level_1') || t.has('country')) return 'region';
  // Google returns 'geocode' for plenty of things; a street address is the
  // safer default because it only narrows the radius, never widens it.
  return 'address';
}

function componentsOf(place: GooglePlace) {
  const pick = (type: string, short = false): string | null => {
    const hit = place.addressComponents?.find((c) => c.types?.includes(type));
    if (!hit) return null;
    return (short ? hit.shortText : hit.longText) ?? null;
  };
  return {
    unit: pick('subpremise'),
    streetNumber: pick('street_number'),
    street: pick('route'),
    suburb: pick('locality') ?? pick('sublocality') ?? pick('postal_town'),
    state: pick('administrative_area_level_1', true),
    postcode: pick('postal_code'),
  };
}

function toResolved(place: GooglePlace): ResolvedPlace | null {
  const lat = place.location?.latitude;
  const lng = place.location?.longitude;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  return {
    placeId: place.id ?? null,
    formatted: place.formattedAddress ?? '',
    ...componentsOf(place),
    latitude: lat,
    longitude: lng,
    kind: kindFromTypes(place.types),
  };
}

/** Autocomplete against Places API (New). Empty if it is not enabled. */
async function suggestNew(
  key: string,
  input: string,
  kinds: PlaceKind[],
): Promise<PlaceSuggestion[]> {
  type Response = {
    suggestions?: {
      placePrediction?: {
        placeId?: string;
        text?: { text?: string };
        structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } };
        types?: string[];
      };
    }[];
  };

  const body: Record<string, unknown> = {
    input,
    includedRegionCodes: [REGION],
    languageCode: 'en-AU',
  };
  // Google caps includedPrimaryTypes at five and rejects the whole request
  // when the cap is exceeded, so this is a hard slice, not a nicety.
  const includedPrimaryTypes = kinds.flatMap((k) => PRIMARY_TYPES[k]).slice(0, 5);
  if (includedPrimaryTypes.length) body.includedPrimaryTypes = includedPrimaryTypes;

  const data = await fetchJson<Response>(AUTOCOMPLETE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask':
        'suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat,suggestions.placePrediction.types',
    },
    body: JSON.stringify(body),
  });

  const out: PlaceSuggestion[] = [];
  for (const s of data?.suggestions ?? []) {
    const p = s.placePrediction;
    const id = p?.placeId;
    const label = p?.structuredFormat?.mainText?.text ?? p?.text?.text;
    if (!id || !label) continue;
    out.push({
      id,
      label,
      secondary: p?.structuredFormat?.secondaryText?.text ?? null,
      kind: kindFromTypes(p?.types),
    });
  }
  return out;
}

/**
 * Autocomplete against the original Places API.
 *
 * Kept because the two are separate products in the Google console and a
 * project commonly has only the old one switched on. It has no equivalent of
 * includedPrimaryTypes — `types` takes one value — so the kinds are collapsed
 * to the nearest single filter it understands.
 */
async function suggestLegacy(
  key: string,
  input: string,
  kinds: PlaceKind[],
): Promise<PlaceSuggestion[]> {
  type Response = {
    status?: string;
    predictions?: {
      place_id?: string;
      description?: string;
      structured_formatting?: { main_text?: string; secondary_text?: string };
      types?: string[];
    }[];
  };

  const url = new URL(LEGACY_AUTOCOMPLETE_URL);
  url.searchParams.set('input', input);
  url.searchParams.set('components', 'country:au');
  url.searchParams.set('language', 'en-AU');
  url.searchParams.set('key', key);

  // 'address' asks for street addresses; '(regions)' asks for suburbs,
  // postcodes and states. Asking for both means asking for neither, so a mixed
  // request is left unfiltered rather than narrowed to the wrong one.
  const wantsAddress = kinds.includes('address');
  const wantsRegion = kinds.some((k) => k === 'locality' || k === 'postcode' || k === 'region');
  if (wantsAddress && !wantsRegion) url.searchParams.set('types', 'address');
  else if (wantsRegion && !wantsAddress) url.searchParams.set('types', '(regions)');

  const data = await fetchJson<Response>(url.toString());
  if (data?.status && data.status !== 'OK' && data.status !== 'ZERO_RESULTS') return [];

  const out: PlaceSuggestion[] = [];
  for (const p of data?.predictions ?? []) {
    const id = p.place_id;
    const label = p.structured_formatting?.main_text ?? p.description;
    if (!id || !label) continue;
    out.push({
      id,
      label,
      secondary: p.structured_formatting?.secondary_text ?? null,
      kind: kindFromTypes(p.types),
    });
  }
  return out;
}

/**
 * Geocoding API, by free text or by place id.
 *
 * A separate product from Places, and the one that is reliably enabled: it is
 * what gives an address typed by hand its coordinates, and what rescues a
 * legacy place id when Places (New) is switched off.
 */
async function geocode(
  key: string,
  params: { address: string } | { place_id: string } | { latlng: string },
): Promise<ResolvedPlace | null> {
  type GeocodeResponse = {
    status?: string;
    results?: {
      place_id?: string;
      formatted_address?: string;
      geometry?: { location?: { lat?: number; lng?: number } };
      address_components?: { long_name?: string; short_name?: string; types?: string[] }[];
      types?: string[];
    }[];
  };

  const url = new URL(GEOCODE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  // components/region only make sense for a text lookup; a place id is already
  // unambiguous, and Google rejects the combination.
  if ('address' in params) {
    url.searchParams.set('components', 'country:AU');
    url.searchParams.set('region', REGION);
  }
  url.searchParams.set('key', key);

  const data = await fetchJson<GeocodeResponse>(url.toString());
  const first = data?.results?.[0];
  if (!first) return null;

  return toResolved({
    id: first.place_id,
    formattedAddress: first.formatted_address,
    location: {
      latitude: first.geometry?.location?.lat,
      longitude: first.geometry?.location?.lng,
    },
    addressComponents: first.address_components?.map((c) => ({
      longText: c.long_name,
      shortText: c.short_name,
      types: c.types,
    })),
    types: first.types,
  });
}

export const googleGeoProvider: GeoProvider = {
  name: 'google',

  async suggest(query, opts) {
    const key = googleApiKey();
    const input = query.trim();
    // Two characters match half of Australia and cost a request each.
    if (!key || input.length < 3) return [];

    const kinds = opts?.kinds ?? [];

    // New first — it is the one Google is keeping. An empty result is both
    // "nothing matched" and "this API is not enabled", and trying the old
    // endpoint costs one request in the first case and rescues the second.
    const viaNew = await suggestNew(key, input, kinds);
    if (viaNew.length) return viaNew;

    return suggestLegacy(key, input, kinds);
  },

  async resolve(idOrQuery) {
    const key = googleApiKey();
    if (!key) return null;
    const value = idOrQuery.trim();
    if (!value) return null;

    // A suggestion id is a place id; anything else is text the user typed and
    // never picked from the list, which Geocoding handles and Places does not.
    const looksLikePlaceId = !value.includes(' ') && value.length > 16;

    if (looksLikePlaceId) {
      const place = await fetchJson<GooglePlace>(
        `${DETAILS_URL}/${encodeURIComponent(value)}?languageCode=en-AU`,
        {
          headers: {
            'X-Goog-Api-Key': key,
            'X-Goog-FieldMask': 'id,formattedAddress,location,addressComponents,types',
          },
        },
      );
      const resolved = place ? toResolved(place) : null;
      if (resolved) return resolved;

      // Places (New) may simply not be enabled, in which case the id came from
      // the old autocomplete above. Geocoding takes a place_id directly and is
      // a different product, so it is usually switched on when Places is not.
      const byId = await geocode(key, { place_id: value });
      if (byId) return byId;

      // Still nothing: a stale id is better answered by a text search than by
      // telling the agent their address does not exist. Fall through.
    }

    return geocode(key, { address: value });
  },

  async reverse(lat, lng) {
    const key = googleApiKey();
    if (!key) return null;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    // Six decimals is about 10 cm — finer than any pin a person drags, and it
    // keeps the cache key stable when the marker is nudged by a pixel.
    return geocode(key, { latlng: `${lat.toFixed(6)},${lng.toFixed(6)}` });
  },
};
