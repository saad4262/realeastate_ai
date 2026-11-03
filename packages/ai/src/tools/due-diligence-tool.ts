import { z } from 'zod';
import { checklistFor, GENERAL_CHECKLIST } from '@repo/core/due-diligence';
import type { ToolContext, ToolOutcome } from './context';

/**
 * Due-Diligence AI in the guide (ADR 0080, C2 decision 7). The records come from SQL through the app's cached
 * reader (a public listing only — the reader decides), the checklist from the state's official pages. The
 * model explains and cites; every figure is copied from a record (#4). Questions to the agent are drafted on
 * the listing's own "Before you buy", where the buyer sends them; the guide only points there.
 */
export const dueDiligenceInput = z
  .object({
    listingId: z.string().uuid().describe('The id from a search result.'),
  })
  /** Unknown keys are stripped, not refused — see search-listings-tool.ts. */
  .strip();

export type DueDiligenceToolInput = z.infer<typeof dueDiligenceInput>;

export async function runDueDiligence(input: DueDiligenceToolInput, ctx: ToolContext): Promise<ToolOutcome> {
  const found = await ctx.dueDiligence(input.listingId);
  if (!found) {
    return {
      label: 'Checking the records…',
      result: { found: false, note: 'No live listing with that id. It may have been withdrawn or sold. Say so rather than describing it from memory.' },
    };
  }
  const checklist = checklistFor(found.state);
  return {
    label: `Checking the records for ${found.address}…`,
    result: {
      found: true,
      address: found.address,
      state: found.state,
      records: found.facts.map((f) => `[${f.ref}] ${f.when}: ${f.text}`),
      recordsNote: 'From listings on this portal by any agency; a sale or listing elsewhere is not here.',
      stateChecklist: checklist?.items ? checklist.items.map((i) => i.title) : null,
      stateChecklistSource: checklist?.source ? `${checklist.source.name}, checked ${checklist.source.checkedOn}` : null,
      stateNotVerified: checklist?.items ? null : `We have not verified ${found.state}'s own rules for buyers; only the general list applies.`,
      generalChecklist: GENERAL_CHECKLIST.map((i) => i.title),
      officialMaps: checklist?.maps.map((m) => m.label) ?? [],
      instruction:
        'Mention what the records show, citing them like [R1], copying every date and figure exactly — never calculate, never value the home, never say whether to buy. Then the two or three checklist points that matter most for this state. Tell them the full checklist, the map links and questions to send the agent are on the listing under "Before you buy". End with: "General information, not legal advice — a conveyancer or solicitor should review the contract before you sign."',
    },
  };
}
