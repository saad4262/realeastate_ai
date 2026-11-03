import { z } from 'zod';
import { AU_STATES } from '@repo/core/listings';
import type { ToolContext, ToolOutcome } from './context';

/**
 * Suburb AI, Comparison AI and Property Analyst in the guide (ADR 0080, C5 decision 6). The app's cached reader
 * builds the records from SQL and the census — public listings only, the reader decides — and the guide explains
 * them, citing references. No model call inside; never a value, a verdict or a prediction (decision 1).
 */
export const suburbProfileInput = z.object({ state: z.enum(AU_STATES), suburb: z.string().trim().min(1).max(80) }).strip();
export const compareHomesInput = z.object({ listingIds: z.array(z.string().uuid()).min(2).max(4), buyer: z.enum(['first', 'home', 'investor']).optional() }).strip();
export const explainHomeInput = z.object({ listingId: z.string().uuid() }).strip();

const RULES =
  'Copy every figure exactly from these records and cite them like [S1] or [A]; never calculate, average or round. Never give a value, a fair price, a prediction or a verdict (not "good value", "best", "better", "will grow", "should buy") and never say which to choose. Figures marked "on this site" are this portal\'s own listings, not the whole market — say so.';

async function run(ctx: ToolContext, ask: Parameters<ToolContext['research']>[0], label: string): Promise<ToolOutcome> {
  const data = await ctx.research(ask);
  if (!data) return { label, result: { found: false, note: 'Nothing on the portal for that. Say so rather than describing it from memory.' } };
  return { label, result: { found: true, about: data.subject, records: data.records.map((r) => `[${r.ref}] ${r.text}`), instruction: RULES } };
}

export const runSuburbProfile = (i: z.infer<typeof suburbProfileInput>, ctx: ToolContext) => run(ctx, { kind: 'suburb', state: i.state, suburb: i.suburb }, `Looking at ${i.suburb}…`);
export const runCompareHomes = (i: z.infer<typeof compareHomesInput>, ctx: ToolContext) => run(ctx, { kind: 'compare', listingIds: i.listingIds, buyer: i.buyer ?? 'home' }, 'Comparing the homes…');
export const runExplainHome = (i: z.infer<typeof explainHomeInput>, ctx: ToolContext) => run(ctx, { kind: 'explain', listingId: i.listingId }, 'Reading the home’s records…');
