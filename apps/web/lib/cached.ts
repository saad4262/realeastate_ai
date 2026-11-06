import { unstable_cache } from 'next/cache';
import {
  getOffMarketProperty,
  getPublicListing,
  listingAgentCards,
  listingInspections,
  propertyTimeline,
  liveListingIdForProperty,
  formerListingDestination,
  nearbyMarket,
  recentSalesPage,
  searchFacets,
  searchPublicListingsPage,
  topSuburbAgents,
  nearbySuburbs,
  type OffMarketProperty,
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
  type RecentSalesPage,
  type RecentSalesQuery,
} from '@repo/core/listings';
import { listingPhotos, type ListingPhoto } from '@repo/core/media';
import { resolvePlace } from '@repo/core/geo';
import type { ResolvedPlace } from '@repo/core/geo/schema';
import { dueDiligenceRecords, type RecordFact } from '@repo/core/due-diligence';
import { comparables, homeRows, researchData, suburbProfile, type BuyerType, type Comparable, type HomeRow, type ResearchAsk, type SuburbProfile } from '@repo/core/research';
import { similarHomes, type Suggestion } from '@repo/core/discovery';
import { listingExtras, type ListingExtras } from '@repo/core/media';
import { landAndZoning, zoningAt, zoningSubject, type LandAndZoning, type ZoningAnswer, type ZoningSubject } from '@repo/core/development';
import { homesThatLookLike, type LookAsk, type LookResult } from '@repo/core/visual-search';
import { imageEmbedderFromEnv } from '@repo/ai/visual-embed';
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
      const { rows, total } = await searchPublicListingsPage(getWebDb(), query);
      return { rows, total, down: false };
    },
    ['search', queryKey(query)],
    { tags: [LISTINGS_TAG], revalidate: 30 },
  );
  try {
    const result = await run();
    return {
      ...result,
      rows: result.rows.map((r) => ({ ...r, publishedAt: reviveDate(r.publishedAt) })),
    };
  } catch (err) {
    // The public site stays up without the database; it just has nothing to
    // show. A search that 500s is worse than one with no results under it.
    // Caught outside the cache: a failure caught inside was stored, and showed
    // every visitor "unavailable" for 30 seconds, with nothing in the logs.
    console.error('[search] failed', err);
    return { rows: [], total: 0, down: true };
  }
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

/**
 * "What our records show" for Due-Diligence AI (ADR 0080, C2). Strings only, so the JSON round trip changes
 * nothing. An hour, under the listings tag: an edited price or a recorded sale clears it at once through
 * `revalidateWeb`; the hour only bounds how stale "N days on the market" may be.
 *
 * `null` on a database failure, never `[]` — an empty list would tell a buyer this address has no history.
 */
export async function cachedDueDiligence(propertyId: string, listingId: string | null): Promise<RecordFact[] | null> {
  const run = unstable_cache(
    async () => {
      try {
        return await dueDiligenceRecords(getWebDb(), propertyId, listingId);
      } catch {
        return null;
      }
    },
    ['due-diligence', propertyId, listingId ?? '-'],
    { tags: [LISTINGS_TAG], revalidate: 3600 },
  );
  return run();
}

/**
 * C5 research reads (ADR 0080): a suburb, homes side by side, one home's comparables. Public data only — the core
 * readers apply the public filter — under the listings tag for an hour, so an edited listing or a sale clears them.
 * `null` on a database failure, never an empty result that would read as "nothing here".
 */
function dated<T>(value: T): T {
  // unstable_cache JSON round-trips: revive the Date fields these shapes carry.
  return JSON.parse(JSON.stringify(value), (k, v) => (k === 'soldOn' && typeof v === 'string' ? new Date(v) : v)) as T;
}

export async function cachedSuburbProfile(state: string, suburb: string): Promise<SuburbProfile | null | 'down'> {
  const run = unstable_cache(
    async () => {
      try {
        return await suburbProfile(getWebDb(), { state, suburb });
      } catch {
        return 'down' as const;
      }
    },
    ['suburb-profile', state.toUpperCase(), suburb.toLowerCase()],
    { tags: [LISTINGS_TAG], revalidate: 3600 },
  );
  const out = await run();
  return out && out !== 'down' ? dated(out) : out;
}

export async function cachedHomeRows(ids: readonly string[], buyer: BuyerType): Promise<HomeRow[] | null> {
  const run = unstable_cache(
    async () => {
      try {
        return await homeRows(getWebDb(), ids, buyer);
      } catch {
        return null;
      }
    },
    ['home-rows', buyer, ...ids],
    { tags: [LISTINGS_TAG], revalidate: 3600 },
  );
  return run();
}

