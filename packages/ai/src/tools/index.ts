import type Anthropic from '@anthropic-ai/sdk';
import { AU_STATES, SORT_OPTIONS } from '@repo/core/listings';
import { cheapestNearInput, runCheapestNear } from './cheapest-near';
import { getListingInput, runGetListing } from './get-listing-tool';
import { resolveLocationInput, runResolveLocation } from './resolve-location';
import {
  cancelScheduleInput,
  draftScheduleInput,
  runCancelSchedule,
  runDraftSchedule,
} from './schedule-tools';
import { runSearchListings, searchListingsInput } from './search-listings-tool';
import type { ToolContext, ToolOutcome } from './context';

export { type ToolContext, type ToolOutcome, placeKey } from './context';
export { toPublicSearchQuery, type SearchListingsInput } from './search-listings-tool';

/**
 * The tool definitions the model is shown.
 *
 * Hand-written JSON Schema rather than generated from the zod schemas beside
 * them. Two reasons: the SDK's zod helper wants zod v4 and the tool runner,
 * and this array is the first thing in the cached prefix — tools render before
 * system and messages, so a schema generated slightly differently between two
 * library versions would silently cost every cache hit on the route.
 *
 * The cost is that the JSON Schema and the zod schema could drift, so
 * tools.test.ts asserts they agree on property names and required fields.
 *
 * NO `strict: true`, AND NO VALIDATION KEYWORDS. Both were here and both had
 * to go, for reasons only the live model showed:
 *
 * 1. `strict: true` made the guide fill in the optional filters. Watching the
 *    frames: `keywords: "-"`, then `keywords: "1"`, `priceTo: 22`, `priceTo: 0`
 *    — placeholder junk in fields the visitor had said nothing about, on every
 *    single call. Each one silently narrowed the search to zero results, and
 *    the visitor would only have seen "nothing matches". Optional has to mean
 *    optional, and under strict mode this model treats it as "supply
 *    something".
 * 2. With `strict: true` the API also refuses `minimum`/`maximum`/`pattern`
 *    outright — "tools.1.custom: For 'integer' type, properties maximum,
 *    minimum are not supported" — and 400s the whole request.
 *
 * So the schema now carries `type`, `enum` and `description` only. Bounds are
 * stated in prose, where the model reads them, and enforced in the zod schema
 * beside each tool, where they are actually checked. Nothing is lost: a JSON
 * Schema the model is shown was never the thing standing between an anonymous
 * visitor and the database — `dispatchTool` re-parses every input regardless.
 * tools.test.ts pins both of these down.
 *
 * FROZEN AND MODULE-LEVEL. Rebuilding this per request changes nothing
 * visible and destroys the cache.
 */
