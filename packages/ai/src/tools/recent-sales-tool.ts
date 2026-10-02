import { z } from 'zod';
import { saleHistoryPath } from '@repo/core/listings/format';
import { nearSchema, type Near } from '@repo/core/geo/schema';
import { placeKey, type ToolContext, type ToolOutcome } from './context';

/**
 * "What has sold in Pakenham?"
 *
 * The question the guide could not answer at all. Every other tool reads the
 * LIVE market, so a visitor asking about sold homes was told the portal does
 * not have them — true of the search tools, and unhelpful when the sale data
 * is sitting in the same database.
 *
 * ## What it is allowed to see
 *
 * `status = 'sold'` only, enforced in `recentSales` in packages/core, not here.
 * That status is in `HISTORIC_STATUSES`, the list that decides what a member of
 * the public was ever allowed to see — so every row was a public advertisement
 * while it ran, with a price the agency entered and published. Drafts and
 * withdrawn ads are excluded by the same rule that keeps them off the property
 * timeline.
 *
 * ## Same discipline as the other location tools
 *
 * The model names a place and never sees a coordinate. A radius is centred here
 * from the turn's place map or the geocoder, exactly as `search_listings` does
 * it, which is why this schema has no lat/lng field for a forged one to arrive
 * in.
 */
export const recentSalesInput = z
  .object({
    suburb: z
      .string()
      .trim()
      .min(2)
      .max(80)
      .describe('The suburb to look at, as resolve_location returned it.'),
    state: z.string().trim().max(3).optional(),
    postcode: z.string().trim().max(4).optional(),
    radiusKm: z.coerce.number().min(0.5).max(50).optional(),
    /** How far back to look, in months. */
    months: z.coerce.number().int().min(1).max(120).optional(),
    bedrooms: z.coerce.number().int().min(0).max(10).optional(),
    propertyType: z.string().trim().max(40).optional(),
  })
  /** Unknown keys stripped, not refused — see search-listings-tool.ts. */
  .strip();

export type RecentSalesInput = z.infer<typeof recentSalesInput>;

/**
 * How many to hand the model.
 *
 * Enough to describe a market, few enough that the answer stays a paragraph
 * rather than a list the visitor has to scroll. The same reasoning as the
 * search tool's own cap.
 */
const SHOW = 8;

/** Sales older than this are a different market, not recent news. */
const DEFAULT_MONTHS = 24;

const AUD = new Intl.NumberFormat('en-AU', {
  style: 'currency',
  currency: 'AUD',
  maximumFractionDigits: 0,
});

/**
 * Australian date, spelled out.
 *
 * `new Date()` is never used here and never reaches a prompt (#5) — this
 * formats a date the database returned.
 */
const SOLD_ON = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

/**
 * The browse page for this same question.
 *
 * Only the fields a visitor would recognise in a URL: suburb, radius, period.
 * The bedroom and type filters are deliberately left off — a link that carried
 * every filter would be unreadable, and /sold applies its own defaults.
 */
function soldSearchPath(input: RecentSalesInput, months: number): string {
  const params = new URLSearchParams({ suburb: input.suburb });
  if (input.state) params.set('state', input.state);
  if (input.radiusKm !== undefined) params.set('radiusKm', String(input.radiusKm));
  if (months !== DEFAULT_MONTHS) params.set('months', String(months));
  return `/sold?${params.toString()}`;
}

async function resolveNear(
  input: RecentSalesInput,
  ctx: ToolContext,
): Promise<Near | undefined> {
  if (input.radiusKm === undefined) return undefined;

  const cached =
    ctx.places.get(placeKey(input.suburb, input.state)) ?? ctx.places.get(placeKey(input.suburb));

  const place =
    cached ??
    (await ctx.resolvePlace(
      [input.suburb, input.state, input.postcode, 'Australia'].filter(Boolean).join(', '),
    ));

  if (!place) return undefined;
  ctx.places.set(placeKey(input.suburb, input.state), place);

  const parsed = nearSchema.safeParse({
    lat: place.latitude,
    lng: place.longitude,
    radiusKm: input.radiusKm,
  });

  // A radius that cannot be centred is dropped, not guessed at — the suburb
  // match still runs, so the visitor gets Pakenham rather than nothing.
  return parsed.success ? parsed.data : undefined;
}

