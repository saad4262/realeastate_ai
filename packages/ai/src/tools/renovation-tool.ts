import { z } from 'zod';
import { AU_STATES } from '@repo/core/listings';
import { planCards, TRIGGER_LABELS } from '@repo/core/renovation';
import { RENOVATION_CATEGORY_KEYS } from '@repo/core/renovation/categories';
import type { ToolContext, ToolOutcome } from './context';

/**
 * Renovation AI in the guide (ADR 0080, C3 decision 6). The guide picks the kinds of work itself — the schema's
 * enum is the fixed list, so it cannot name another (decision 2) — and core returns what drives each one's cost,
 * the trades, and the state's permit notes with their sources, or "not verified". No model call inside, and no
 * price anywhere (decision 1): the tool tells the guide to say why, and to point at the quotes on the page.
 */
export const renovationInput = z
  .object({
    categories: z.array(z.enum(RENOVATION_CATEGORY_KEYS)).min(1).max(10),
    state: z.enum(AU_STATES).optional(),
    listingId: z.string().uuid().optional(),
  })
  /** Unknown keys are stripped, not refused — see search-listings-tool.ts. */
  .strip();

export type RenovationToolInput = z.infer<typeof renovationInput>;

export async function runRenovation(input: RenovationToolInput, ctx: ToolContext): Promise<ToolOutcome> {
  // A listing's state wins: it is the home they are asking about (the public read decides it exists).
  const fromListing = input.listingId ? await ctx.getListing(input.listingId) : null;
  const state = (fromListing?.state as RenovationToolInput['state']) ?? input.state ?? null;
  const plan = planCards([...new Set(input.categories)].map((category) => ({ category, note: '' })), state);
  return {
    label: 'Looking at the renovation…',
    result: {
      state,
      work: plan.cards.map((c) => ({ kind: c.name, whatDrivesTheCost: c.costDrivers, trades: c.trades })),
      permits: plan.permits.map((p) => (p.verified ? { about: TRIGGER_LABELS[p.trigger], note: p.note, source: `${p.source.name}, checked ${p.source.checkedOn}` } : { about: TRIGGER_LABELS[p.trigger], notVerified: true })),
      noStateNote: state ? null : 'No state given: ask which state the home is in if they want permit notes.',
      instruction:
        'Never give a price, a range, a rate or a budget — say there is no official, current price list for renovation work in Australia, so written quotes are the only honest figure. Name what drives the cost most and the trades. For permits, give the verified notes and say which ones we have not verified (a registered building surveyor, a certifier or the council decides). Point them to the Renovation page, which makes a plan and compares their quotes. End with: "General information, not building or planning advice."',
    },
  };
}
