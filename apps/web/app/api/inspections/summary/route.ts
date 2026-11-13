import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { InspectionSummaryError, runInspectionSummary } from '@repo/core/inspections';
import { inspectionSummaryWriterFromEnv } from '@repo/ai/inspections';
import { consumerSkillBlocks, consumerSkillOffMessage } from '@repo/core/consumer-skills';
import { ensureConsumerAccount } from '../../../../lib/account';
import { aiBudgetAllows } from '@repo/core/ai-budget';
import { getWebDb } from '../../../../lib/db';
import { rateLimiter } from '../../../../lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * "Summarise my day" (ADR 0080, C6 decision 9). Plumbing only (#10): core reads the buyer's OWN notes under `can()`,
 * builds the records and checks every line; the model is behind packages/ai (#3). It goes only to the buyer, with
 * its label, and is not stored or cached — it is written again on request.
 */
const limits = rateLimiter('inspection-summary', { perMinute: 4, dailyCapEnv: 'AI_INSPECTION_SUMMARY_DAILY_CAP', dailyCapDefault: 300 });
const bodySchema = z.object({ listingIds: z.array(z.string().uuid()).min(1).max(8).optional() }).strict();
const fail = (status: number, error: string) => NextResponse.json({ error }, { status });

export async function POST(request: NextRequest) {
  if (limits.overLimit(request)) return fail(429, 'Too many requests. Wait a moment.');
  const user = await ensureConsumerAccount();
  if (!user) return fail(401, 'Sign in to summarise your notes.');
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail(400, 'That request could not be understood.');
  const db = getWebDb();
  const actor = { userId: user.id };
  const block = (await consumerSkillBlocks(db, actor)).get('inspection_notes');
  if (block) return fail(403, consumerSkillOffMessage('inspection_notes', block));
  if (limits.overDailyCap()) return fail(503, 'The AI is resting for today. Your notes are all here.');
  // The platform's AI budget (AI_DAILY_BUDGET_USD over ai_run): shared by every instance, unlike the cap above.
  if (!(await aiBudgetAllows(db))) return fail(503, 'The AI is resting for today. Your notes are all here.');
  try {
    return NextResponse.json(await runInspectionSummary(db, actor, inspectionSummaryWriterFromEnv(db), parsed.data.listingIds), { headers: { 'cache-control': 'private, no-store' } });
  } catch (err) {
    if (err instanceof InspectionSummaryError) return fail(err.code === 'not_found' ? 404 : 503, err.message);
    console.error('[inspection-summary] failed', err);
    return fail(503, 'The summary could not be written just now. Try again in a moment.');
  }
}
