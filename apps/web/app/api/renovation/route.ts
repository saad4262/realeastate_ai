import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { consumerSkillBlocks, consumerSkillOffMessage } from '@repo/core/consumer-skills';
import { asState, buildRenovationPlan, renovationListing, RenovationError, ROOM_TYPES } from '@repo/core/renovation';
import { renovationAiFromEnv } from '@repo/ai/renovation';
import { aiBudgetAllows } from '@repo/core/ai-budget';
import { getWebDb } from '../../../lib/db';
import { rateLimiter } from '../../../lib/rate-limit';
import { currentWebUser } from '../../../lib/session';

/** postgres.js opens raw sockets, so this cannot run on the edge runtime. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Renovation AI's plan (ADR 0080, C3). Plumbing only (#10): the plan is checked in core (known kinds of work, no
 * money), its cards and permit notes come from core's catalog, the model sits behind packages/ai (#3). With a
 * listing, the state is the listing's — the server decides it (ARCHITECTURE § 9); without one, the buyer picks it.
 * Free text, so nothing is cached; nothing is saved.
 */
const limits = rateLimiter('renovation', { perMinute: 5, dailyCapEnv: 'AI_RENOVATION_DAILY_CAP', dailyCapDefault: 500 });

const bodySchema = z
  .object({
    request: z.string().max(2000),
    state: z.string().max(8).optional(),
    listingId: z.string().uuid().optional(),
    rooms: z.array(z.enum(ROOM_TYPES)).max(ROOM_TYPES.length).optional(),
  })
  .strict();

const fail = (status: number, error: string) => NextResponse.json({ error }, { status });

export async function POST(request: NextRequest) {
  if (limits.overLimit(request)) return fail(429, 'Too many requests. Wait a moment.');
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail(400, 'That request could not be understood.');

  const db = getWebDb();
  const user = await currentWebUser();
  const block = (await consumerSkillBlocks(db, user ? { userId: user.id } : null)).get('renovation');
  if (block) return fail(403, consumerSkillOffMessage('renovation', block));
  if (limits.overDailyCap()) return fail(503, 'The AI is resting for today. Try again tomorrow.');
  // The platform's AI budget (AI_DAILY_BUDGET_USD over ai_run): shared by every instance, unlike the cap above.
  if (!(await aiBudgetAllows(db))) return fail(503, 'The AI is resting for today. Try again tomorrow.');

  const { request: words, listingId, rooms } = parsed.data;
  let state = asState(parsed.data.state);
  if (listingId) {
    const found = await renovationListing(db, listingId);
    if (!found) return fail(404, 'That listing is not available.');
    state = found.state;
  }
  try {
    const plan = await buildRenovationPlan(renovationAiFromEnv(db)?.planner ?? null, { request: words, state, rooms: [...new Set(rooms ?? [])] });
    return NextResponse.json(plan);
  } catch (err) {
    if (err instanceof RenovationError) return fail(err.code === 'invalid' ? 400 : 503, err.message);
    console.error('[renovation] failed', err);
    return fail(503, 'The AI could not answer just now. Try again in a moment.');
  }
}
