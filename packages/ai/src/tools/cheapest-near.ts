import { z } from 'zod';
import { priceLabel } from '@repo/core/listings/format';
import { nearSchema } from '@repo/core/geo/schema';
import { placeKey, type ToolContext, type ToolOutcome } from './context';

/**
 * "My office is in Berwick — where is the cheapest place near it?"
 *
 * The question `search_listings` could not answer. It sorts by price OR by
 * distance, never both, and the model is forbidden from doing the arithmetic
 * itself — non-negotiable #4, every number comes from SQL. So the guide could
 * show the cheapest anywhere in one suburb, or the nearest at any price, and
 * then had to hand-wave the trade-off in prose.
 *
 * This hands it two ranked answers computed by Postgres: the cheapest listings
 * inside the radius each with its own distance, and a per-suburb breakdown.
 * The second is the one that actually answers "where" — a visitor asking this
 * wants to know which direction to look in, not a single address.
 *
 * ## Same discipline as the other location tool
 *
 * The model names a place and never sees a coordinate. The point is resolved
 * here, from the turn's place map or the geocoder, exactly as
 * `search_listings` does it — which is why this schema has no lat/lng field
 * for a forged one to arrive in.
 */
export const cheapestNearInput = z
  .object({
    place: z
      .string()
      .trim()
      .min(2)
      .max(80)
      .describe('The place to measure from — an office, a school, a suburb, an address.'),
    channel: z.enum(['sale', 'rent']),
    radiusKm: z.coerce.number().min(0.5).max(50).optional(),
    state: z.string().trim().max(3).optional(),
    bedrooms: z.coerce.number().int().min(0).max(10).optional(),
    propertyType: z.string().trim().max(40).optional(),
  })
  /** Unknown keys stripped, not refused — see search-listings-tool.ts. */
  .strip();

export type CheapestNearInput = z.infer<typeof cheapestNearInput>;

/**
 * How wide to look when the visitor did not say.
 *
 * Twenty kilometres is a commute somebody would actually consider, and it is
 * wide enough that the per-suburb breakdown has more than one row in it — the
 * whole point of the answer. A visitor who names a distance overrides it.
 */
const DEFAULT_RADIUS_KM = 20;