export async function cachedComparables(listingId: string): Promise<Comparable[] | null> {
  const run = unstable_cache(
    async () => {
      try {
        const [home] = await homeRows(getWebDb(), [listingId], 'home');
        return home ? await comparables(getWebDb(), home) : [];
      } catch {
        return null;
      }
    },
    ['comparables', listingId],
    { tags: [LISTINGS_TAG], revalidate: 3600 },
  );
  return run();
}

/**
 * Discovery AI's Similar homes for one public listing (ADR 0080, C7 decision 1): the listing's own details, nothing
 * about the visitor, so one cached list serves everyone. Null when it could not be read; [] when there is none.
 */
export async function cachedSimilarHomes(listingId: string): Promise<Suggestion[] | null> {
  const run = unstable_cache(
    async () => {
      try {
        return (await similarHomes(getWebDb(), listingId))?.homes ?? [];
      } catch {
        return null;
      }
    },
    ['similar-homes', listingId],
    { tags: [LISTINGS_TAG], revalidate: 3600 },
  );
  return run();
}

/** Immersive (ADR 0080, C9): a public listing's floorplans, video and tour links. Null when they could not be read. */
export async function cachedListingExtras(listingId: string): Promise<ListingExtras | null> {
  const run = unstable_cache(
    async () => {
      try {
        return await listingExtras(getWebDb(), listingId);
      } catch {
        return null;
      }
    },
    ['listing-extras', listingId],
    { tags: [LISTINGS_TAG, `listing:${listingId}`], revalidate: 3600 },
  );
  return run();
}

/**
 * Property Development (ADR 0080, C9 decisions 4, 7): the panel for a PUBLIC property — the caller has shown it is.
 * `listingId` on a listing's page (its own ad's land size), null on /property/<id> (the newest ad's, as that page shows).
 * Two caches, because they go stale differently. The subject (state, map point, the ad's land size) is ours: an hour
 * under the listings tag, so an edited ad clears it. The zone is the state's, kept 30 days per state and point
 * (decision 4) — a moved pin is a new key, so a new lookup. An "unavailable" answer is thrown out of the cache rather
 * than kept for a month. Null when our own database could not be read.
 */
export async function cachedLandAndZoning(propertyId: string, listingId: string | null): Promise<LandAndZoning | null> {
  let subject: ZoningSubject | null;
  try {
    subject = await unstable_cache(() => zoningSubject(getWebDb(), propertyId, listingId), ['zoning-subject', propertyId, listingId ?? '-'], { tags: [LISTINGS_TAG], revalidate: 3600 })();
  } catch {
    return null;
  }
  if (!subject) return null;
  const { state, at } = subject;
  let zoning: ZoningAnswer;
  try {
    zoning = await unstable_cache(
      async () => {
        const z = await zoningAt(getWebDb(), state, at);
        if (z.status === 'unavailable') throw new Error('zoning unavailable');
        return z;
      },
      ['zoning-at', state, at ? `${at.lat},${at.lng}` : '-'],
      { tags: ['zoning'], revalidate: 30 * 24 * 3600 },
    )();
  } catch {
    zoning = { status: 'unavailable' };
  }
  return landAndZoning(subject, zoning);
}

/**
 * Visual Search (ADR 0080, C9 decisions 9–11): one ask's results, an hour under the listings tag — a listing going off
 * the market clears it — so the same words cost one query embedding an hour, not one per visitor. "unavailable" (no
 * key, Voyage down, the database down) is thrown out of the cache rather than kept.
 */
export async function cachedLook(ask: LookAsk): Promise<LookResult> {
  try {
    return await unstable_cache(
      async () => {
        const out = await homesThatLookLike(getWebDb(), ask, { embedder: imageEmbedderFromEnv(getWebDb()) });
        if (out.status === 'unavailable') throw new Error('visual search unavailable');
        return out;
      },
      ['look', JSON.stringify(ask)],
      { tags: [LISTINGS_TAG], revalidate: 3600 },
    )();
  } catch {
    return { status: 'unavailable' };
  }
}

