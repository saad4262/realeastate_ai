'use server';

import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import {
  markThreadRead,
  MailError,
  mailDepsFromEnv,
  pullReceivedMail,
  retryFailedMessage,
  sendContactEmail,
  sendThreadReply,
  type MailDeps,
} from '@repo/core/mail';
import { getConsoleDb } from './db';
import { loadListingActor } from './load-actor';
import { requireActionUserId } from './auth-account';

export type MailActionResult =
  | { ok: true; status: 'sent' | 'failed'; error: string | null }
  | { ok: false; error: string };

/**
 * The conversation actions (docs/adr/0016).
 *
 * The actor is rebuilt from the session on every call — with listing links,
 * because an agent may answer an unassigned lead from their own listing, which
 * can() can only decide if it knows their listings. Every decision is made in
 * packages/core; this layer translates the outcome for the composer.
 */
async function actor() {
  // Outside any try: a missing session must read as signed out, not as a
  // message that failed to send.
  const userId = await requireActionUserId();
  const loaded = await loadListingActor(userId);
  if (!loaded) throw new MailError('forbidden', 'Database is not configured.');
  return loaded;
}

function mailDeps(): MailDeps | null {
  return mailDepsFromEnv();
}

function refresh() {
  revalidatePath('/inbox');
  revalidatePath('/my-inbox');
}

function failure(err: unknown, fallback: string): MailActionResult {
  if (err instanceof MailError) return { ok: false, error: err.message };
  console.error('[mail] action failed', err);
  return { ok: false, error: fallback };
}

/** Send a reply. The message is recorded first; a send that fails stays on screen, marked. */
export async function sendReplyAction(threadId: string, body: string): Promise<MailActionResult> {
  const who = await actor();
  const deps = mailDeps();
  if (!deps) return { ok: false, error: 'Email is not set up on this server yet, so nothing was sent.' };

  try {
    const outcome = await sendThreadReply(getConsoleDb(), deps, who, threadId, { body });
    refresh();
    return { ok: true, status: outcome.status, error: outcome.error };
  } catch (err) {
    return failure(err, 'Could not send the message');
  }
}

export type NewEmailResult =
  | { ok: true; threadId: string; status: 'sent' | 'failed'; error: string | null }
  | { ok: false; error: string };

/**
 * A NEW email to a contact (ADR 0035 §1). Core decides who may, and refuses
 * an archived, unsubscribed or address-less contact and an over-limit day; the
 * conversation it opens holds the message either way — sent, or failed with a
 * Retry.
 */
export async function sendNewEmailAction(contactId: string, subject: string, body: string): Promise<NewEmailResult> {
  const who = await actor();
  const deps = mailDeps();
  if (!deps) return { ok: false, error: 'Email is not set up on this server yet, so nothing was sent.' };
  try {
    const outcome = await sendContactEmail(getConsoleDb(), deps, who, contactId, { subject, body });
    refresh();
    revalidatePath('/customers', 'layout');
    revalidatePath('/my-contacts', 'layout');
    return { ok: true, threadId: outcome.threadId, status: outcome.status, error: outcome.error };
  } catch (err) {
    if (err instanceof MailError) return { ok: false, error: err.message };
    console.error('[mail] new email failed', err);
    return { ok: false, error: 'Could not send the email' };
  }
}

/** Try a failed send again. */
export async function retryMessageAction(messageId: string): Promise<MailActionResult> {
  const who = await actor();
  const deps = mailDeps();
  if (!deps) return { ok: false, error: 'Email is not set up on this server yet, so nothing was sent.' };

  try {
    const outcome = await retryFailedMessage(getConsoleDb(), deps, who, messageId);
    refresh();
    return { ok: true, status: outcome.status, error: outcome.error };
  } catch (err) {
    return failure(err, 'Could not send the message');
  }
}

/**
 * "Send from the platform address instead" on a message Gmail did not send
 * (ADR 0026 §7): the person's own choice — the From never changes silently.
 */
export async function sendFromPlatformAction(messageId: string): Promise<MailActionResult> {
  const who = await actor();
  const deps = mailDeps();
  if (!deps) return { ok: false, error: 'Email is not set up on this server yet, so nothing was sent.' };

  try {
    const outcome = await retryFailedMessage(getConsoleDb(), deps, who, messageId, { platformOnly: true });
    refresh();
    return { ok: true, status: outcome.status, error: outcome.error };
  } catch (err) {
    return failure(err, 'Could not send the message');
  }
}

/**
 * "I have opened this." Called by the reader once it is on screen, never by a
 * page render: a prefetched link must not mark a thread read that nobody saw.
 */
export async function markThreadReadAction(threadId: string): Promise<{ ok: boolean }> {
  try {
    const who = await actor();
    await markThreadRead(getConsoleDb(), who, threadId);
    refresh();
    return { ok: true };
  } catch {
    // A badge that stays lit is the whole cost of failing here.
    return { ok: false };
  }
}

/**
 * Pull new mail from Resend (core `pullReceivedMail`). The inbox calls this
 * while it is open, so a buyer's Gmail reply shows up without a webhook — which
 * is what makes inbound work on localhost and before DNS is set up.
 *
 * At most once per 10 s per server process however many tabs ask: a ceiling on
 * requests to Resend, not a security control. Any signed-in console member may
 * trigger it; it reads nothing back to them except a count, and what it stores
 * is shown only through can().
 */
const LAST_PULL = ((globalThis as { __mailPull?: { at: number } }).__mailPull ??= { at: 0 });

export async function syncMailAction(): Promise<{ stored: number; configured: boolean }> {
  await requireActionUserId();
  if (Date.now() - LAST_PULL.at < 10_000) return { stored: 0, configured: true };
  LAST_PULL.at = Date.now();

  const result = await pullReceivedMail({ db: getConsoleDb });
  if (!result.ok) return { stored: 0, configured: result.reason !== 'not_configured' };
  if (result.followUp) after(result.followUp);
  if (result.stored > 0) refresh();
  return { stored: result.stored, configured: true };
}