export const PROPERTY_CHAT_TOOLS: readonly Anthropic.Tool[] = Object.freeze([
  {
    name: 'resolve_location',
    description:
      'Turn a place the visitor named into a suburb the portal knows, with its state, postcode and a sensible default radius. Call this before searching whenever the visitor names a location. Returns no coordinates — you never need them.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        place: {
          type: 'string',
          description:
            'A suburb, postcode, region or address the visitor named, e.g. "Pakenham" or "Bondi Beach NSW". Two to eighty characters.',
        },
      },
      required: ['place'],
    },
  },
  {
    name: 'search_listings',
    description:
      "Search the portal's live listings. Requires both the channel (buying or renting) and a suburb — ask the visitor if you do not know either. Returns a match count and a few listings; the visitor sees the full results beside the conversation. If it comes back tooBroad, no listings were returned and you must ask for what `missing` names before searching again.",
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        channel: {
          type: 'string',
          enum: ['sale', 'rent'],
          description: 'REQUIRED. Whether the visitor is buying or renting.',
        },
        suburb: {
          type: 'string',
          description: 'REQUIRED. The suburb, as resolve_location returned it.',
        },
        state: {
          type: 'string',
          enum: [...AU_STATES],
          description: 'State abbreviation, e.g. VIC or NSW. Disambiguates a repeated suburb name.',
        },
        postcode: { type: 'string', description: 'Four digits, e.g. 3810.' },
        radiusKm: {
          type: 'number',
          description:
            'Between 0.5 and 50. Only when the visitor asked to include the surrounding area. Omit it to search the suburb itself. Use the defaultRadiusKm resolve_location gave you rather than inventing one.',
        },
        bedrooms: { type: 'integer', description: 'Minimum bedrooms, 0 to 10.' },
        bathrooms: { type: 'integer', description: 'Minimum bathrooms, 0 to 10.' },
        carSpaces: { type: 'integer', description: 'Minimum car spaces, 0 to 10.' },
        propertyType: {
          type: 'string',
          description:
            'Only when the visitor contrasted types (Unit, Apartment, Townhouse, Land vs House). Never for the everyday word "house" or "home" alone — omit the field.',
        },
        landFrom: { type: 'integer', description: 'Minimum land size in square metres.' },
        priceFrom: {
          type: 'integer',
          description: 'Lower bound in whole dollars. For rent this is dollars per week.',
        },
        priceTo: {
          type: 'integer',
          description:
            "The visitor's budget ceiling in whole dollars. For rent this is dollars per week.",
        },
        sort: {
          type: 'string',
          enum: [...SORT_OPTIONS],
          description:
            'price_asc for cheapest, price_desc for most expensive, newest for latest, relevance (default) for nearest-first when a radius is set.',
        },
        keywords: {
          type: 'string',
          description: 'A feature the visitor mentioned, e.g. "pool". Never a suburb name.',
        },
      },
      required: ['channel', 'suburb'],
    },
  },
  {
    name: 'cheapest_near',
    description:
      'Answer "where is the cheapest place near X" from one point — an office, a school, an address, a suburb. Returns the cheapest live listings inside a radius WITH each one\'s distance, and a per-suburb breakdown (how many, the cheapest, how far the nearest is). Use this instead of search_listings whenever the visitor ties price to a place they need to be near. Distances are straight-line, never drive time; say so if you mention minutes.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        place: {
          type: 'string',
          description:
            'What to measure from, in the visitor\'s own words — "Berwick", "my office in Dandenong", "3 Collins St Melbourne". No coordinates: this tool resolves the point itself.',
        },
        channel: {
          type: 'string',
          enum: ['sale', 'rent'],
          description: 'REQUIRED. Whether the visitor is buying or renting.',
        },
        radiusKm: {
          type: 'number',
          description:
            'Between 0.5 and 50. Only when the visitor named a distance they would travel. Omitted means 20 km, which is a commute somebody would consider.',
        },
        state: {
          type: 'string',
          enum: [...AU_STATES],
          description: 'Disambiguates a repeated place name. There is a Richmond in four states.',
        },
        bedrooms: { type: 'integer', description: 'Minimum bedrooms, 0 to 10.' },
        propertyType: {
          type: 'string',
          description:
            'Only when the visitor contrasted types (Unit, Apartment, Townhouse, Land vs House). Never for the everyday word "house".',
        },
      },
      required: ['place', 'channel'],
    },
  },
  {
    name: 'get_listing',
    description:
      'Fetch one live listing in full by its id, including the price and the agency\'s own description. Use this whenever the visitor asks about a specific property — you cannot recall figures from earlier in the conversation and must not try.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        listingId: { type: 'string', description: 'The id from a search result.' },
      },
      required: ['listingId'],
    },
  },
  {
    name: 'draft_schedule',
    description:
      "Propose running the CURRENT search on a repeating schedule and emailing the visitor what is new. Call this when they ask to be sent results regularly — 'send me this daily', 'every two hours', 'each Saturday morning'. A search must already have run in this conversation; this uses that exact search, so do not describe the filters yourself. It SAVES NOTHING: it puts a confirmation card on screen and the visitor must press Accept. Never tell them it is running.",
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cadence: {
          type: 'string',
          enum: ['daily', 'weekly', 'interval'],
          description:
            "'interval' for anything expressed as a gap ('every 2 hours'), 'daily' for a time each day, 'weekly' for a day of the week.",
        },
        everyHours: {
          type: 'number',
          description:
            'Only for interval, and only for gaps of an hour or more. Hours between runs. There is no upper limit — every 336 hours is a fortnight and is fine. For anything under an hour use everyMinutes instead of a fraction.',
        },
        everyMinutes: {
          type: 'number',
          description:
            'Only for interval. Minutes between runs, for a gap the visitor expressed in minutes. Ten minutes is the shortest available and is a hard floor; anything shorter is moved up to ten and the card will say so.',
        },
        atTime: {
          type: 'string',
          description:
            "Only for daily and weekly. 24-hour local time, e.g. '20:00'. Defaults to 20:00 when the visitor did not say.",
        },
        weekday: {
          type: 'number',
          description: 'Only for weekly. 0 is Sunday, 6 is Saturday.',
        },
        timezone: {
          type: 'string',
          description:
            "The visitor's Australian IANA timezone, e.g. 'Australia/Melbourne'. Defaults to Australia/Sydney. Ignored for interval.",
        },
      },
      required: ['cadence'],
    },
  },
  {
    name: 'cancel_schedule',
    description:
      "Stop a saved search the visitor asked to cancel. Pauses it rather than deleting it, so it can be turned back on. If the visitor has more than one and it is not clear which they mean, this returns the names instead of guessing — ask them which.",
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        which: {
          type: 'string',
          description:
            "Words from the name or the search, as the visitor described it — e.g. 'Pakenham' or 'the rental one'. Leave out to stop all of them.",
        },
      },
      required: [],
    },
  },
] satisfies Anthropic.Tool[]);

