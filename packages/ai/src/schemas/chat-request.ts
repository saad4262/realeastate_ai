import { z } from 'zod';
import { auStateSchema, SORT_OPTIONS } from '@repo/core/listings';

/**
 * What the browser is allowed to send, and nothing else.
 *
 * The conversation is not stored, so the client carries it. That makes every
 * field here untrusted input from an anonymous visitor on a public page.
 *
 * The important omission: there is no way to send a tool result. A tool result
 * is the only source of a price (#4), so a client that could forge one could
 * forge a price. The server replays prior turns as plain text plus a
 * server-authored summary line it wrote itself, and only the current turn uses
 * real tool blocks — because that loop is live and the server is running it.
 */

/** A search the server ran on an earlier turn. Cited back, never replayed as truth. */
export const searchCitationSchema = z
  .object({
    query: z.object({}).passthrough(),
    matched: z.number().int().min(0).max(10_000),
    shown: z.number().int().min(0).max(24),
  })
  .strict();

export const chatTurnSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    text: z.string().max(4000),
    searches: z.array(searchCitationSchema).max(4).optional(),
  })
  .strict();

/**
 * The requirements gathered so far.
 *
 * Advisory only. It is re-parsed and re-clamped here and then injected as a
 * hint; the authoritative filters are always the ones the server built from
 * the tool call it actually executed. A client that lies about this gets a bad
 * hint, not a bad search.
 *
 * Note what is absent: `near`, `lat`, `lng`. A radius centre is resolved
 * server-side from the suburb name, every time. That is the fix for a bug that
 * was reported twice, and the way to keep it fixed is to make the wrong thing
 * impossible to say.
 */
export const slotsSchema = z
  .object({
    channel: z.enum(['sale', 'rent']).optional(),
    suburb: z.string().trim().min(1).max(60).optional(),
    /**
     * The platform's own list, not a length rule. `length(2)` was here and it
     * rejected every follow-up turn about a VIC, NSW, QLD, TAS or ACT suburb —
     * the first message worked, the second came back 400, and the chat looked
     * like it had simply stopped working. Australian abbreviations are two OR
     * three letters. This is the second place that mistake was made; #8 exists
     * precisely so there is one list, not three.
     */
    state: auStateSchema.optional(),
    postcode: z.string().trim().regex(/^\d{4}$/).optional(),
    radiusKm: z.number().min(0.5).max(50).optional(),
    bedrooms: z.number().int().min(0).max(10).optional(),
    bathrooms: z.number().int().min(0).max(10).optional(),
    carSpaces: z.number().int().min(0).max(10).optional(),
    propertyType: z.string().trim().max(40).optional(),
    landFrom: z.number().int().min(0).max(100_000).optional(),
    priceFrom: z.number().int().min(0).max(50_000_000).optional(),
    priceTo: z.number().int().min(0).max(50_000_000).optional(),
    sort: z.enum(SORT_OPTIONS).optional(),
    keywords: z.string().trim().max(60).optional(),
  })
  .strict();

export type ChatSlots = z.infer<typeof slotsSchema>;

/**
 * What the browser may echo back after a turn.
 *
 * The live search builds a PublicSearchQuery that can carry `near` (lat/lng).
 * That shape must never leave the server as something the client will re-post
 * — slotsSchema is strict and will 400 the next message with "could not be
 * understood", which is exactly what happened when a visitor asked "which one
 * is cheapest" after a radius search. Flatten radius to a number; drop the
 * centre. The server re-resolves the centre from the suburb every time.
 */
export function toClientSlots(query: {
  channel?: string;
  suburb?: string;
  state?: string;
  postcode?: string;
  bedrooms?: number;
  bathrooms?: number;
  carSpaces?: number;
  propertyType?: string;
  landFrom?: number;
  priceFrom?: number;
  priceTo?: number;
  sort?: string;
  text?: string;
  keywords?: string;
  radiusKm?: number;
  near?: { radiusKm: number } | null;
}): ChatSlots {
  const out: ChatSlots = {};
  if (query.channel === 'sale' || query.channel === 'rent') out.channel = query.channel;
  if (query.suburb) out.suburb = query.suburb;
  if (query.state) {
    const parsed = auStateSchema.safeParse(query.state);
    if (parsed.success) out.state = parsed.data;
  }
  if (query.postcode && /^\d{4}$/.test(query.postcode)) out.postcode = query.postcode;
  const radius = query.radiusKm ?? query.near?.radiusKm;
  if (radius !== undefined && radius >= 0.5 && radius <= 50) out.radiusKm = radius;
  if (query.bedrooms !== undefined) out.bedrooms = query.bedrooms;
  if (query.bathrooms !== undefined) out.bathrooms = query.bathrooms;
  if (query.carSpaces !== undefined) out.carSpaces = query.carSpaces;
  if (query.propertyType) out.propertyType = query.propertyType;
  if (query.landFrom !== undefined) out.landFrom = query.landFrom;
  if (query.priceFrom !== undefined) out.priceFrom = query.priceFrom;
  if (query.priceTo !== undefined) out.priceTo = query.priceTo;
  if (query.sort && (SORT_OPTIONS as readonly string[]).includes(query.sort)) {
    out.sort = query.sort as ChatSlots['sort'];
  }
  const keywords = query.keywords ?? query.text;
  if (keywords) out.keywords = keywords.slice(0, 60);
  return out;
}

