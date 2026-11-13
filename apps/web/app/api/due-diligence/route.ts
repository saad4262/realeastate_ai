import { unstable_cache } from 'next/cache';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { consumerSkillBlocks, consumerSkillOffMessage } from '@repo/core/consumer-skills';
import { dueDiligenceAssist, DueDiligenceError } from '@repo/core/due-diligence';
import { dueDiligenceWriterFromEnv } from '@repo/ai/due-diligence';
import { LISTINGS_TAG } from '../../../lib/cached';
import { aiBudgetAllows } from '@repo/core/ai-budget';
import { getWebDb } from '../../../lib/db';
import { currentWebUser } from '../../../lib/session';

/** postgres.js opens raw sockets, so this cannot run on the edge runtime. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Due-Diligence AI's summary and questions (ADR 0080, C2). Plumbing only (#10): the address is decided in core
 * (`publicSubject` — a public listing, or an address with public history; the browser names an id and nothing
 * else), the model is behind packages/ai (#3), and core checks every line before it comes back (#4).
 *
 * The same answer for the same public records, so it is kept for an hour under the listings tag: a price edit
 * or a sale clears it with everything else. Not saved anywhere (decision 3); a failure is never cached.
 *
 * The rate limits below are a ceiling on accidental cost, not a security control — see /api/chat.
 */
const LIMIT = 5;
const WINDOW_MS = 60_000;
type Bucket = { count: number; resetAt: number };
const BUCKETS = Symbol.for('@repo/web.due-diligence-rate-limit');
const DAILY = Symbol.for('@repo/web.due-diligence-daily-cap');

function overLimit(request: NextRequest): boolean {
  const g = globalThis as unknown as Record<symbol, Map<string, Bucket> | undefined>;
  const map = (g[BUCKETS] ??= new Map());
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown';
  const now = Date.now();
  const current = map.get(ip);
  if (!current || current.resetAt < now) {
    map.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    if (map.size > 5000) for (const [key, b] of map) if (b.resetAt < now) map.delete(key);
    return false;
  }
  current.count += 1;
  return current.count > LIMIT;
}

function overDailyCap(): boolean {
  const cap = Number(process.env.AI_DUE_DILIGENCE_DAILY_CAP ?? 500);
  const g = globalThis as unknown as Record<symbol, Bucket | undefined>;
  const now = Date.now();
  const current = g[DAILY];
  if (!current || current.resetAt < now) {
    g[DAILY] = { count: 1, resetAt: now + 86_400_000 };
    return false;
  }
  current.count += 1;
  return current.count > cap;
}

const bodySchema = z.union([z.object({ listingId: z.string().uuid() }).strict(), z.object({ propertyId: z.string().uuid() }).strict()]);

const fail = (status: number, error: string) => NextResponse.json({ error }, { status });

export async function POST(request: NextRequest) {
  if (overLimit(request)) return fail(429, 'Too many requests. Wait a moment.');
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail(400, 'That request could not be understood.');

  const db = getWebDb();
  const user = await currentWebUser();
  const block = (await consumerSkillBlocks(db, user ? { userId: user.id } : null)).get('due_diligence');
  if (block) return fail(403, consumerSkillOffMessage('due_diligence', block));
  if (overDailyCap()) return fail(503, 'The AI is resting for today. The records and the checklist still apply.');
  // The platform's AI budget (AI_DAILY_BUDGET_USD over ai_run): shared by every instance, unlike the cap above.
  if (!(await aiBudgetAllows(db))) return fail(503, 'The AI is resting for today. The records and the checklist still apply.');

  const ask = parsed.data;
  const key = 'listingId' in ask ? `l:${ask.listingId}` : `p:${ask.propertyId}`;
  try {
    const run = unstable_cache(async () => dueDiligenceAssist(db, dueDiligenceWriterFromEnv(db), ask), ['due-diligence-ai', key], { tags: [LISTINGS_TAG], revalidate: 3600 });
    const out = await run();
    return NextResponse.json({ summary: out.summary, questions: out.questions });
  } catch (err) {
    if (err instanceof DueDiligenceError) return fail(err.code === 'not_found' ? 404 : 503, err.message);
    console.error('[due-diligence] failed', err);
    return fail(503, 'The AI could not answer just now. Try again in a moment.');
  }
}
