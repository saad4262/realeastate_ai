'use server';

import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { noticeMailFromEnv } from '@repo/core/email';
import { notifyNewLead } from '@repo/core/leads';
import { mailDepsFromEnv, notifyThreadReply } from '@repo/core/mail';
import { requireDraftSecret, ScheduleError } from '@repo/core/schedules';
import { AgentMessageError, sendGuideMessage } from '@repo/core/agent-messages';
import { acceptTaskProposal } from '@repo/core/tasks';
import { acceptAutomationProposal, AutomationError } from '@repo/core/automation';
import { ensureAppUser } from '@repo/core/identity';
import { ensureConsumerAccount } from './account';
import { getWebDb } from './db';
import { verifiedWebUserForAction } from './session';

export type ActingResult = { ok: true; href?: string } | { ok: false; error: string };

/**
 * The buttons on the guide's C8 cards (ADR 0080, decisions 1, 5, 9, 12). The browser sends the signed card and, for a
 * message, the text as the buyer left it — never a user id, an agency or a listing outside the token. Whose it is comes
 * from the session; `can()` and the skill switch decide inside core. These are the only places anything is sent or
 * saved for a C8 card.
 */

/**
 * The signed-in buyer. The chat is inside the middleware matcher; a listing's enquiry form is not (its page has no
 * session by design), so the submit verifies the session itself — the enquiry action's own way (lib/session.ts).
 */
async function actingUser() {
  const known = await ensureConsumerAccount();
  if (known) return known;
  const verified = await verifiedWebUserForAction();
  if (!verified) return null;
  await ensureAppUser(getWebDb(), { id: verified.id, email: verified.email ?? '', ...(verified.label ? { name: verified.label } : {}) });
  return verified;
}

export async function sendGuideMessageAction(token: string, text: string): Promise<ActingResult> {
  const user = await actingUser();
  if (!user) return { ok: false, error: 'Sign in to send a message to the agent.' };
  let secret: string;
  try {
    secret = requireDraftSecret();
  } catch {
    return { ok: false, error: 'Messages cannot be sent from here just now. Use the enquiry form on the listing.' };
  }
  const db = getWebDb();
  try {
    const sent = await sendGuideMessage(db, { userId: user.id }, { token: String(token), text: String(text) }, { secret });
    // Tell the agency after the response, outside the write — the existing doors' own notices (ADR 0039, ADR 0016).
    after(async () => {
      try {
        if (sent.kind === 'enquiry') {
          const mail = noticeMailFromEnv();
          if (mail) await notifyNewLead(db, mail, sent.leadId);
        } else {
          const deps = mailDepsFromEnv();
          const urls = noticeMailFromEnv()?.urls;
          if (deps && urls) await notifyThreadReply(db, { ...deps, urls }, sent.threadId, sent.messageId);
        }
      } catch (err) {
        console.error('[agent-ai] the agency notice failed', err instanceof Error ? err.message : err);
      }
    });
    revalidatePath('/account/messages');
    return { ok: true, href: sent.kind === 'reply' ? `/account/messages/${sent.threadId}` : '/account/messages' };
  } catch (err) {
    if (err instanceof AgentMessageError) return { ok: false, error: err.message };
    console.error('[agent-ai] send failed', err);
    return { ok: false, error: 'Could not send that just now. Please try again.' };
  }
}

export async function acceptTaskAction(token: string): Promise<ActingResult> {
  const user = await ensureConsumerAccount();
  if (!user) return { ok: false, error: 'Sign in to start this task.' };
  try {
    const t = await acceptTaskProposal(getWebDb(), { userId: user.id }, String(token), requireDraftSecret());
    revalidatePath('/account/tasks');
    return { ok: true, href: `/account/tasks/${t.id}` };
  } catch (err) {
    if (err instanceof ScheduleError) return { ok: false, error: err.message };
    return { ok: false, error: 'That could not be started. Try asking the guide again.' };
  }
}

export async function acceptAutomationAction(token: string): Promise<ActingResult> {
  const user = await ensureConsumerAccount();
  if (!user) return { ok: false, error: 'Sign in to start this automation.' };
  try {
    await acceptAutomationProposal(getWebDb(), { userId: user.id }, String(token), requireDraftSecret());
    revalidatePath('/account/automations');
    return { ok: true, href: '/account/automations' };
  } catch (err) {
    if (err instanceof AutomationError) return { ok: false, error: err.message };
    return { ok: false, error: 'That could not be started. Try asking the guide again.' };
  }
}
