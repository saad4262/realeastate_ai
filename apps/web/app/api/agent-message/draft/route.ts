import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { AgentMessageError, draftAgentMessage } from '@repo/core/agent-messages';
import { agentMessageWriterFromEnv } from '@repo/ai/acting';
import { requireDraftSecret } from '@repo/core/schedules';
import { ensureConsumerAccount } from '../../../../lib/account';
import { aiBudgetAllows } from '@repo/core/ai-budget';
import { getWebDb } from '../../../../lib/db';
import { rateLimiter } from '../../../../lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * "Draft with AI" in a listing's enquiry form (ADR 0080, C8 decisions 1–2). Plumbing only (#10): core checks the
 * session, the switch and that the listing is public, hands the writer (packages/ai, #3) only the buyer's own words and
 * the listing's facts, and checks the draft. The answer is a draft and a signed token — nothing is sent from here.
 */
const limits = rateLimiter('agent-message-draft', { perMinute: 6, dailyCapEnv: 'AI_AGENT_MESSAGE_DAILY_CAP', dailyCapDefault: 500 });
const bodySchema = z.object({ listingId: z.string().uuid(), words: z.string().trim().min(3).max(2000) }).strict();
const fail = (status: number, error: string) => NextResponse.json({ error }, { status });

export async function POST(request: NextRequest) {
  if (limits.overLimit(request)) return fail(429, 'Too many requests. Wait a moment.');
  const user = await ensureConsumerAccount();
  if (!user) return fail(401, 'Sign in to have the guide draft your message.');
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail(400, 'Write a few words about what you want to ask first.');
  if (limits.overDailyCap()) return fail(503, 'The AI is resting for today. You can still write your message yourself.');
  let secret: string;
  try {
    secret = requireDraftSecret();
  } catch {
    return fail(503, 'Drafting is not available on this site just now.');
  }
  const db = getWebDb();
  // The platform's AI budget (AI_DAILY_BUDGET_USD over ai_run): shared by every instance, unlike the cap above it.
  if (!(await aiBudgetAllows(db))) return fail(503, 'The AI is resting for today. You can still write your message yourself.');
  try {
    const d = await draftAgentMessage(db, { userId: user.id }, { listingId: parsed.data.listingId, buyerWords: parsed.data.words, latest: parsed.data.words }, { writer: agentMessageWriterFromEnv(db), secret });
    return NextResponse.json({ text: d.text, token: d.token, agencyName: d.agencyName, sentToday: d.sentToday, perDay: d.perDay, source: d.source }, { headers: { 'cache-control': 'private, no-store' } });
  } catch (err) {
    if (err instanceof AgentMessageError) return fail(err.code === 'not_found' ? 404 : 403, err.message);
    console.error('[agent-ai] draft failed', err);
    return fail(503, 'The draft could not be written just now. You can write it yourself.');
  }
}