export async function runRecentSales(
  input: RecentSalesInput,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const near = await resolveNear(input, ctx);
  const months = input.months ?? DEFAULT_MONTHS;

  /**
   * The cut-off, computed from the clock at call time.
   *
   * Safe where `new Date()` in a system prompt is not (#5): this is a tool
   * INPUT computed per call, never part of the cached prefix, so it cannot
   * invalidate a cache the way a date in the prompt would.
   */
  const since = new Date();
  since.setMonth(since.getMonth() - months);

  const page = await ctx.recentSales({
    suburb: input.suburb,
    ...(input.state ? { state: input.state } : {}),
    ...(near ? { near } : {}),
    since,
    ...(input.bedrooms !== undefined ? { bedrooms: input.bedrooms } : {}),
    ...(input.propertyType ? { propertyType: input.propertyType } : {}),
    limit: SHOW,
  });
  const sales = page.rows;

  const where = near ? `within ${near.radiusKm} km of ${input.suburb}` : input.suburb;
  const label = `Looking at recent sales in ${input.suburb}…`;

  if (sales.length === 0) {
    return {
      label,
      result: {
        found: 0,
        searched: where,
        months,
        note: `No recorded sales ${where} in the last ${months} months. This portal only knows the sales its own agencies recorded, so a quiet result here does not mean the suburb is quiet. Say that plainly rather than implying nothing sold.`,
      },
    };
  }

  return {
    label,
    /**
     * The cards the panel draws.
     *
     * Every string here was formatted by this server from what Postgres
     * returned, and the panel renders these rather than the guide's prose —
     * which is what keeps #4 true on screen whatever the guide says above it.
     *
     * `historyPath` comes from `saleHistoryPath`, the one rule /sold uses too:
     * a re-listed address links to its live listing, which shows the history.
     */
    salesFrame: {
      searched: where,
      months,
      total: page.total,
      /**
       * Where the full list lives. Built HERE, by the server, from the same
       * inputs the query used — the guide never writes a link, and the panel
       * never invents one.
       */
      searchPath: soldSearchPath(input, months),
      sales: sales.map((s) => ({
        listingId: s.listingId,
        propertyId: s.propertyId,
        address: s.address,
        suburb: s.suburb,
        state: s.state,
        postcode: s.postcode,
        price: AUD.format(s.soldPrice),
        soldOn: SOLD_ON.format(s.soldDate),
        agencyName: s.agencyName,
        bedrooms: s.bedrooms,
        bathrooms: s.bathrooms,
        carSpaces: s.carSpaces,
        distance: s.distanceKm === null ? null : `${s.distanceKm.toFixed(1)} km`,
        mainPhotoKey: s.mainPhotoKey,
        priceDisplay: s.priceDisplay,
        latitude: s.latitude,
        longitude: s.longitude,
        historyPath: saleHistoryPath(s),
        forSaleNow: s.liveListingId !== null,
      })),
    },
    result: {
      found: sales.length,
      searched: where,
      months,
      /**
       * Every figure formatted by Postgres's answer and this formatter — never
       * derived, averaged or compared (#4). The model may copy these strings;
       * it may not do arithmetic on them, and nothing here hands it the raw
       * numbers to try.
       */
      sales: sales.map((s) => ({
        address: s.address,
        soldFor: AUD.format(s.soldPrice),
        soldOn: SOLD_ON.format(s.soldDate),
        agency: s.agencyName,
        bedrooms: s.bedrooms,
        bathrooms: s.bathrooms,
        carSpaces: s.carSpaces,
        ...(s.distanceKm !== null ? { distance: `${s.distanceKm.toFixed(1)} km` } : {}),
        /**
         * Deliberately NO path here any more.
         *
         * The panel beside the conversation carries the link now, and the guide
         * is told to point at it. Handing the model a URL as well produced the
         * worst of both: the prompt forbids writing links out, so it refused to
         * give one — and then invented that the sale was visible in a results
         * panel that was empty, because nothing emitted a frame.
         *
         * "On the market again" stays, because that is a fact about the sale
         * the guide should be able to say in prose.
         */
        ...(s.onMarketNow ? { note: 'This address is on the market again right now.' } : {}),
      })),
      distanceIs: near ? 'straight-line distance, not drive time' : undefined,
      note: 'These are completed sales, not listings the visitor can buy. Do not offer to arrange an inspection for one. The visitor can see these beside the conversation, each with a link to that address\'s full history — point them there rather than writing out an address list. If they want something they can buy, run search_listings.',
    },
    /**
     * Slots, so the sidebar and the deep link follow the conversation — the
     * suburb only. Deliberately no channel: the visitor asking what sold has
     * not said they are buying, and guessing `sale` here would fill in a filter
     * they never chose.
     */
    slots: {
      suburb: input.suburb,
      ...(input.state ? { state: input.state } : {}),
    },
  };
}
