import { z } from 'zod';
import { DEFAULT_RADIUS_KM } from '@repo/core/geo/schema';
import { placeKey, type ToolContext, type ToolOutcome } from './context';

/**
 * Turn a place the visitor named into one the portal knows.
 *
 * Two things this deliberately does NOT return: coordinates, and a radius the
 * model chose. The model never sees a latitude, so it can never pass a forged
 * one to the search — the resolved point is stashed in the turn's place map and
 * the search tool looks it up. And the radius comes from DEFAULT_RADIUS_KM for
 * the kind of place this is, so "near Sydney" is 25 km and "near Pakenham" is
 * 5 km without the model guessing.
 */
export const resolveLocationInput = z
  .object({
    place: z
      .string()
      .trim()
      .min(2)
      .max(80)
      .describe('A suburb, postcode, region or address the visitor named, e.g. "Pakenham" or "Bondi Beach NSW"'),
  })
  /** Unknown keys are stripped, not refused — see search-listings-tool.ts. */
  .strip();

export type ResolveLocationInput = z.infer<typeof resolveLocationInput>;

export async function runResolveLocation(
  input: ResolveLocationInput,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const place = await ctx.resolvePlace(input.place);

  if (!place || !place.suburb) {
    return {
      label: `Looking up ${input.place}…`,
      result: {
        found: false,
        searched: input.place,
        note: 'No Australian suburb matched. Ask the visitor to name the suburb or postcode.',
      },
    };
  }

  ctx.places.set(placeKey(place.suburb, place.state ?? undefined), place);

  return {
    label: `Looking up ${place.suburb}…`,
    result: {
      found: true,
      suburb: place.suburb,
      state: place.state,
      postcode: place.postcode,
      formatted: place.formatted,
      kind: place.kind,
      /**
       * What to pass as radiusKm IF the visitor asked to include the
       * surrounding area. A suburb search on its own passes nothing, because
       * "in Pakenham" means Pakenham.
       */
      defaultRadiusKm: DEFAULT_RADIUS_KM[place.kind],
      note:
        place.kind === 'region'
          ? 'This is a wide area, not a single suburb. Searching it without a radius will find little — ask which suburb, or search with defaultRadiusKm.'
          : undefined,
    },
  };
}
