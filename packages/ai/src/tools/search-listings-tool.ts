import { z } from 'zod';
import { nearSchema, type Near, type ResolvedPlace } from '@repo/core/geo/schema';
import {
  auStateSchema,
  discountPlaceWords,
  distanceLabel,
  priceBoundLabel,
  priceLabel,
  searchQueryToPath,
  specLine,
  SORT_OPTIONS,
  type PublicListingSummary,
  type PublicSearchQuery,
} from '@repo/core/listings';
import { placeKey, type ToolContext, type ToolOutcome, type TurnFacts } from './context';

/**
 * The search, and the two gates that make the guide ask questions.
 *
 * GATE 1 lives in the schema: channel and suburb are required. A model that
 * does not yet know whether the visitor is buying or renting cannot form the
 * call at all. That is enforced by the API rather than by a prompt rule the
 * model may or may not follow.
 *
 * GATE 2 lives in what comes back: a query that matches too much with no
 * budget and no bedroom count returns NO listings, only a count and a note
 * naming what is missing. The model has nothing to show, so its only coherent
 * next move is the question. A model cannot ignore data it was never given.
 *
 * Note the fields that do not exist here: lat, lng, status, limit. The radius
 * centre is resolved server-side, the public site only ever shows live
 * listings, and the page size is ours. Making the wrong thing unsayable beats
 * validating it away.
 */
export const searchListingsInput = z
  .object({
    channel: z
      .enum(['sale', 'rent'])
      .describe('REQUIRED. Whether the visitor is buying or renting. Ask if you do not know.'),
    suburb: z
      .string()
      .trim()
      .min(2)
      .max(60)
      .describe('REQUIRED. The suburb, as resolve_location returned it.'),
    /**
     * The platform's own list, not a hand-written duplicate (#8). Australian
     * abbreviations are two or three letters — NSW and VIC are not the same
     * length, and a length(2) rule silently refused every search in New South
     * Wales, Queensland, Tasmania and the ACT.
     */
    state: auStateSchema.optional().describe('State abbreviation, e.g. VIC or NSW. Disambiguates a repeated suburb name.'),
    postcode: z.string().trim().regex(/^\d{4}$/).optional(),
    radiusKm: z
      .number()
      .min(0.5)
      .max(50)
      .optional()
      .describe('Only when the visitor asked to include the surrounding area. Omit for the suburb itself.'),
    bedrooms: z.number().int().min(0).max(10).optional().describe('Minimum bedrooms.'),
    bathrooms: z.number().int().min(0).max(10).optional().describe('Minimum bathrooms.'),
    carSpaces: z.number().int().min(0).max(10).optional().describe('Minimum car spaces.'),
    propertyType: z
      .string()
      .trim()
      .max(40)
      .optional()
      .describe(
        'Only when the visitor contrasted types (Unit, Apartment, Townhouse, Land vs House). Never for the everyday word "house" or "home" alone — omit the field.',
      ),
    landFrom: z.number().int().min(0).max(100_000).optional().describe('Minimum land size in square metres.'),
    priceFrom: z.number().int().min(0).max(50_000_000).optional().describe('For rent this is dollars per week.'),
    /**
     * min(1), not min(0). A ceiling of zero is never something a visitor asked
     * for — it matches nothing, and it reads on screen as "under $0". The model
     * filled it in once on a message that mentioned no budget at all, and the
     * search came back empty for a reason nobody could see.
     */
    priceTo: z.number().int().min(1).max(50_000_000).optional().describe('The budget ceiling. For rent, dollars per week.'),
    sort: z.enum(SORT_OPTIONS).optional(),
    /**
     * A plain word or two, and nothing that looks like markup.
     *
     * This is the one free-text field that reaches a LIKE over four columns,
     * and a model has already put a stray fragment of its own scaffolding in
     * it once — which silently ANDed the search down to nothing. A keyword
     * with a bracket in it is not a keyword.
     */
    keywords: z
      .string()
      .trim()
      .max(60)
      .refine((v) => !/[<>{}|]/.test(v), 'not a keyword')
      .optional()
      .describe('A feature the visitor mentioned, e.g. "pool". Never a suburb name.'),
  })
  /**
   * Strip unknown keys rather than refuse the call.
   *
   * A model that invents `lat`, `status` or `limit` should lose the field, not
   * the turn — there are only three tool rounds, and spending one on a
   * rejection the visitor waits through helps nobody. Stripping is no weaker
   * here: every field that could do damage is one the server controls anyway.
   * The client-facing request schema is .strict(), because there an unknown
   * key means something is wrong and refusing costs nothing.
   */
  .strip();

