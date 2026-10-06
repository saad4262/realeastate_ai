import { googleApiKey } from '../geo/provider-google';

/**
 * Google Places (New) for the agency's rating and reviews (ADR 0028 step 1).
 *
 * Server-side only: the key never reaches a browser. Google's Places terms
 * allow us to STORE only a place id; everything this returns is shown and
 * dropped, never written anywhere (see reviews.ts). Every view of it carries
 * Google's attribution and each review's author attribution and link.
 */

const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const DETAILS_URL = 'https://places.googleapis.com/v1/places';
const TIMEOUT_MS = 5000;

export type PlaceHit = { placeId: string; name: string; address: string; rating: number | null; ratingCount: number };

export type GoogleReview = {
  rating: number;
  text: string;
  /** "3 weeks ago" — Google's own wording, shown as given. */
  when: string;
  author: { name: string; uri: string | null; photoUri: string | null };
  /** The review itself on Google Maps (the terms require a way to reach it). */
  mapsUri: string | null;
};

export type PlaceDetails = {
  placeId: string;
  name: string;
  address: string;
  rating: number | null;
  ratingCount: number;
  /** The listing on Google Maps. */
  mapsUri: string | null;
  /** As Google returns them: at most five, chosen and ordered by Google. */
  reviews: GoogleReview[];
};

export type PlacesClient = {
  search(query: string): Promise<PlaceHit[] | null>;
  /** Null: Google did not answer (key, quota, network). 'not_found': the id no longer exists. */
  details(placeId: string): Promise<PlaceDetails | 'not_found' | null>;
};

/** Google place ids are URL-safe base64-ish tokens. Anything else never reaches a URL. */
export function isPlaceId(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{10,400}$/.test(v);
}

type RawPlace = {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  rating?: number;
  userRatingCount?: number;
  googleMapsUri?: string;
  reviews?: {
    rating?: number;
    relativePublishTimeDescription?: string;
    text?: { text?: string };
    originalText?: { text?: string };
    authorAttribution?: { displayName?: string; uri?: string; photoUri?: string };
    googleMapsUri?: string;
  }[];
};

const httpsOnly = (u: string | undefined) => (u && /^https:\/\//.test(u) ? u : null);

export function parseDetails(raw: RawPlace): PlaceDetails | null {
  if (!raw.id) return null;
  return {
    placeId: raw.id,
    name: raw.displayName?.text ?? '',
    address: raw.formattedAddress ?? '',
    rating: typeof raw.rating === 'number' ? raw.rating : null,
    ratingCount: raw.userRatingCount ?? 0,
    mapsUri: httpsOnly(raw.googleMapsUri),
    reviews: (raw.reviews ?? []).map((r) => ({
      rating: r.rating ?? 0,
      text: r.text?.text ?? r.originalText?.text ?? '',
      when: r.relativePublishTimeDescription ?? '',
      author: {
        name: r.authorAttribution?.displayName ?? 'A Google user',
        uri: httpsOnly(r.authorAttribution?.uri),
        photoUri: httpsOnly(r.authorAttribution?.photoUri),
      },
      mapsUri: httpsOnly(r.googleMapsUri),
    })),
  };
}

async function call(url: string, init: RequestInit): Promise<Response | null> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), cache: 'no-store' });
  } catch {
    return null;
  }
}

/** The real client, reading GOOGLE_MAPS_API_KEY at call time. Null when there is no key. */
export function googlePlacesFromEnv(): PlacesClient | null {
  const key = googleApiKey();
  if (!key) return null;
  return {
    async search(query) {
      const res = await call(SEARCH_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Goog-Api-Key': key,
          'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount',
        },
        body: JSON.stringify({ textQuery: query, regionCode: 'AU', languageCode: 'en-AU', pageSize: 8 }),
      });
      if (!res?.ok) return null;
      const body = (await res.json().catch(() => null)) as { places?: RawPlace[] } | null;
      return (body?.places ?? [])
        .filter((p) => isPlaceId(p.id))
        .map((p) => ({ placeId: p.id!, name: p.displayName?.text ?? '', address: p.formattedAddress ?? '', rating: p.rating ?? null, ratingCount: p.userRatingCount ?? 0 }));
    },
    async details(placeId) {
      if (!isPlaceId(placeId)) return 'not_found';
      const res = await call(`${DETAILS_URL}/${encodeURIComponent(placeId)}?languageCode=en-AU`, {
        headers: {
          'X-Goog-Api-Key': key,
          'X-Goog-FieldMask': 'id,displayName,formattedAddress,rating,userRatingCount,googleMapsUri,reviews',
        },
      });
      if (!res) return null;
      if (res.status === 404) return 'not_found';
      if (!res.ok) {
        // An id Google retired answers 400 INVALID_ARGUMENT or 404 NOT_FOUND.
        const err = (await res.json().catch(() => null)) as { error?: { status?: string } } | null;
        return err?.error?.status === 'NOT_FOUND' || err?.error?.status === 'INVALID_ARGUMENT' ? 'not_found' : null;
      }
      return parseDetails((await res.json().catch(() => ({}))) as RawPlace);
    },
  };
}
