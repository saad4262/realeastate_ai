import { z } from 'zod';
import { SORT_OPTIONS } from '@repo/core/listings';

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
    state: z.string().trim().length(2).optional(),
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