/** The guide's research reader: the same records, thrown on failure so the guide says the database could not be reached. */
export async function cachedResearchData(ask: ResearchAsk) {
  const key = ask.kind === 'suburb' ? [ask.state.toUpperCase(), ask.suburb.toLowerCase()] : ask.kind === 'compare' ? [ask.buyer, ...ask.listingIds] : [ask.listingId];
  const run = unstable_cache(async () => researchData(getWebDb(), ask), ['research-data', ask.kind, ...key], { tags: [LISTINGS_TAG], revalidate: 3600 });
  return run();
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
 * What has recently sold in an area, for the guide.
 *
 * Tagged with the global listings tag: recording a sale changes this answer,
 * and the console always clears that tag when it does. 300 seconds rather than
 * the search's 30 — a completed sale does not change, so the only thing a
 * shorter window buys is a newly recorded one appearing sooner, and five
 * minutes is soon enough for a market question.
 *
 * `since` is part of the key as an ISO day, not a timestamp. The tool computes
 * it from the clock, so a raw Date would make every single call a cache miss
 * while still describing the same window.
 */
function salesKey(query: RecentSalesQuery): string[] {
  return [
    query.suburb?.toLowerCase() ?? '',
    query.state ?? '',
    query.near
      ? `${query.near.lat.toFixed(4)},${query.near.lng.toFixed(4)},${query.near.radiusKm}`
      : '',
    query.since ? query.since.toISOString().slice(0, 10) : '',
    String(query.bedrooms ?? ''),
    query.propertyType ?? '',
    query.sort ?? '',
    String(query.limit ?? ''),
    String(query.offset ?? ''),
  ];
}

/** A page of sales with its total, for /sold. Same read, same cache rules. */
export async function cachedRecentSalesPage(
  query: RecentSalesQuery,
): Promise<RecentSalesPage> {
  const run = unstable_cache(
    async () => {
      try {
        return await recentSalesPage(getWebDb(), query);
      } catch {
        return { rows: [], total: 0 };
      }
    },
    ['recent-sales-page', ...salesKey(query)],
    { tags: [LISTINGS_TAG], revalidate: 300 },
  );
  const page = await run();
  return {
    ...page,
    rows: page.rows.map((r) => ({ ...r, soldDate: reviveDate(r.soldDate) as Date })),
  };
}

export async function cachedRecentSales(query: RecentSalesQuery): Promise<RecentSalesPage> {
  const run = unstable_cache(
    async () => {
      try {
        // The paged form, so the guide's panel can say "View all N sold" with a
        // real N. `recentSales` alone would have made that figure a guess.
        return await recentSalesPage(getWebDb(), query);
      } catch {
        return { rows: [], total: 0 };
      }
    },
    ['recent-sales', ...salesKey(query)],
    { tags: [LISTINGS_TAG], revalidate: 300 },
  );
  const page = await run();
  // unstable_cache JSON round-trips, so soldDate comes back an ISO string
  // while the type still says Date.
  return {
    ...page,
    rows: page.rows.map((r) => ({ ...r, soldDate: reviveDate(r.soldDate) as Date })),
  };
}

/**
 * The property behind an off-market page.
 *
 * Tagged with the global listings tag and NOT `property:<id>`, for the same
 * reason `cachedTimeline` is: what makes this page exist or stop existing is a
 * listing's status changing, and the listing that changes need not be one this
 * page has ever named. Recording a sale is exactly that — the moment
 * /listing/<id> starts 404ing and this page starts answering — and
 * `revalidateWeb` always clears the global tag, so one console action covers
 * both sides of the swap.
 *
 * `null` on a database failure, like `cachedListing`, so a blip renders a 404
 * rather than a 500. It also means a blip cannot accidentally publish the
 * history: the gate failing closed is the safe direction here.
 */
export async function cachedOffMarketProperty(
  propertyId: string,
): Promise<OffMarketProperty | null> {
  const run = unstable_cache(
    async () => {
      try {
        return await getOffMarketProperty(getWebDb(), propertyId);
      } catch {
        return null;
      }
    },
    ['off-market-property', propertyId],
    { tags: [LISTINGS_TAG], revalidate: 60 },
  );
  // No Date fields on this shape, so nothing to revive.
  return await run();
}

/**
 * The live listing at an address, for `/property/<id>` to hand off to once the
 * address is re-listed. Same tag and same reasoning as `cachedOffMarketProperty`
 * — the two flip together when a listing goes live — and null on a failure,
 * which leaves the page a 404 rather than a 500.
 */
export async function cachedLiveListingId(propertyId: string): Promise<string | null> {
  const run = unstable_cache(
    async () => {
      try {
        return await liveListingIdForProperty(getWebDb(), propertyId);
      } catch {
        return null;
      }
    },
    ['live-listing-for-property', propertyId],
    { tags: [LISTINGS_TAG], revalidate: 60 },
  );
  return await run();
}

/**
 * Where an old listing URL goes once its ad is no longer live. Same tag as the
 * rest of the swap; null on a failure (a malformed id included) so the page
 * falls back to its 404 rather than a 500.
 */
export async function cachedFormerListingDestination(listingId: string): Promise<string | null> {
  const run = unstable_cache(
    async () => {
      try {
        return await formerListingDestination(getWebDb(), listingId);
      } catch {
        return null;
      }
    },
    ['former-listing-destination', listingId],
    { tags: [LISTINGS_TAG], revalidate: 60 },
  );
  return await run();
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