export type ToolName =
  | 'resolve_location'
  | 'search_listings'
  | 'cheapest_near'
  | 'get_listing'
  | 'draft_schedule'
  | 'cancel_schedule';

/**
 * Run one tool call.
 *
 * Every input is re-parsed with zod before it reaches a query, no matter what
 * `strict: true` promised — the schema is the contract, this is the guard, and
 * the guard is what stands between an anonymous visitor and the database.
 *
 * A bad input comes back as an error result the model can read and recover
 * from, not a thrown exception that kills the turn. The visitor asked a
 * question; a malformed tool call is not their problem.
 */
export async function dispatchTool(
  name: string,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  try {
    switch (name) {
      case 'resolve_location': {
        const parsed = resolveLocationInput.safeParse(rawInput);
        if (!parsed.success) return invalid(name, parsed.error);
        return await runResolveLocation(parsed.data, ctx);
      }
      case 'search_listings': {
        const parsed = searchListingsInput.safeParse(rawInput);
        if (!parsed.success) return invalid(name, parsed.error);
        return await runSearchListings(parsed.data, ctx);
      }
      case 'cheapest_near': {
        const parsed = cheapestNearInput.safeParse(rawInput);
        if (!parsed.success) return invalid(name, parsed.error);
        return await runCheapestNear(parsed.data, ctx);
      }
      case 'draft_schedule': {
        const parsed = draftScheduleInput.safeParse(rawInput);
        if (!parsed.success) return invalid(name, parsed.error);
        return await runDraftSchedule(parsed.data, ctx);
      }
      case 'cancel_schedule': {
        const parsed = cancelScheduleInput.safeParse(rawInput);
        if (!parsed.success) return invalid(name, parsed.error);
        return await runCancelSchedule(parsed.data, ctx);
      }
      case 'get_listing': {
        const parsed = getListingInput.safeParse(rawInput);
        if (!parsed.success) return invalid(name, parsed.error);
        return await runGetListing(parsed.data, ctx);
      }
      default:
        return {
          isError: true,
          result: { error: `Unknown tool: ${name}` },
        };
    }
  } catch (err) {
    // The database was unreachable, or the geocoder was. Say so to the model so
    // it can tell the visitor, rather than letting the stream die mid-sentence.
    console.error(`[ai] tool ${name} failed`, err);
    return {
      isError: true,
      result: {
        error: 'The property database could not be reached. Tell the visitor to try again shortly.',
      },
    };
  }
}

function invalid(name: string, error: { issues: { path: PropertyKey[]; message: string }[] }): ToolOutcome {
  return {
    isError: true,
    result: {
      error: `Invalid arguments for ${name}.`,
      issues: error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    },
  };
}
