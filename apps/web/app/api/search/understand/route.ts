import { unstable_cache } from 'next/cache';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { MAX_UNDERSTAND_CHARS, understandSearch } from '@repo/core/listings/url';
import { searchUnderstanderFromEnv } from '@repo/ai/search-understand';
import { aiBudgetAllows } from '@repo/core/ai-budget';
import { apiError } from '@repo/core/http/api-error';
import { getWebDb } from '../../../../lib/db';
import { rateLimiter } from '../../../../lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Smart search's AI half (ADR 0101): a sentence the rules could not finish, read into the search's own fields.
 * Plumbing only (#10): core checks every number and phrase against the sentence (verifyUnderstood); the model is
 * behind packages/ai (#3). Public and anonymous, like the search box itself; the same sentence is answered from
 * cache for a day. The box falls back to the rules on any error, so every failure here is a plain status.
 */
const limits = rateLimiter('search-understand', { perMinute: 10, dailyCapEnv: 'AI_SEARCH_UNDERSTAND_DAILY_CAP', dailyCapDefault: 2000 });
const bodySchema = z.object({ text: z.string().trim().min(3).max(MAX_UNDERSTAND_CHARS) }).strict();
/** A search box that waits longer than this for a model is worse than one that uses what the rules read. */
const TIMEOUT_MS = 4000;

export async function POST(request: NextRequest) {
  if (limits.overLimit(request)) return apiError(429, 'Too many requests. Wait a moment.');
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError(400, 'That request could not be understood.');

  const db = getWebDb();
  const understander = searchUnderstanderFromEnv(db);
  if (!understander) return apiError(503, 'Smart search is off. The filters still work.');
  if (limits.overDailyCap()) return apiError(503, 'Smart search is resting for today. The filters still work.');
  // The platform's AI budget (AI_DAILY_BUDGET_USD over ai_run): shared by every instance, unlike the cap above.
  if (!(await aiBudgetAllows(db))) return apiError(503, 'Smart search is resting for today. The filters still work.');

  const sentence = parsed.data.text.replace(/\s+/g, ' ');
  try {
    const run = unstable_cache(() => understandSearch(sentence, understander), ['search-understand', sentence.toLowerCase()], { revalidate: 86_400 });
    const answer = await Promise.race([
      run(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS)),
    ]);
    return NextResponse.json(answer);
  } catch (err) {
    console.error('[search-understand] failed', err instanceof Error ? err.message : err);
    return apiError(503, 'Smart search could not answer just now. The filters still work.');
  }
}
