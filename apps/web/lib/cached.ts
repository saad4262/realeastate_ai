import { unstable_cache } from 'next/cache';
import {
  getPublicListing,
  livePropertyTypes,
  liveSuburbs,
  searchPublicListings,
  type PublicListing,
  type PublicListingSummary,
  type PublicSearchQuery,
} from '@repo/core/listings';
import { resolvePlace } from '@repo/core/geo';
import type { ResolvedPlace } from '@repo/core/geo/schema';
import { getWebDb } from './db';

/**
 * What the public site reads, and how long it may remember the answer.
 *
 * The database is a region away, so every read here is roughly 200 ms of
 * waiting. Before this the consumer site cached nothing at all: a suburb list
 * that changes when an agency publishes its first listing in a new suburb was
 * being fetched on every page view, by every visitor.
 *
 * The rule applied throughout: cache what rarely changes for a long time,
 * cache what changes on publish behind a tag, and invalidate that tag the
 * moment a listing moves. `revalidate` is the safety net for when the
 * invalidation does not arrive, not the mechanism.
 */

/** Everything a published listing appears in. Cleared by /api/revalidate. */
export const LISTINGS_TAG = 'listings';

/**
 * A key the cache can actually tell apart.
 *
 * unstable_cache builds its key from the arguments, and two searches differing
 * only in radius must not share an entry. Sorting the keys means the same
 * search written two ways is still one entry.
 */
function queryKey(query: PublicSearchQuery): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(query)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}

/**
 * Search results.
 *
 * Thirty seconds, because this is the read a visitor refreshes when they are
 * waiting for something to appear, and being wrong here is what makes a portal
 * look broken. The tag is what normally clears it — within a second of an
 * agent publishing — and the TTL only matters if that call never arrives.
 */
export async function cachedSearch(query: PublicSearchQuery): Promise<{
  rows: PublicListingSummary[];
  down: boolean;
}> {
  const run = unstable_cache(
    async () => {
      try {
        return { rows: await searchPublicListings(getWebDb(), query), down: false };
      } catch {
        // The public site stays up without the database; it just has nothing to
        // show. A search that 500s is worse than one with no results under it.
        return { rows: [] as PublicListingSummary[], down: true };
      }
    },
    ['search', queryKey(query)],
    { tags: [LISTINGS_TAG], revalidate: 30 },
  );
  return run();
}

/** One listing, for the detail page. Tagged per id so an edit clears only it. */
export async function cachedListing(id: string): Promise<PublicListing | null> {
  const run = unstable_cache(
    async () => {
      try {
        return await getPublicListing(getWebDb(), id);
      } catch {
        return null;
      }
    },
    ['listing', id],
    { tags: [LISTINGS_TAG, `listing:${id}`], revalidate: 60 },
  );
  return run();
}

/**
 * The filter options: suburbs and property types with something live in them.
 *
 * One call, not two. These were separate queries made on every page load of
 * both the home page and the search page — two round trips to Seoul for two
 * short lists that change when an agency publishes in a new suburb, which is
 * not often.
 */
export async function cachedFilterOptions(): Promise<{
  suburbs: string[];
  propertyTypes: string[];
}> {
  const run = unstable_cache(
    async () => {
      try {
        const db = getWebDb();
        const [suburbs, propertyTypes] = await Promise.all([
          liveSuburbs(db),
          livePropertyTypes(db),
        ]);
        return { suburbs, propertyTypes };
      } catch {
        // The filters lose their suggestions; the search still runs.
        return { suburbs: [] as string[], propertyTypes: [] as string[] };
      }
    },
    ['filter-options'],
    { tags: [LISTINGS_TAG], revalidate: 300 },
  );
  return run();
}

/**
 * A place, for centring a radius search.
 *
 * Already cached in Postgres (`place_cache`), but that is still a round trip to
 * another region on every radius search — measured at about 400 ms of the
 * 1.3 s such a search took. Suburb centres do not move, so this one is cached
 * for a day and carries no tag: nothing an agent does can change where
 * Pakenham is.
 */
export async function cachedPlace(query: string): Promise<ResolvedPlace | null> {
  const run = unstable_cache(
    async () => {
      try {
        return await resolvePlace(getWebDb(), query);
      } catch {
        return null;
      }
    },
    ['place', query.toLowerCase()],
    { revalidate: 86_400 },
  );
  return run();
}