export type SearchListingsInput = z.infer<typeof searchListingsInput>;

/**
 * Above this many matches with no budget and no bedroom count, the guide must
 * ask rather than dump. Twenty-five is roughly a screen of cards — past it the
 * visitor is scrolling, not choosing.
 */
const TOO_BROAD_ABOVE = 25;

/** What the panel beside the conversation shows. */
const PANEL_LIMIT = 24;

/**
 * What the MODEL sees. Far fewer than the panel on purpose: it keeps the prompt
 * small, and it stops the model narrating a list the visitor is already
 * looking at.
 */
const MODEL_LIMIT = 8;

/**
 * Counting without a second query.
 *
 * Fetch one more than we could ever need and measure the pile. searchPublicListings
 * is one SQL statement, guarded by query-count.test.ts, and adding a count(*)
 * call site would be a second place for the filter logic to live and drift.
 * Sixty-one rows over a GiST-indexed query is free.
 */
const COUNT_LIMIT = 61;
const COUNT_CAP = 60;

function isRental(channel: 'sale' | 'rent'): boolean {
  return channel === 'rent';
}

/** A row the model reads: strings it can only copy, never numbers it could do arithmetic on. */
function compactRow(listing: PublicListingSummary) {
  return {
    id: listing.id,
    address: listing.address,
    suburb: listing.suburb,
    channel: listing.channel,
    price: priceLabel(listing),
    specs: specLine(listing) || null,
    distance: distanceLabel(listing.distanceKm),
    agency: listing.agencyName,
  };
}

/** The filters, in words, for a note the model can repeat verbatim. */
function describeFilters(query: SearchListingsInput): string {
  const rental = isRental(query.channel);
  const parts: string[] = [query.channel === 'sale' ? 'for sale' : 'for rent'];

  parts.push(
    query.radiusKm
      ? `within ${query.radiusKm} km of ${query.suburb}`
      : `in ${query.suburb}${query.state ? ` ${query.state}` : ''}`,
  );

  if (query.bedrooms !== undefined) parts.push(`${query.bedrooms}+ bed`);
  if (query.bathrooms !== undefined) parts.push(`${query.bathrooms}+ bath`);
  if (query.carSpaces !== undefined) parts.push(`${query.carSpaces}+ car`);
  if (query.propertyType) parts.push(query.propertyType);
  if (query.landFrom !== undefined) parts.push(`${query.landFrom} m² or more`);
  if (query.priceFrom !== undefined) parts.push(`from ${priceBoundLabel(query.priceFrom, rental)}`);
  if (query.priceTo !== undefined) parts.push(`under ${priceBoundLabel(query.priceTo, rental)}`);
  if (query.keywords) parts.push(`"${query.keywords}"`);

  return parts.join(' · ');
}

/**
 * Where to centre the radius.
 *
 * Only ever from a place the server resolved. The model asked for a radius
 * around a suburb name; it never handed us a point, and it could not have.
 */
async function resolveNear(
  input: SearchListingsInput,
  ctx: ToolContext,
): Promise<{ near?: Near; place?: ResolvedPlace }> {
  if (input.radiusKm === undefined) return {};

  const key = placeKey(input.suburb, input.state);
  const cached = ctx.places.get(key) ?? ctx.places.get(placeKey(input.suburb));

  const place =
    cached ??
    (await ctx.resolvePlace(
      [input.suburb, input.state, input.postcode, 'Australia'].filter(Boolean).join(', '),
    ));

  if (!place) return {};
  ctx.places.set(placeKey(input.suburb, input.state), place);

  const parsed = nearSchema.safeParse({
    lat: place.latitude,
    lng: place.longitude,
    radiusKm: input.radiusKm,
  });

  // A radius we cannot centre is dropped, not guessed at. The suburb match
  // still runs, so the visitor gets Pakenham rather than nothing.
  return parsed.success ? { near: parsed.data, place } : { place };
}

