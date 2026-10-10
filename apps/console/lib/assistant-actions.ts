'use server';

import { revalidatePath } from 'next/cache';
import {
  approveProposedAction,
  AssistantError,
  cancelProposedAction,
  getAssistantConversation,
  getProposedAction,
  listAssistantConversations,
  rejectProposedAction,
  type ConversationSummary,
  type ProposalView,
  type TurnView,
} from '@repo/core/assistant';
import { syncDepsFromEnv } from '@repo/core/appointments';
import { templateSendDepsFromEnv } from '@repo/core/template-email';
import { noticeMailFromEnv } from '@repo/core/email';
import { getConsoleDb } from './db';
import { loadActor } from './load-actor';
import { requireActionUserId } from './auth-account';

/**
 * The assistant panel's reads (docs/adr/0025). The actor is rebuilt from the
 * session; core decides — a conversation is its author's alone.
 */

async function actor() {
  const loaded = await loadActor(await requireActionUserId());
  if (!loaded) throw new AssistantError('forbidden', 'Database is not configured.');
  return loaded;
}

export async function listAssistantConversationsAction(): Promise<ConversationSummary[]> {
  return listAssistantConversations(getConsoleDb(), await actor());
}

export async function getAssistantConversationAction(
  id: string,
): Promise<{ ok: true; conversation: { id: string; title: string; turns: TurnView[]; full: boolean } } | { ok: false; error: string }> {
  try {
    return { ok: true, conversation: await getAssistantConversation(getConsoleDb(), await actor(), id) };
  } catch (err) {
    if (err instanceof AssistantError) return { ok: false, error: err.message };
    throw err;
  }
}

/**
 * The card buttons (ADR 0025 §1). These — not the model — run a proposed
 * action: the person's own session, then core's approve, which claims the card
 * once and re-checks can() through the screen's own function. Google Calendar /
 * Zoom are synced after it commits.
 */
type CardResult = { ok: true; card: ProposalView; message?: string } | { ok: false; error: string };

async function cardAfter(id: string, message?: string): Promise<CardResult> {
  const card = await getProposedAction(getConsoleDb(), await actor(), id);
  return { ok: true, card, ...(message ? { message } : {}) };
}

function cardFailure(err: unknown): CardResult {
  if (err instanceof AssistantError) return { ok: false, error: err.message };
  console.error('[assistant] card action failed', err);
  return { ok: false, error: 'That did not work. Please try again.' };
}

export async function getProposedActionAction(id: string): Promise<CardResult> {
  try {
    return await cardAfter(id);
  } catch (err) {
    return cardFailure(err);
  }
}

/**
 * Approve — now, or (Phase E, when switched on) at `runAtIso`, which the
 * person picked on the card. Core refuses a time more than 48 h ahead, past
 * the prepared email's life, or any time at all while scheduling is off.
 */
export async function approveProposedActionAction(id: string, runAtIso?: string | null): Promise<CardResult> {
  try {
    const send = templateSendDepsFromEnv();
    const mail = noticeMailFromEnv();
    const runAt = runAtIso ? new Date(runAtIso) : null;
    if (runAt && Number.isNaN(runAt.getTime())) return { ok: false, error: 'That time is not valid.' };
    const r = await approveProposedAction(
      getConsoleDb(),
      await actor(),
      id,
      {
        sync: syncDepsFromEnv(),
        templateSend: send.ok ? send.deps : null,
        // A team card (ADR 0033): a removal deletes calendar events like the Remove screen; a changed
        // invite's new link is emailed like Resend.
        offboard: { sync: syncDepsFromEnv() },
        inviteMail: mail ? { mailer: mail.mailer, agentUrl: mail.urls.agentUrl } : null,
      },
      new Date(),
      { runAt },
    );
    revalidatePath('/customers', 'layout');
    revalidatePath('/my-contacts', 'layout');
    revalidatePath('/bulk-email', 'layout');
    revalidatePath('/my-bulk-email', 'layout');
    revalidatePath('/team', 'layout');
    const message =
      r.outcome === 'already' ? 'This card was already approved.' : r.outcome === 'failed' ? r.error : undefined;
    // (A scheduled card's own line says when it runs.)
    return await cardAfter(id, message);
  } catch (err) {
    return cardFailure(err);
  }
}

export async function rejectProposedActionAction(id: string): Promise<CardResult> {
  try {
    await rejectProposedAction(getConsoleDb(), await actor(), id);
    return await cardAfter(id);
  } catch (err) {
    return cardFailure(err);
  }
}

export async function cancelProposedActionAction(id: string): Promise<CardResult> {
  try {
    await cancelProposedAction(getConsoleDb(), await actor(), id);
    return await cardAfter(id);
  } catch (err) {
    return cardFailure(err);
  }
}
