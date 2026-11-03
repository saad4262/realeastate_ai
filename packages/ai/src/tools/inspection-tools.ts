import { z } from 'zod';
import { MAX_PLAN_HOMES } from '@repo/core/inspections';
import type { ToolContext, ToolOutcome } from './context';

/**
 * Inspection AI in the guide (ADR 0080, C6 decision 5): the app's reader builds the day from the agents' open times
 * and PostGIS, and writes every time and distance; the guide copies them and links the plan page. No model call
 * inside. Inspection notes are never reachable from here.
 */
export const planInspectionsInput = z
  .object({
    listingIds: z.array(z.string().uuid()).min(1).max(MAX_PLAN_HOMES),
    day: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .strip();

export async function runPlanInspections(input: z.infer<typeof planInspectionsInput>, ctx: ToolContext): Promise<ToolOutcome> {
  const label = 'Planning your inspections…';
  const plan = await ctx.inspections({ listingIds: input.listingIds, day: input.day ?? null });
  if (!plan) return { label, result: { found: false, note: 'None of those homes is on the portal now. Say so; do not plan from memory.' } };
  if (!plan.stops.length) return { label, result: { found: true, day: plan.day, stops: [], notThisDay: plan.notThisDay, note: 'None of these homes has an open-for-inspection time that day. Say so, give the next times listed, and suggest asking the agent for a private inspection.', instruction: plan.rules } };
  return { label, result: { found: true, day: plan.day, stops: plan.stops, notThisDay: plan.notThisDay, planPage: plan.planPath, instruction: plan.rules } };
}