export async function runCheapestNear(
  input: CheapestNearInput,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const cached = ctx.places.get(placeKey(input.place, input.state));
  const place =
    cached ??
    (await ctx.resolvePlace([input.place, input.state, 'Australia'].filter(Boolean).join(', ')));

  if (!place) {
    return {
      label: `Looking up ${input.place}…`,
      result: {
        found: false,
        searched: input.place,
        note: 'That place could not be located. Ask the visitor for a suburb or postcode.',
      },
    };
  }

  if (place.suburb) ctx.places.set(placeKey(place.suburb, place.state ?? undefined), place);

  const radiusKm = input.radiusKm ?? DEFAULT_RADIUS_KM;
  const near = nearSchema.safeParse({
    lat: place.latitude,
    lng: place.longitude,
    radiusKm,
  });
  if (!near.success) {
    return {
      isError: true,
      result: { error: 'That location could not be turned into a searchable point.' },
    };
  }

  const market = await ctx.nearbyMarket({
    near: near.data,
    channel: input.channel,
    ...(input.bedrooms !== undefined ? { bedrooms: input.bedrooms } : {}),
    ...(input.propertyType ? { propertyType: input.propertyType } : {}),
  });

  const from = place.formatted || place.suburb || input.place;

  if (market.listings.length === 0) {
    return {
      label: `Looking around ${place.suburb ?? input.place}…`,
      result: {
        from,
        radiusKm,
        channel: input.channel,
        found: 0,
        unpriced: market.unpriced,
        note:
          market.unpriced > 0
            ? `Nothing within ${radiusKm} km carries a price — ${market.unpriced} listing(s) there say "contact agent". Offer to widen the radius.`
            : `Nothing live within ${radiusKm} km. Offer to widen the radius or try a different area.`,
      },
      facts: {
        ...(place.suburb ? { nearbyCentre: place.suburb } : {}),
        ...(market.unpriced > 0 ? { unpriced: market.unpriced } : {}),
      },
    };
  }

  /**
   * Every figure here was computed by Postgres and is formatted, not derived.
   *
   * `priceLabel` is the same formatter the cards use, so the guide quotes the
   * portal's own wording. The model may copy these strings; it may not do
   * arithmetic on them, and nothing here gives it the raw numbers to try.
   */
  const asListing = (l: (typeof market.listings)[number]) => ({
    id: l.id,
    address: `${l.address}, ${l.suburb} ${l.state} ${l.postcode}`,
    price: priceLabel({
      channel: input.channel,
      priceDisplay: l.priceDisplay,
      priceFrom: l.price,
      priceTo: null,
      rentPw: input.channel === 'rent' ? l.price : null,
    } as Parameters<typeof priceLabel>[0]),
    distance: `${l.distanceKm.toFixed(1)} km`,
    bedrooms: l.bedrooms,
    bathrooms: l.bathrooms,
    carSpaces: l.carSpaces,
  });

  return {
    label: `Looking around ${place.suburb ?? input.place}…`,
    result: {
      from,
      radiusKm,
      channel: input.channel,
      /**
       * Straight-line, and said so in the payload rather than left for the
       * model to assume. An office 5 km away as the crow flies can be twenty
       * minutes by road, and a guide that says "10 minutes away" has invented
       * something no tool told it.
       */
      distanceIs: 'straight-line distance, not drive time',
      cheapest: market.listings.map(asListing),
      bySuburb: market.bySuburb.map((s) => ({
        suburb: `${s.suburb} ${s.state} ${s.postcode}`,
        listings: s.count,
        cheapest: priceLabel({
          channel: input.channel,
          priceDisplay: null,
          priceFrom: s.cheapest,
          priceTo: null,
          rentPw: input.channel === 'rent' ? s.cheapest : null,
        } as Parameters<typeof priceLabel>[0]),
        nearest: `${s.nearestKm.toFixed(1)} km`,
      })),
      ...(market.unpriced > 0
        ? {
            unpriced: market.unpriced,
            unpricedNote: `${market.unpriced} more listing(s) inside the radius say "contact agent" and are not ranked here.`,
          }
        : {}),
    },
    /**
     * The per-suburb breakdown again, for the chips — bare suburb names and
     * the same formatted price labels the model was handed.
     *
     * `bySuburb` arrives cheapest-first from SQL, so the first row that is not
     * the suburb the visitor is already looking at IS the cheaper alternative.
     * Nothing here is sorted, compared or rounded a second time; the ranking
     * is Postgres's and the strings are `priceLabel`'s (#4).
     */
    facts: {
      nearby: market.bySuburb.map((s) => ({
        suburb: s.suburb,
        cheapest: priceLabel({
          channel: input.channel,
          priceDisplay: null,
          priceFrom: s.cheapest,
          priceTo: null,
          rentPw: input.channel === 'rent' ? s.cheapest : null,
        } as Parameters<typeof priceLabel>[0]),
      })),
      ...(place.suburb ? { nearbyCentre: place.suburb } : {}),
      ...(market.unpriced > 0 ? { unpriced: market.unpriced } : {}),
    },
    /**
     * Slots, so the deep link and the sidebar follow the conversation.
     *
     * The suburb is the one the point sits in, with the radius the visitor got
     * — which is exactly the search the "view all" link should open.
     */
    slots: {
      channel: input.channel,
      ...(place.suburb ? { suburb: place.suburb } : {}),
      ...(place.state ? { state: place.state } : {}),
      near: near.data,
      ...(input.bedrooms !== undefined ? { bedrooms: input.bedrooms } : {}),
    },
  };
}
