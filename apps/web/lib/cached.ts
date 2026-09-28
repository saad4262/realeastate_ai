import { unstable_cache } from 'next/cache';
import {
  getPublicListing,
  listingAgentCards,
  listingInspections,
  propertyTimeline,
  nearbyMarket,
  searchFacets,
  searchPublicListingsPage,
  topSuburbAgents,
  nearbySuburbs,
  type PublicAgentCard,
  type PublicInspection,
  type PublicListing,
  type PublicListingSummary,
  type PublicTimelineEntry,
  type PublicSearchQuery,
  type PublicSuburbAgent,
  type PublicNearbySuburb,
  type SearchFacets,
  type NearbyMarket,
  type NearbyMarketQuery,
} from '@repo/core/listings';
import { listingPhotos, type ListingPhoto } from '@repo/core/media';
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
 * Everything the search filters may offer, from what is actually listed.
 *
 * ONE call and one query, where this used to be two — and where the obvious
 * shape would now be six. Beds, baths, car spaces, property types, price
 * bounds and the suburb list all come out of the same statement, split by
 * channel, because this is on the first paint of the home page, the search
 * page and the chat, and the database is a region away.
 *
 * Five minutes and the listings tag. These change when an agency publishes in
 * a new suburb or lists the first four-bedroom house, which is not often, and
 * a publish clears the tag within a second either way.
 */
const EMPTY_CHANNEL = {
  total: 0,
  bedrooms: [] as number[],
  bathrooms: [] as number[],
  carSpaces: [] as number[],
  propertyTypes: [] as string[],
  priceMin: null,
  priceMax: null,
};

export async function cachedFacets(): Promise<SearchFacets> {
  const run = unstable_cache(
    async () => {
      try {
        return await searchFacets(getWebDb());
      } catch {
        // The filters lose their options; the search still runs, and every
        // control falls back to "Any".
        return {
          sale: { ...EMPTY_CHANNEL },
          rent: { ...EMPTY_CHANNEL },
          suburbs: [] as string[],
        } satisfies SearchFacets;
      }
    },
    ['facets'],
    { tags: [LISTINGS_TAG], revalidate: 300 },
  );
  return run();
}

/**
 * The two lists the property chat shows the model.
 *
 * Derived from the same cached facets rather than queried again: the model is
 * told which suburbs and property types exist so it cannot invent one, and
 * that is a strict subset of what the filters already know. Property types are
 * unioned across channels — a renter asking for a townhouse should not be told
 * townhouses do not exist because only sale listings have one.
 */
export async function cachedFilterOptions(): Promise<{
  suburbs: string[];
  propertyTypes: string[];
}> {
  const facets = await cachedFacets();
  return {
    suburbs: facets.suburbs,
    propertyTypes: [
      ...new Set([...facets.sale.propertyTypes, ...facets.rent.propertyTypes]),
    ].sort((a, b) => a.localeCompare(b)),
  };
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

/**
 * The two sidebar panels on /search.
 *
 * Cached for five minutes and tagged like everything else, because both answers
 * only move when an agency publishes or withdraws — and a results page is
 * already paying for a search, a place lookup and a filter list. These must not
 * add two more cold round trips to Seoul on top of that.
 *
 * Both swallow their own failures. The sidebar is the least important thing on
 * this page; an outage there should cost the panel, not the results beside it.
 */
export async function cachedTopAgents(scope: {
  suburb: string;
  state?: string;
  channel?: PublicSearchQuery['channel'];
}): Promise<PublicSuburbAgent[]> {
  const run = unstable_cache(
    async () => {
      try {
        return await topSuburbAgents(getWebDb(), scope);
      } catch {
        return [] as PublicSuburbAgent[];
      }
    },
    ['top-agents', scope.suburb.toLowerCase(), scope.state ?? '', scope.channel ?? ''],
    { tags: [LISTINGS_TAG], revalidate: 300 },
  );
  return run();
}

export async function cachedNearbySuburbs(scope: {
  suburb?: string;
  state?: string;
  channel?: PublicSearchQuery['channel'];
  near?: PublicSearchQuery['near'];
}): Promise<PublicNearbySuburb[]> {
  const run = unstable_cache(
    async () => {
      try {
        return await nearbySuburbs(getWebDb(), scope);
      } catch {
        return [] as PublicNearbySuburb[];
      }
    },
    [
      'nearby-suburbs',
      scope.suburb?.toLowerCase() ?? '',
      scope.state ?? '',
      scope.channel ?? '',
      // The centre is part of the key: the same suburb searched with a
      // different radius is drawn from the same point, but a street-address
      // search is not, and two of those must not share an entry.
      scope.near ? `${scope.near.lat},${scope.near.lng}` : '',
    ],
    { tags: [LISTINGS_TAG], revalidate: 300 },
  );
  return run();
}

/**
 * A listing's photos, for the gallery.
 *
 * Tagged per listing exactly like the row itself, so uploading or deleting a
 * photo clears this page and nothing else the moment the console calls
 * /api/revalidate. Without the tag a new photo would appear when a timer said
 * so — the same failure that made the site uncacheable before revalidation
 * existed.
 *
 * The results page does NOT use this. It gets each listing's cover key inside
 * the search statement itself, because one read per row is the N+1 that
 * query-count.test.ts refuses.
 */
export async function cachedListingPhotos(listingId: string): Promise<ListingPhoto[]> {
  const run = unstable_cache(
    async () => {
      try {
        return await listingPhotos(getWebDb(), listingId);
      } catch {
        // The gallery falls back to its placeholder. A storage or database
        // hiccup should cost the photos, not the property page.
        return [] as ListingPhoto[];
      }
    },
    ['listing-photos', listingId],
    { tags: [LISTINGS_TAG, `listing:${listingId}`], revalidate: 60 },
  );
  return run();
}

/**
 * "Cheapest near here", for the property guide.
 *
 * Cached like every other read on this route — the guide's tools are injected
 * precisely so the app decides that, and this was a direct database call for
 * one commit, which made it the only read here going to the database region
 * on every turn.
 *
 * Thirty seconds, matching cachedSearch: this answers the same question about
 * the same rows, and the two disagreeing about how stale they may be would let
 * the guide quote a listing the results panel beside it no longer shows.
 *
 * The key carries the point to six decimal places. Two offices a street apart
 * are different questions.
 */
export async function cachedNearbyMarket(query: NearbyMarketQuery): Promise<NearbyMarket> {
  const run = unstable_cache(
    async () => {
      try {
        return await nearbyMarket(getWebDb(), query);
      } catch {
        // The guide is told nothing was found rather than being handed an
        // exception mid-turn. dispatchTool turns a throw into a dead turn.
        return { listings: [], bySuburb: [], unpriced: 0 } satisfies NearbyMarket;
      }
    },
    [
      'nearby-market',
      `${query.near.lat.toFixed(6)},${query.near.lng.toFixed(6)}`,
      String(query.near.radiusKm),
      query.channel,
      query.bedrooms === undefined ? '' : String(query.bedrooms),
      query.propertyType ?? '',
      String(query.limit ?? ''),
    ],
    { tags: [LISTINGS_TAG], revalidate: 30 },
  );
  return run();
}
