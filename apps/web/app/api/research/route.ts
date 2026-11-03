import { unstable_cache } from 'next/cache';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { consumerSkillBlocks, consumerSkillOffMessage, type ConsumerSkillKey } from '@repo/core/consumer-skills';
import { runResearch, ResearchError, type ResearchAsk } from '@repo/core/research';
import { researchWriterFromEnv } from '@repo/ai/research';
import { LISTINGS_TAG } from '../../../lib/cached';
import { getWebDb } from '../../../lib/db';
import { rateLimiter } from '../../../lib/rate-limit';
import { currentWebUser } from '../../../lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * C5's AI paragraphs (ADR 0080): a suburb, a comparison, one home explained. Plumbing only (#10): core builds the
 * records from public data and checks every line (references, figures, the verdict rule); the model is behind
 * packages/ai (#3). Cached — a suburb for a day, homes for an hour — under the listings tag; never saved.
 */
const limits = rateLimiter('research', { perMinute: 5, dailyCapEnv: 'AI_RESEARCH_DAILY_CAP', dailyCapDefault: 500 });

const bodySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('suburb'), state: z.enum(['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT']), suburb: z.string().trim().min(1).max(80) }).strict(),
  z.object({ kind: z.literal('compare'), listingIds: z.array(z.string().uuid()).min(2).max(4), buyer: z.enum(['first', 'home', 'investor']).default('home') }).strict(),
  z.object({ kind: z.literal('explain'), listingId: z.string().uuid() }).strict(),
]);

const SKILL: Record<ResearchAsk['kind'], ConsumerSkillKey> = { suburb: 'suburb_insights', compare: 'comparison', explain: 'property_analyst' };
const fail = (status: number, error: string) => NextResponse.json({ error }, { status });

export async function POST(request: NextRequest) {
  if (limits.overLimit(request)) return fail(429, 'Too many requests. Wait a moment.');
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail(400, 'That request could not be understood.');
  const ask = parsed.data as ResearchAsk;

  const db = getWebDb();
  const user = await currentWebUser();
  const block = (await consumerSkillBlocks(db, user ? { userId: user.id } : null)).get(SKILL[ask.kind]);
  if (block) return fail(403, consumerSkillOffMessage(SKILL[ask.kind], block));
  if (limits.overDailyCap()) return fail(503, 'The AI is resting for today. Every figure is still on the page.');

  const key = ask.kind === 'suburb' ? [ask.state, ask.suburb.toLowerCase()] : ask.kind === 'compare' ? [ask.buyer, ...ask.listingIds] : [ask.listingId];
  try {
    const run = unstable_cache(async () => runResearch(db, researchWriterFromEnv(db), ask), ['research-ai', ask.kind, ...key], { tags: [LISTINGS_TAG], revalidate: ask.kind === 'suburb' ? 86_400 : 3600 });
    return NextResponse.json(await run());
  } catch (err) {
    if (err instanceof ResearchError) return fail(err.code === 'invalid' ? 400 : err.code === 'not_found' ? 404 : 503, err.message);
    console.error('[research] failed', err);
    return fail(503, 'The AI could not answer just now. Try again in a moment.');
  }
}
