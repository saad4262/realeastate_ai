import { z } from 'zod';
import { AU_STATES, PROPERTY_TYPES } from '@repo/core/listings';
import { MAX_SUBURBS, SIGNAL_KINDS } from '@repo/core/buyer-opportunities';
import type { ToolContext, ToolOutcome } from './context';

/**
 * Discovery AI and Opportunity AI in the guide (ADR 0080, C7 decision 9). The app's readers build the records from SQL
 * — the suggestions and their one difference, the signals and our own words about them — and the guide copies them
 * and links the page. No model call inside; nothing here picks, ranks or values a home.
 */
export const discoverHomesInput = z.object({ listingId: z.string().uuid().optional() }).strip();

export async function runDiscoverHomes(input: z.infer<typeof discoverHomesInput>, ctx: ToolContext): Promise<ToolOutcome> {
  const result = await ctx.discover(input.listingId ? { listingId: input.listingId } : { profile: true });
  return { label: input.listingId ? 'Finding similar homes…' : 'Finding homes from your profile…', result };
}

/** The fields, apart from the refinement, so tools.test can hold them against the JSON Schema. */
export const findOpportunitiesFields = z
  .object({
    suburbs: z.array(z.string().trim().min(1).max(60)).max(MAX_SUBURBS).optional(),
    state: z.enum(AU_STATES).optional(),
    priceTo: z.number().int().positive().max(100_000_000).optional(),
    bedrooms: z.number().int().min(1).max(20).optional(),
    propertyType: z.enum(PROPERTY_TYPES).optional(),
    signals: z.array(z.enum(SIGNAL_KINDS)).max(SIGNAL_KINDS.length).optional(),
  })
  .strip();
export const findOpportunitiesInput = findOpportunitiesFields.refine((v) => Boolean(v.suburbs?.length || v.state), { message: 'Name at least one suburb or a state.' });

export async function runFindOpportunities(input: z.infer<typeof findOpportunitiesInput>, ctx: ToolContext): Promise<ToolOutcome> {
  const result = await ctx.opportunities({
    suburbs: (input.suburbs ?? []).map((s) => s.toLowerCase().replace(/\s+/g, ' ')),
    state: input.state ?? null,
    priceTo: input.priceTo ?? null,
    bedrooms: input.bedrooms ?? null,
    propertyType: input.propertyType ?? null,
    signals: [...new Set(input.signals ?? [])],
  });
  return { label: 'Looking for price reductions and long campaigns…', result };
}
