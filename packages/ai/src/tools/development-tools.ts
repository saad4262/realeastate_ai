import { z } from 'zod';
import type { ToolContext, ToolOutcome } from './context';

/**
 * Property Development in the guide (ADR 0080, C9 decisions 4–6, 12): a public property's zone from its state's own
 * data, the land size from its ad, where the overlays are, and the questions to ask. The records only — the result
 * carries the rules, and the prompt forbids advice. No model call inside.
 */
export const landAndZoningFields = z.object({ listingId: z.string().uuid().optional(), propertyId: z.string().uuid().optional() }).strip();
export const landAndZoningInput = landAndZoningFields.refine((v) => Boolean(v.listingId) !== Boolean(v.propertyId), { message: 'Give a listingId or a propertyId, not both' });

export async function runLandAndZoning(input: z.infer<typeof landAndZoningInput>, ctx: ToolContext): Promise<ToolOutcome> {
  const label = 'Looking up the zoning…';
  const out = await ctx.development(input.listingId ? { listingId: input.listingId } : { propertyId: input.propertyId! });
  if (!out) return { label, result: { found: false, note: 'That address is not on the portal. Say so; never guess a zone.' } };
  return { label, result: out };
}
