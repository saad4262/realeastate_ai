import { NextResponse, type NextRequest } from 'next/server';
import { buildPlan, parsePlanLink, planIcs, reachable } from '@repo/core/inspections';
import { consumerSkillBlocks, consumerSkillOffMessage } from '@repo/core/consumer-skills';
import { getWebDb } from '../../../lib/db';
import { currentWebUser } from '../../../lib/session';
import { apiError } from '@repo/core/http/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * "Add to calendar" (ADR 0080, C6 decision 3): the plan in its link as one .ics file, an event per stop the buyer
 * will reach, in the agents' times. Plumbing only (#10): core builds the plan and the file. No calendar account.
 */
export async function GET(request: NextRequest) {
  const ask = parsePlanLink(Object.fromEntries(request.nextUrl.searchParams));
  if (!ask) return apiError(400, 'No homes in that plan.');
  const db = getWebDb();
  const user = await currentWebUser();
  const block = (await consumerSkillBlocks(db, user ? { userId: user.id } : null)).get('inspection_planner');
  if (block) return apiError(403, consumerSkillOffMessage('inspection_planner', block));

  const plan = await buildPlan(db, ask);
  if (!plan || !reachable(plan).length) return apiError(404, 'None of those homes has an open time to add.');
  const origin = request.nextUrl.origin;
  const body = planIcs(plan, { now: new Date(), listingUrl: (id) => `${origin}/listing/${id}` });
  return new NextResponse(body, {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': `attachment; filename="inspections-${plan.day}.ics"`,
      'cache-control': 'private, no-store',
    },
  });
}
