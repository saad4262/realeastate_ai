import type { Db } from '@repo/db';
import type { ResolvedPlace } from '@repo/core/geo/schema';
import type {
  NearbyMarket,
  NearbyMarketQuery,
  PublicListing,
  PublicListingSummary,
  PublicSearchQuery,
  RecentSalesPage,
  RecentSalesQuery,
} from '@repo/core/listings';
import type { ResultsEvent, SalesEvent } from '../schemas/chat-events';

/**
 * What a tool needs to do its job.
 *
 * `resolvePlace` and `search` are injected rather than imported. apps/web wraps
 * both in unstable_cache, and unstable_cache is a Next API — importing it into
 * @repo/ai would make this package depend on the framework it happens to be
 * called from today. The pipeline takes the functions; the app decides whether
 * they are cached.
 */
export type ToolContext = {
  db: Db;
  resolvePlace: (query: string) => Promise<ResolvedPlace | null>;
  search: (query: PublicSearchQuery) => Promise<PublicListingSummary[]>;
  getListing: (id: string) => Promise<PublicListing | null>;
  /**
   * "Cheapest near here", ranked by Postgres.
   *
   * Injected like the other two rather than run off `db` directly, for the
   * reason at the top of this file: apps/web wraps every read in
   * unstable_cache, and which reads are cached is the app's decision, not this
   * package's. It was a direct `ctx.db` call for one commit and that was the
   * only read on this route that went to the database region every time.
   */
  nearbyMarket: (query: NearbyMarketQuery) => Promise<NearbyMarket>;
  /**
   * What has recently sold in an area.
   *
   * A separate read from `search`, not a flag on it. `search` answers what a
   * visitor can buy today and is the one place `PUBLIC_STATUS` is applied;
   * this answers what the market did, from listings that were public while
   * they ran. Injected for the same reason as the others — the app decides
   * what is cached.
   */
  recentSales: (query: RecentSalesQuery) => Promise<RecentSalesPage>;
  /**
   * Places resolved during this turn, keyed by lowercased suburb.
   *
   * The model calls resolve_location and then search_listings with a suburb
   * name. The coordinates never travel through the model — they are looked up
   * here instead, which is why the search tool's schema has no lat/lng field
   * for a forged one to arrive in.
   */
  places: Map<string, ResolvedPlace>;
  /**
   * The query the last `search_listings` actually ran, this turn.
   *
   * Written by the search tool and read by `draft_schedule`, so a schedule
   * freezes the search that returned rows rather than a search the model
   * described afterwards. The model never supplies it and has no field to
   * supply it in — same reasoning as `places` above, where coordinates are
   * kept out of the model's reach.
   */
  lastSearch?: PublicSearchQuery;
  /**
   * Everything the scheduling tools need — or WHY they cannot run.
   *
   * This was an optional object, and absent meant two entirely different
   * things: the visitor is not signed in, or the server has no signing
   * secret. The tools could not tell them apart, so an anonymous visitor
   * asking to be emailed daily was told "scheduling isn't available at the
   * moment" — which is false, unactionable, and reads as a broken product
   * when the fix was a ten-second sign-in.
   *
   * Same distinction packages/smoke already draws between "you chose not to
   * spend money" and "you asked to and cannot". Two situations that must
   * not read the same.
   */
  scheduling: SchedulingContext;
};

export type SchedulingContext =
  | {
      state: 'ready';
      draftSecret: string;
      listSchedules: () => Promise<
        { id: string; name: string; description: string; status: string }[]
      >;
      pauseSchedule: (id: string) => Promise<boolean>;
    }
  /** No session. The visitor can fix this, and should be told how. */
  | { state: 'signed_out' }
  /** No ALERT_UNSUBSCRIBE_SECRET. Nobody in the conversation can fix it. */
  | { state: 'unconfigured' };

/**
 * What a tool call established, for the chips under the answer.
 *
 * Deliberately NOT part of `result`. `result` is what the model reads; this
 * is what the suggestion builder reads, and the two must not be the same
 * object. The model is never shown these facts and has no way to write one,
 * so a chip quoting a price is quoting Postgres by construction rather than
 * by the model behaving itself — the same reasoning that keeps coordinates
 * out of the tool schemas above.
 *
 * Merged across the calls in one turn; a later call of the same tool wins,
 * because the visitor is looking at the later result.
 */
export type TurnFacts = {
  /** A `search_listings` call, and what it found. */
  search?: {
    matched: number;
    suburb?: string;
    /** Present only when the search actually ran with a radius. */
    radiusKm?: number;
  };
  /**
   * `cheapest_near`'s per-suburb breakdown, cheapest first.
   *
   * `cheapest` is already a formatted label from `priceLabel` — the same
   * string the cards show. Never a raw number, so nothing downstream is even
   * able to do arithmetic on it.
   */
  nearby?: { suburb: string; cheapest: string }[];
  /** The suburb the breakdown was measured from, so it is not offered back. */
  nearbyCentre?: string;
  /** Listings inside the radius carrying no price, and so ranked nowhere. */
  unpriced?: number;
};

/** What one tool call produces: a block for the model, and maybe a frame for the UI. */
export type ToolOutcome = {
  /** JSON the model reads. Every figure in it was computed by Postgres. */
  result: unknown;
  isError?: boolean;
  /** Listings for the panel, when this call produced any. */
  resultsFrame?: Omit<ResultsEvent, 'type' | 'toolUseId'>;
  /**
   * Completed sales for the panel. A separate frame from `resultsFrame` because
   * a sale is not a listing — it cannot be enquired about or bought, and one
   * set of cards for both would undo the rules that keep the guide from
   * offering an inspection on a house somebody already owns.
   */
  salesFrame?: Omit<SalesEvent, 'type' | 'toolUseId'>;
  /** Filters this call established, merged into the running slot state. */
  slots?: PublicSearchQuery;
  /** What this call establishes for the chips. Never shown to the model. */
  facts?: TurnFacts;
  /** Something short for the "running" indicator. */
  label?: string;
  /**
   * A schedule awaiting confirmation. Becomes a card in the chat.
   *
   * Carried on the outcome rather than written anywhere: nothing exists
   * until the visitor presses Accept and the signed token comes back.
   */
  scheduleDraft?: {
    token: string;
    search: string;
    cadence: string;
    searchPath: string;
  };
};

export function placeKey(suburb: string, state?: string): string {
  return [suburb.trim().toLowerCase(), state?.trim().toLowerCase()].filter(Boolean).join('|');
}
