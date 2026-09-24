import type Anthropic from '@anthropic-ai/sdk';
import { AU_STATES, SORT_OPTIONS } from '@repo/core/listings';
import { getListingInput, runGetListing } from './get-listing-tool';
import { resolveLocationInput, runResolveLocation } from './resolve-location';
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
 * FROZEN AND MODULE-LEVEL. Rebuilding this per request changes nothing
 * visible and destroys the cache.
 */
export const PROPERTY_CHAT_TOOLS: readonly Anthropic.Tool[] = Object.freeze([
  {
    name: 'resolve_location',
    description:
      'Turn a place the visitor named into a suburb the portal knows, with its state, postcode and a sensible default radius. Call this before searching whenever the visitor names a location. Returns no coordinates — you never need them.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        place: {
          type: 'string',
          minLength: 2,
          maxLength: 80,
          description:
            'A suburb, postcode, region or address the visitor named, e.g. "Pakenham" or "Bondi Beach NSW".',
        },
      },
      required: ['place'],
    },
  },
  {
    name: 'search_listings',
    description:
      "Search the portal's live listings. Requires both the channel (buying or renting) and a suburb — ask the visitor if you do not know either. Returns a match count and a few listings; the visitor sees the full results beside the conversation. If it comes back tooBroad, no listings were returned and you must ask for what `missing` names before searching again.",
    strict: true,
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
          minLength: 2,
          maxLength: 60,
          description: 'REQUIRED. The suburb, as resolve_location returned it.',
        },
        state: {
          type: 'string',
          enum: [...AU_STATES],
          description: 'State abbreviation, e.g. VIC or NSW. Disambiguates a repeated suburb name.',
        },
        postcode: { type: 'string', pattern: '^\\d{4}$' },
        radiusKm: {
          type: 'number',
          minimum: 0.5,
          maximum: 50,
          description:
            'Only when the visitor asked to include the surrounding area. Omit it to search the suburb itself. Use the defaultRadiusKm resolve_location gave you rather than inventing one.',
        },
        bedrooms: { type: 'integer', minimum: 0, maximum: 10, description: 'Minimum bedrooms.' },
        bathrooms: { type: 'integer', minimum: 0, maximum: 10, description: 'Minimum bathrooms.' },
        carSpaces: { type: 'integer', minimum: 0, maximum: 10, description: 'Minimum car spaces.' },
        propertyType: {
          type: 'string',
          maxLength: 40,
          description: 'e.g. House, Apartment, Townhouse.',
        },
        landFrom: {
          type: 'integer',
          minimum: 0,
          maximum: 100000,
          description: 'Minimum land size in square metres.',
        },
        priceFrom: {
          type: 'integer',
          minimum: 0,
          maximum: 50000000,
          description: 'Lower bound. For rent this is dollars per week.',
        },
        priceTo: {
          type: 'integer',
          minimum: 0,
          maximum: 50000000,
          description: "The visitor's budget ceiling. For rent this is dollars per week.",
        },
        sort: { type: 'string', enum: [...SORT_OPTIONS] },
        keywords: {
          type: 'string',
          maxLength: 60,
          description: 'A feature the visitor mentioned, e.g. "pool". Never a suburb name.',
        },
      },
      required: ['channel', 'suburb'],
    },
  },
  {
    name: 'get_listing',
    description:
      'Fetch one live listing in full by its id, including the price and the agency\'s own description. Use this whenever the visitor asks about a specific property — you cannot recall figures from earlier in the conversation and must not try.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        listingId: { type: 'string', description: 'The id from a search result.' },
      },
      required: ['listingId'],
    },
  },
] satisfies Anthropic.Tool[]);

export type ToolName = 'resolve_location' | 'search_listings' | 'get_listing';

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