export function toPublicSearchQuery(input: SearchListingsInput, near?: Near): PublicSearchQuery {
  return {
    text: discountPlaceWords(input.keywords, input),
    channel: input.channel,
    suburb: input.suburb,
    state: input.state,
    postcode: input.postcode,
    bedrooms: input.bedrooms,
    bathrooms: input.bathrooms,
    carSpaces: input.carSpaces,
    propertyType: input.propertyType,
    landFrom: input.landFrom,
    priceFrom: input.priceFrom,
    priceTo: input.priceTo,
    sort: input.sort,
    near,
  };
}

export async function runSearchListings(
  input: SearchListingsInput,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const { near } = await resolveNear(input, ctx);
  const query = toPublicSearchQuery(input, near);
  const filters = describeFilters(input);
  const label = input.radiusKm
    ? `Searching within ${input.radiusKm} km of ${input.suburb}…`
    : `Searching ${input.suburb}…`;

  const rows = await ctx.search({ ...query, limit: COUNT_LIMIT });

  /**
   * What the chips under the answer read. Never shown to the model.
   *
   * `radiusKm` comes from `near`, not from `input.radiusKm`. The two differ
   * exactly when a radius was asked for and could not be centred — resolveNear
   * drops it rather than guessing — and reporting the input there would offer
   * "look wider" to somebody who already had, whose wider search would come
   * back just as empty.
   */
  const factsFor = (count: number): TurnFacts => ({
    search: {
      matched: count,
      suburb: input.suburb,
      ...(near ? { radiusKm: near.radiusKm } : {}),
    },
  });

  /**
   * Remember what was actually searched, for `draft_schedule`.
   *
   * Recorded here rather than reconstructed later so a schedule freezes the
   * query that ran, not one rebuilt from whatever the model said about it
   * afterwards. Set even when nothing matched: "email me if anything comes
   * up in Pakenham" is a perfectly good alert over an empty result today.
   */
  ctx.lastSearch = query;

  const capped = rows.length > COUNT_CAP;
  const matched = Math.min(rows.length, COUNT_CAP);
  const deepLink = searchQueryToPath(query);

  if (matched === 0) {
    return {
      label,
      slots: query,
      result: {
        matched: 0,
        capped: false,
        returned: 0,
        tooBroad: false,
        missing: [],
        filters,
        listings: [],
        note: `Nothing live matches ${filters}. Tell the visitor plainly and offer to relax one filter — name which one. Do not run more searches to find out which.`,
      },
      resultsFrame: { query, deepLink, matched: 0, capped: false, listings: [] },
      facts: factsFor(0),
    };
  }

  /**
   * The gate. A budget or a bedroom count is what turns a suburb into a
   * shortlist; without either, a big suburb is just a list.
   */
  const missing: string[] = [];
  if (input.priceTo === undefined) missing.push('priceTo');
  if (input.bedrooms === undefined) missing.push('bedrooms');
  const tooBroad = matched > TOO_BROAD_ABOVE && missing.length === 2;

  if (tooBroad) {
    return {
      label,
      slots: query,
      result: {
        matched,
        capped,
        returned: 0,
        tooBroad: true,
        missing,
        filters,
        listings: [],
        note: `${capped ? `${COUNT_CAP}+` : matched} live matches for ${filters} — too many to be useful. Ask the visitor for a budget and how many bedrooms they need before searching again. No listings were returned.`,
      },
      // The panel stays empty too, so the screen agrees with the answer.
      resultsFrame: { query, deepLink, matched, capped, listings: [] },
      facts: factsFor(matched),
    };
  }

  const panel = rows.slice(0, PANEL_LIMIT);

  return {
    label,
    slots: query,
    result: {
      matched,
      capped,
      returned: Math.min(rows.length, MODEL_LIMIT),
      tooBroad: false,
      missing,
      filters,
      listings: rows.slice(0, MODEL_LIMIT).map(compactRow),
      note: `The visitor can see ${panel.length} results beside the conversation. Mention two or three worth a look; do not list them all. Copy every price and distance exactly as written above.`,
    },
    resultsFrame: { query, deepLink, matched, capped, listings: panel },
    facts: factsFor(matched),
  };
}
