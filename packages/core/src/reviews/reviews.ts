import { and, eq, sql } from 'drizzle-orm';
import { agency, agencyGooglePlace, listing, type Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import { publicListing } from '../listings/search-listings';
import { googlePlacesFromEnv, isPlaceId, type PlaceDetails, type PlaceHit, type PlacesClient } from './google-places';

/**
 * The agency's Google rating and reviews, step 1 (ADR 0028), under Google's
 * Places terms as checked on 2026-10-06:
 *
 * - Only the PLACE ID is stored (the one Places field the terms let us keep).
 *   Name, address, rating and reviews are fetched from Google every time they
 *   are shown, and never written to the database or a cache. Identical calls
 *   that are in flight at the same moment share one request — nothing is kept
 *   after it answers.
 * - Everything shown carries Google's attribution, each review its author's
 *   name, photo and link, and a link to the review on Google Maps.
 * - Reviews are shown exactly as Google returns them (its choice and order,
 *   never filtered by stars), with a line saying so.
 *
 * ADR 0028 planned a 6-hour server cache; the terms do not allow caching
 * Places content, so there is none (see the as-built note in the ADR).
 */

export class ReviewError extends Error {
  constructor(
    readonly code: 'forbidden' | 'invalid' | 'unavailable' | 'rate_limited',
    message: string,
  ) {
    super(message);
    this.name = 'ReviewError';
  }
}

export type ReviewDeps = { places?: PlacesClient | null };

const client = (deps: ReviewDeps) => (deps.places === undefined ? googlePlacesFromEnv() : deps.places);

/** Same place, same moment → one request. Removed as soon as it settles: not a cache. */
const inFlight = new Map<string, Promise<PlaceDetails | 'not_found' | null>>();
function details(places: PlacesClient, placeId: string) {
  const running = inFlight.get(placeId);
  if (running) return running;
  const p = places.details(placeId).finally(() => inFlight.delete(placeId));
  inFlight.set(placeId, p);
  return p;
}

/** ADR 0028: the picker searches at most once a second per person. */
const lastSearch = new Map<string, number>();

export async function searchGooglePlaces(actor: Actor, query: string, deps: ReviewDeps = {}, now = Date.now()): Promise<PlaceHit[]> {
  if (!actor.agencyId || !can(actor, 'google_place:manage', { type: 'agency_google_place', agencyId: actor.agencyId })) {
    throw new ReviewError('forbidden', 'Only an owner or admin can choose the agency’s Google listing');
  }
  const q = query.trim().replace(/\s+/g, ' ');
  if (q.length < 3 || q.length > 120) throw new ReviewError('invalid', 'Type the agency’s name and suburb (3 to 120 characters)');
  const last = lastSearch.get(actor.userId) ?? 0;
  if (now - last < 1000) throw new ReviewError('rate_limited', 'One search a second — try again');
  lastSearch.set(actor.userId, now);
  if (lastSearch.size > 5000) lastSearch.clear();
  const places = client(deps);
  if (!places) throw new ReviewError('unavailable', 'Google search is not set up on this server (GOOGLE_MAPS_API_KEY)');
  const hits = await places.search(q);
  if (!hits) throw new ReviewError('unavailable', 'Google did not answer — try again in a minute');
  return hits;
}

/**
 * Link the agency to a Google listing (or change it). The id is confirmed
 * with Google first — outside any transaction — and only the id is stored.
 */
export async function setAgencyGooglePlace(db: Db, actor: Actor, placeId: unknown, deps: ReviewDeps = {}): Promise<void> {
  if (!actor.agencyId || !can(actor, 'google_place:manage', { type: 'agency_google_place', agencyId: actor.agencyId })) {
    throw new ReviewError('forbidden', 'Only an owner or admin can choose the agency’s Google listing');
  }
  if (!isPlaceId(placeId)) throw new ReviewError('invalid', 'That is not a Google listing');
  const places = client(deps);
  if (!places) throw new ReviewError('unavailable', 'Google is not set up on this server (GOOGLE_MAPS_API_KEY)');
  const found = await places.details(placeId);
  if (found === 'not_found') throw new ReviewError('invalid', 'Google no longer has that listing — search again');
  if (!found) throw new ReviewError('unavailable', 'Google did not answer — try again in a minute');
  await db
    .insert(agencyGooglePlace)
    .values({ agencyId: actor.agencyId, placeId, pickedBy: actor.userId })
    .onConflictDoUpdate({
      target: agencyGooglePlace.agencyId,
      set: { placeId, pickedBy: actor.userId, pickedAt: sql`now()`, updatedAt: sql`now()` },
    });
}

export async function clearAgencyGooglePlace(db: Db, actor: Actor): Promise<void> {
  if (!actor.agencyId || !can(actor, 'google_place:manage', { type: 'agency_google_place', agencyId: actor.agencyId })) {
    throw new ReviewError('forbidden', 'Only an owner or admin can change the agency’s Google listing');
  }
  await db.delete(agencyGooglePlace).where(eq(agencyGooglePlace.agencyId, actor.agencyId));
}

export type AgencyReviews =
  | { state: 'not_set'; agencyName: string; mayManage: boolean }
  | { state: 'not_found' | 'unavailable'; agencyName: string; mayManage: boolean; pickedAt: Date }
  | { state: 'ok'; agencyName: string; mayManage: boolean; pickedAt: Date; place: PlaceDetails };

/** The console view: any member of the agency (`review:read`). One statement, then Google. */
export async function agencyReviews(db: Db, actor: Actor, deps: ReviewDeps = {}): Promise<AgencyReviews> {
  if (!actor.agencyId || !can(actor, 'review:read', { type: 'agency_google_place', agencyId: actor.agencyId })) {
    throw new ReviewError('forbidden', 'You cannot see this agency’s reviews');
  }
  const [row] = await db
    .select({ agencyName: agency.name, placeId: agencyGooglePlace.placeId, pickedAt: agencyGooglePlace.pickedAt })
    .from(agency)
    .leftJoin(agencyGooglePlace, eq(agencyGooglePlace.agencyId, agency.id))
    .where(eq(agency.id, actor.agencyId))
    .limit(1);
  const mayManage = can(actor, 'google_place:manage', { type: 'agency_google_place', agencyId: actor.agencyId });
  const agencyName = row?.agencyName ?? '';
  if (!row?.placeId) return { state: 'not_set', agencyName, mayManage };
  const pickedAt = new Date(row.pickedAt!);
  const places = client(deps);
  const got = places ? await details(places, row.placeId) : null;
  if (got === 'not_found') return { state: 'not_found', agencyName, mayManage, pickedAt };
  if (!got) return { state: 'unavailable', agencyName, mayManage, pickedAt };
  return { state: 'ok', agencyName, mayManage, pickedAt, place: got };
}

export type PublicReviews = { agencyName: string; place: PlaceDetails };

/**
 * For the public listing page: the listing's agency's Google rating and
 * reviews — or null, and the page shows nothing at all, when the listing is
 * not public, the agency has not picked a listing, or Google did not answer.
 */
export async function publicListingReviews(db: Db, listingId: string, deps: ReviewDeps = {}): Promise<PublicReviews | null> {
  if (!/^[0-9a-f-]{36}$/i.test(listingId)) return null;
  const [row] = await db
    .select({ agencyName: agency.name, placeId: agencyGooglePlace.placeId })
    .from(listing)
    .innerJoin(agency, eq(agency.id, listing.agencyId))
    .innerJoin(agencyGooglePlace, eq(agencyGooglePlace.agencyId, listing.agencyId))
    .where(and(eq(listing.id, listingId), publicListing()))
    .limit(1);
  if (!row) return null;
  const places = client(deps);
  if (!places) return null;
  const got = await details(places, row.placeId);
  if (!got || got === 'not_found' || got.rating === null) return null;
  return { agencyName: row.agencyName, place: got };
}