/**
 * The reverse: the brief the client carries, back as a search query.
 *
 * The conversation is not stored, so the client round-trips the slots and
 * sends them with every turn. That is what lets `draft_schedule` work on
 * the turn AFTER a search: the tool context is built per HTTP request, so
 * `lastSearch` is empty on a fresh request, and without this the model has
 * to re-run the search before it can schedule it — which it did, and ran
 * out of tool rounds mid-sentence.
 *
 * ## What is and is not trusted here
 *
 * These slots come from a browser, and this does not pretend otherwise:
 * every field has already been through `slotsSchema`, and the result is
 * used only to PROPOSE a schedule on a card the person then confirms. The
 * card is written by the server from the path this produces, and
 * `createSchedule` parses that path again with the same vocabulary
 * `/search` applies to any shared link. So the trust level is exactly that
 * of a URL somebody pasted — which is the level `/search` already works at.
 *
 * It is never used to answer a question about listings. Only a real
 * `search_listings` call does that, and only its result carries prices.
 */
export function slotsToQuery(slots: ChatSlots): {
  channel?: 'sale' | 'rent';
  suburb?: string;
  state?: string;
  postcode?: string;
  bedrooms?: number;
  bathrooms?: number;
  carSpaces?: number;
  propertyType?: string;
  landFrom?: number;
  priceFrom?: number;
  priceTo?: number;
  text?: string;
  sort?: string;
  near?: { lat: number; lng: number; radiusKm: number };
} | null {
  // Without both of these there is no search to schedule — the same pair
  // `search_listings` requires before it will run at all.
  if (!slots.channel || !slots.suburb) return null;

  return {
    channel: slots.channel,
    suburb: slots.suburb,
    ...(slots.state ? { state: slots.state } : {}),
    ...(slots.postcode ? { postcode: slots.postcode } : {}),
    ...(slots.bedrooms !== undefined ? { bedrooms: slots.bedrooms } : {}),
    ...(slots.bathrooms !== undefined ? { bathrooms: slots.bathrooms } : {}),
    ...(slots.carSpaces !== undefined ? { carSpaces: slots.carSpaces } : {}),
    ...(slots.propertyType ? { propertyType: slots.propertyType } : {}),
    ...(slots.landFrom !== undefined ? { landFrom: slots.landFrom } : {}),
    ...(slots.priceFrom !== undefined ? { priceFrom: slots.priceFrom } : {}),
    ...(slots.priceTo !== undefined ? { priceTo: slots.priceTo } : {}),
    ...(slots.keywords ? { text: slots.keywords } : {}),
    ...(slots.sort ? { sort: slots.sort } : {}),
    /**
     * A radius with no centre. `searchQueryToPath` emits `radius` and
     * suppresses lat/lng whenever a suburb is named, because /search
     * re-resolves the centre itself — so a placeholder point here never
     * reaches a stored schedule, and the run resolves the real centre.
     */
    ...(slots.radiusKm !== undefined
      ? { near: { lat: 0, lng: 0, radiusKm: slots.radiusKm } }
      : {}),
  };
}

/**
 * MAX_TURNS is six exchanges. The chat is a way into the search, not a
 * correspondence; past this the client trims and the server refuses, so a
 * hand-built request cannot grow the prompt without limit.
 */
export const MAX_TURNS = 12;
export const MAX_MESSAGE_CHARS = 1000;

/**
 * Character budget for the reconstructed history.
 *
 * Characters rather than tokens on purpose: count_tokens is a network round
 * trip, and adding one to every turn of a latency-sensitive route to enforce a
 * limit that a cheap deterministic proxy already enforces is the wrong trade.
 */
export const MAX_HISTORY_CHARS = 24_000;

export const chatRequestSchema = z
  .object({
    message: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
    turns: z.array(chatTurnSchema).max(MAX_TURNS).default([]),
    slots: slotsSchema.optional(),
  })
  .strict();

export type ChatRequest = z.infer<typeof chatRequestSchema>;
export type ChatTurn = z.infer<typeof chatTurnSchema>;
