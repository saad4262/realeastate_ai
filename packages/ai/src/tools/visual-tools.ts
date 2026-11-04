import type { z } from 'zod';
import { lookAskFields, lookAskSchema } from '@repo/core/visual-search';
import type { ToolContext, ToolOutcome } from './context';

/**
 * Visual Search in the guide (ADR 0080, C9 decisions 9–12): homes whose photos look like the visitor's words or one
 * photo on this site, within their filters. Records only — the result carries the rules; no score is ever in it.
 */
export const homesThatLookLikeFields = lookAskFields;
export const homesThatLookLikeInput = lookAskSchema;

export async function runHomesThatLookLike(input: z.infer<typeof lookAskSchema>, ctx: ToolContext): Promise<ToolOutcome> {
  return { label: 'Searching by look…', result: await ctx.visualSearch(input) };
}
