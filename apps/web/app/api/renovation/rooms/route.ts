import { unstable_cache } from 'next/cache';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { consumerSkillBlocks, consumerSkillOffMessage } from '@repo/core/consumer-skills';
import { listingRooms, RenovationError } from '@repo/core/renovation';
import { renovationAiFromEnv } from '@repo/ai/renovation';
import { LISTINGS_TAG } from '../../../../lib/cached';
import { getWebDb } from '../../../../lib/db';
import { rateLimiter } from '../../../../lib/rate-limit';
import { currentWebUser } from '../../../../lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Which rooms a public listing's photos show (ADR 0080, C3 decision 3) — rooms only; core refuses an answer with
 * anything else in it. The same photos give the same answer, so it is kept for an hour under the listings tag
 * (a new photo clears it with everything else); a failure is never cached.
 */
const limits = rateLimiter('renovation-rooms', { perMinute: 3, dailyCapEnv: 'AI_RENOVATION_ROOMS_DAILY_CAP', dailyCapDefault: 200 });
const bodySchema = z.object({ listingId: z.string().uuid() }).strict();
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

  const { listingId } = parsed.data;
  try {
    const run = unstable_cache(async () => listingRooms(db, renovationAiFromEnv(db)?.rooms ?? null, listingId), ['renovation-rooms', listingId], { tags: [LISTINGS_TAG], revalidate: 3600 });
    return NextResponse.json({ rooms: await run() });
  } catch (err) {
    if (err instanceof RenovationError) return fail(err.code === 'not_found' ? 404 : 503, err.message);
    console.error('[renovation rooms] failed', err);
    return fail(503, 'The AI could not read the photos just now.');
  }
}
