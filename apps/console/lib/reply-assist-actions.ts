'use server';

import { draftReply, ReplyAssistError, summarizeThread, type SummaryPoint } from '@repo/core/mail/reply-assist';
import { REPLY_TONES, type ReplyTone } from '@repo/core/mail/schema';
import { replyAssistFromEnv } from '@repo/ai/reply-assist';
import { getConsoleDb } from './db';
import { loadListingActor } from './load-actor';
import { requireActionUserId } from './auth-account';

/**
 * The inbox assistant (ADR 0062): a summary and a reply draft, each on a button. The actor is rebuilt from
 * the session; core checks the conversation, the AI email drafts switch and the budget, then the answer.
 * Nothing here sends — the draft goes into the reply box.
 */

export type SummaryResult = { ok: true; points: SummaryPoint[] } | { ok: false; error: string };
export type DraftResult = { ok: true; body: string; bracketed: number } | { ok: false; error: string };

async function actor() {
  const userId = await requireActionUserId();
  const loaded = await loadListingActor(userId);
  if (!loaded) throw new ReplyAssistError('unavailable', 'Database is not configured.');
  return loaded;
}

function failure(err: unknown, fallback: string): { ok: false; error: string } {
  if (err instanceof ReplyAssistError) return { ok: false, error: err.message };
  console.error('[inbox] assistant action failed', err instanceof Error ? err.message : err);
  return { ok: false, error: fallback };
}

export async function summarizeThreadAction(threadId: string): Promise<SummaryResult> {
  const who = await actor();
  try {
    const ai = replyAssistFromEnv(getConsoleDb());
    const { points } = await summarizeThread(getConsoleDb(), who, String(threadId), ai?.summarizer ?? null);
    return { ok: true, points };
  } catch (err) {
    return failure(err, 'The summary could not be written. Try again.');
  }
}

export async function draftReplyAction(threadId: string, tone: string, instruction: string): Promise<DraftResult> {
  const who = await actor();
  try {
    if (!(REPLY_TONES as readonly string[]).includes(tone)) return { ok: false, error: 'Pick a tone.' };
    const ai = replyAssistFromEnv(getConsoleDb());
    const r = await draftReply(getConsoleDb(), who, String(threadId), { tone: tone as ReplyTone, instruction: typeof instruction === 'string' ? instruction : null }, ai?.drafter ?? null);
    return { ok: true, body: r.body, bracketed: r.bracketed };
  } catch (err) {
    return failure(err, 'The reply could not be drafted. Try again, or write it yourself.');
  }
}
