'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { after } from 'next/server';
import { mailerFromEnv, noticeMailFromEnv } from '@repo/core/email';
import {
  confirmEmailVerification,
  MailError,
  mailDepsFromEnv,
  notifyThreadReply,
  pullReceivedMail,
  replyAsCustomer,
  sendEmailVerification,
  verifySecretFromEnv,
} from '@repo/core/mail';
import { ensureConsumerAccount } from '../../../lib/account';
import { getWebDb } from '../../../lib/db';

/**
 * Proving the account's address before its email-matched messages show
 * (docs/adr/0016). Plain-form actions that end in a redirect, so both work
 * with JavaScript off — the same as sign-in.
 *
 * The identity is the session, never a form field: the link goes only to the
 * signed-in account's own address, and is only accepted by that account.
 */

/**
 * One send per account per minute.
 *
 * An in-process counter, and honestly only that (ARCHITECTURE § 9): a ceiling
 * on accidental volume — a double-click, a reload — not a security control.
 * The address it can reach is the account's own, so the worst it bounds is
 * somebody who registered a stranger's address pressing the button repeatedly.
 */
const RECENT = ((globalThis as { __verifySends?: Map<string, number> }).__verifySends ??= new Map<string, number>());
const GAP_MS = 60_000;

export async function sendVerificationAction(): Promise<void> {
  const who = await ensureConsumerAccount();
  if (!who) redirect('/login?next=%2Faccount%2Fmessages');

  const last = RECENT.get(who.id) ?? 0;
  if (Date.now() - last < GAP_MS) redirect('/account/messages?verify=wait');

  const secret = verifySecretFromEnv();
  let mailer: ReturnType<typeof mailerFromEnv> | null = null;
  try {
    mailer = mailerFromEnv();
  } catch {
    mailer = null;
  }
  if (!secret || !mailer || !who.email) redirect('/account/messages?verify=unavailable');

  RECENT.set(who.id, Date.now());
  let ok = false;
  try {
    ok = await sendEmailVerification(
      mailer,
      { userId: who.id, email: who.email },
      { secret, baseUrl: process.env.NEXT_PUBLIC_WEB_URL ?? 'http://web.lvh.me:3000' },
    );
  } catch (err) {
    console.error('[mail] verification send failed', err instanceof Error ? err.message : err);
  }
  redirect(ok ? '/account/messages?verify=sent' : '/account/messages?verify=failed');
}

export async function confirmVerificationAction(form: FormData): Promise<void> {
  const who = await ensureConsumerAccount();
  const token = String(form.get('t') ?? '');
  const rawThread = String(form.get('thread') ?? '');
  const thread = /^[0-9a-f-]{36}$/i.test(rawThread) ? rawThread : null;
  if (!who) {
    redirect(
      `/login?next=${encodeURIComponent(`/account/messages/verify?t=${token}${thread ? `&thread=${thread}` : ''}`)}`,
    );
  }

  const secret = verifySecretFromEnv();
  if (!secret) redirect('/account/messages?verify=unavailable');

  try {
    await confirmEmailVerification(getWebDb(), { userId: who.id, email: who.email ?? '' }, token, secret);
  } catch (err) {
    if (err instanceof MailError) redirect('/account/messages?verify=expired');
    throw err;
  }
  redirect(thread ? `/account/messages/${thread}` : '/account/messages?verify=done');
}

/**
 * The buyer answers on the website. Recorded as their message on the thread
 * (core `replyAsCustomer`), then the agency is told — the same notice an email
 * reply sends — after the response.
 *
 * Ten a minute per account, in-process: a ceiling on accidents, not a control.
 */
const REPLIES = ((globalThis as { __webReplies?: Map<string, number[]> }).__webReplies ??= new Map<string, number[]>());

export type ReplyResult = { ok: true } | { ok: false; error: string };

export async function replyAction(threadId: string, body: string): Promise<ReplyResult> {
  const who = await ensureConsumerAccount();
  if (!who) return { ok: false, error: 'Sign in again to reply.' };

  const now = Date.now();
  const recent = (REPLIES.get(who.id) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= 10) return { ok: false, error: 'That is a lot of messages at once — wait a minute.' };
  REPLIES.set(who.id, [...recent, now]);

  try {
    const db = getWebDb();
    const sent = await replyAsCustomer(db, { userId: who.id, email: who.email ?? '' }, threadId, { body });
    const deps = mailDepsFromEnv();
    const urls = noticeMailFromEnv()?.urls;
    if (deps && urls) {
      after(async () => {
        try {
          await notifyThreadReply(db, { ...deps, urls }, sent.threadId, sent.messageId);
        } catch (err) {
          console.error('[mail] website reply notice failed', err instanceof Error ? err.message : err);
        }
      });
    }
    revalidatePath(`/account/messages/${sent.threadId}`);
    revalidatePath('/account/messages');
    return { ok: true };
  } catch (err) {
    if (err instanceof MailError) return { ok: false, error: err.message };
    console.error('[mail] website reply failed', err);
    return { ok: false, error: 'Could not send that just now. Please try again.' };
  }
}

/** Pull new mail while a buyer's messages are open — the console's sync, same throttle idea. */
const LAST_PULL = ((globalThis as { __webMailPull?: { at: number } }).__webMailPull ??= { at: 0 });

export async function syncMailAction(): Promise<{ stored: number }> {
  const who = await ensureConsumerAccount();
  if (!who) return { stored: 0 };
  if (Date.now() - LAST_PULL.at < 10_000) return { stored: 0 };
  LAST_PULL.at = Date.now();
  const result = await pullReceivedMail({ db: getWebDb });
  if (!result.ok) return { stored: 0 };
  if (result.followUp) after(result.followUp);
  return { stored: result.stored };
}
