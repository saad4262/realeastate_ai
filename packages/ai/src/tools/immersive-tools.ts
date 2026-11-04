import { z } from 'zod';
import type { ToolContext, ToolOutcome } from './context';

/**
 * Immersive in the guide (ADR 0080, C9 decision 3): a listing's floorplan rooms by name, and whether it has a video or a
 * 3D tour. Never a size — the result says so, and the prompt does. No model call inside.
 */
export const floorplanRoomsInput = z.object({ listingId: z.string().uuid() }).strip();

export async function runFloorplanRooms(input: z.infer<typeof floorplanRoomsInput>, ctx: ToolContext): Promise<ToolOutcome> {
  const label = 'Reading the floorplan…';
  const out = await ctx.floorplan(input.listingId);
  if (!out) return { label, result: { found: false, note: 'That home is not advertised on the portal now. Say so.' } };
  if (!out.found) return { label, result: { ...out, note: 'This listing has no floorplan, video or tour on the portal. Say so, and suggest asking the agent for a floorplan. Never guess the rooms or their sizes.' } };
  return { label, result: out };
}
