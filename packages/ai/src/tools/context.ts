import type { Db } from '@repo/db';
import type { ResolvedPlace } from '@repo/core/geo/schema';
import type {
  PublicListing,
  PublicListingSummary,
  PublicSearchQuery,
} from '@repo/core/listings';
import type { ResultsEvent } from '../schemas/chat-events';

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
   * Places resolved during this turn, keyed by lowercased suburb.
   *
   * The model calls resolve_location and then search_listings with a suburb
   * name. The coordinates never travel through the model — they are looked up
   * here instead, which is why the search tool's schema has no lat/lng field
   * for a forged one to arrive in.
   */
  places: Map<string, ResolvedPlace>;
};

/** What one tool call produces: a block for the model, and maybe a frame for the UI. */
export type ToolOutcome = {
  /** JSON the model reads. Every figure in it was computed by Postgres. */
  result: unknown;
  isError?: boolean;
  /** Listings for the panel, when this call produced any. */
  resultsFrame?: Omit<ResultsEvent, 'type' | 'toolUseId'>;
  /** Filters this call established, merged into the running slot state. */
  slots?: PublicSearchQuery;
  /** Something short for the "running" indicator. */
  label?: string;
};

export function placeKey(suburb: string, state?: string): string {
  return [suburb.trim().toLowerCase(), state?.trim().toLowerCase()].filter(Boolean).join('|');
}
