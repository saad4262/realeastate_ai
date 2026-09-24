import { unstable_cache } from 'next/cache';
import {
  getPublicListing,
  listingAgentCards,
  listingInspections,
  propertyTimeline,
  livePropertyTypes,
  liveSuburbs,
  searchPublicListingsPage,
  type PublicAgentCard,
  type PublicInspection,
  type PublicListing,
  type PublicListingSummary,
  type PublicTimelineEntry,
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
 *
 * next.config.ts derives experimental.staleTimes.dynamic from this number. The
 * client router cache must never outlive the data cache behind it, or a Back
 * button can show something a fresh render would not. Change this and change
 * that, in the same commit.
 */
/**
 * Bring a Date back from the cache.
 *
 * `unstable_cache` serialises whatever it is given to JSON and parses it back
 * out, so every Date that goes into it comes out as an ISO STRING while the
 * type still says Date. Nothing caught it for months because nothing rendered
 * a date — the first thing that did, `listedLabel`, died on
 * `publishedAt.getTime is not a function`.
 *
 * This is the third shape of the same bug in this codebase: a value whose
 * runtime type does not match its declared one, at a boundary TypeScript
 * cannot see across (bigint counts as strings, numeric as strings, now dates).
 * Fixed where the lie is created rather than by teaching every consumer to
 * expect either — a helper that accepts `Date | string` spreads the boundary
 * through the whole app.
 */
function reviveDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function cachedSearch(query: PublicSearchQuery): Promise<{
  rows: PublicListingSummary[];
  /** How many matched in total, not how many are on this page. */
  total: number;
  down: boolean;
}> {
  const run = unstable_cache(
    async () => {
      try {
        const { rows, total } = await searchPublicListingsPage(getWebDb(), query);
        return { rows, total, down: false };
      } catch {
        // The public site stays up without the database; it just has nothing to
        // show. A search that 500s is worse than one with no results under it.
        return { rows: [] as PublicListingSummary[], total: 0, down: true };
      }
    },
    ['search', queryKey(query)],
    { tags: [LISTINGS_TAG], revalidate: 30 },
  );
  const result = await run();
  return {
    ...result,
    rows: result.rows.map((r) => ({ ...r, publishedAt: reviveDate(r.publishedAt) })),
  };
}

/** One listing, for the detail page. Tagged per id so an edit clears only it. */

/**
 * The three reads that sit beside a listing on its page.
 *
 * Tagged exactly like the listing itself, so publishing or editing clears the
 * page whole rather than leaving yesterday's inspection times beside today's
 * price. The page starts all four together, so this is one round trip's
 * latency rather than four.
 */
export async function cachedInspections(listingId: string): Promise<PublicInspection[]> {
  const run = unstable_cache(
    async () => {
      try {
        return await listingInspections(getWebDb(), listingId);
      } catch {
        return [];
      }
    },
    ['inspections', listingId],
    { tags: [LISTINGS_TAG, `listing:${listingId}`], revalidate: 60 },
  );
  const rows = await run();
  // Dropped rather than defaulted: both columns are NOT NULL, so a row whose
  // dates will not revive is corrupt, and a corrupt inspection rendered as
  // 1 January 1970 is worse than one not shown.
  return rows.flatMap((r) => {
    const startsAt = reviveDate(r.startsAt);
    const endsAt = reviveDate(r.endsAt);
    return startsAt && endsAt ? [{ ...r, startsAt, endsAt }] : [];
  });
}

export async function cachedAgentCards(listingId: string): Promise<PublicAgentCard[]> {
  const run = unstable_cache(
    async () => {
      try {
        return await listingAgentCards(getWebDb(), listingId);
      } catch {
        return [];
      }
    },
    ['agent-cards', listingId],
    { tags: [LISTINGS_TAG, `listing:${listingId}`], revalidate: 60 },
  );
  return run();
}

/**
 * Keyed by the PROPERTY, and tagged with the global listings tag rather than
 * one listing's — a sale recorded against a neighbouring listing changes this
 * address's history without touching the listing being viewed.
 */
export async function cachedTimeline(propertyId: string): Promise<PublicTimelineEntry[]> {
  const run = unstable_cache(
    async () => {
      try {
        return await propertyTimeline(getWebDb(), propertyId);
      } catch {
        return [];
      }
    },
    ['timeline', propertyId],
    { tags: [LISTINGS_TAG], revalidate: 60 },
  );
  const rows = await run();
  return rows.map((r) => ({
    ...r,
    soldDate: reviveDate(r.soldDate),
    publishedAt: reviveDate(r.publishedAt),
  }));
}

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
  const row = await run();
  return row && { ...row, publishedAt: reviveDate(row.publishedAt) };
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
