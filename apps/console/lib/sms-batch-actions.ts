'use server';

import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import {
  approveSmsBatch,
  cancelBatch,
  createTemplate,
  prepareSmsBatch,
  retireTemplate,
  retryFailed,
  sendSmsBatch,
  TemplateEmailError,
  updateTemplate,
  type SmsTemplateInput,
} from '@repo/core/template-email';
import { phoneDepsFromEnv } from '@repo/core/phone';
import { holderOf, isPairedSkillOn, skillOffMessage } from '@repo/core/skill-switches';
import type { Actor } from '@repo/core/permissions';
import { getConsoleDb } from './db';
import { loadActor } from './load-actor';
import { requireActionUserId } from './auth-account';

/**
 * Bulk SMS actions (ADR 0074 part 2). The actor is rebuilt from the session; can() and the five SMS rules
 * decide inside packages/core. Nothing here texts on its own: only "Approve & Send" does, for the batch it
 * was pressed on — and outside 9 am–8 pm the texts wait for the morning.
 */

export type SmsBatchResult = { ok: true; id?: string; note?: string } | { ok: false; error: string };

async function actor() {
  const userId = await requireActionUserId();
  const loaded = await loadActor(userId);
  if (!loaded) throw new TemplateEmailError('forbidden', 'Database is not configured.');
  return loaded;
}

function refresh() {
  revalidatePath('/bulk-sms', 'layout');
  revalidatePath('/my-bulk-sms', 'layout');
}

async function run(fn: () => Promise<SmsBatchResult>, fallback: string): Promise<SmsBatchResult> {
  try {
    const r = await fn();
    refresh();
    return r;
  } catch (err) {
    if (err instanceof TemplateEmailError) return { ok: false, error: err.message };
    console.error('[bulk-sms] action failed', err instanceof Error ? err.message : err);
    return { ok: false, error: fallback };
  }
}

/** "Bulk SMS" is a pair skill (ADR 0069 §4): the agency's switch AND this person's own. */
async function bulkSmsOff(who: Actor): Promise<SmsBatchResult | null> {
  if (!who.agencyId) return { ok: false, error: 'You are not in an agency.' };
  const on = await isPairedSkillOn(getConsoleDb(), who.agencyId, who.userId, who.membershipRole, 'bulk_sms');
  return on ? null : { ok: false, error: skillOffMessage('bulk_sms', holderOf(who.membershipRole)) };
}

const sendLater = (batchId: string) =>
  after(() =>
    sendSmsBatch(getConsoleDb(), { phone: phoneDepsFromEnv() }, batchId).catch((err: unknown) =>
      console.error(`[bulk-sms] batch ${batchId} send failed`, err instanceof Error ? err.message : err),
    ),
  );

export async function createSmsTemplateAction(input: SmsTemplateInput): Promise<SmsBatchResult> {
  const who = await actor();
  return run(async () => ({ ok: true, id: (await createTemplate(getConsoleDb(), who, { ...input, channel: 'sms' })).id }), 'Could not save the template');
}

export async function updateSmsTemplateAction(id: string, input: SmsTemplateInput): Promise<SmsBatchResult> {
  const who = await actor();
  return run(async () => (await updateTemplate(getConsoleDb(), who, id, { ...input, channel: 'sms' }), { ok: true, id }), 'Could not save the template');
}

export async function retireSmsTemplateAction(id: string): Promise<SmsBatchResult> {
  const who = await actor();
  return run(async () => (await retireTemplate(getConsoleDb(), who, id), { ok: true, id }), 'Could not retire the template');
}

export async function prepareSmsBatchAction(templateId: string, filterId: string): Promise<SmsBatchResult> {
  const who = await actor();
  const off = await bulkSmsOff(who);
  if (off) return off;
  return run(async () => ({ ok: true, id: (await prepareSmsBatch(getConsoleDb(), who, { templateId: String(templateId), filterId: String(filterId) })).id }), 'Could not prepare the texts');
}

/** "Text them" on a listing's Matching buyers tab: the picked buyers, with the listing's values frozen in. */
export async function prepareListingSmsAction(listingId: string, templateId: string, contactIds: string[]): Promise<SmsBatchResult> {
  const who = await actor();
  const off = await bulkSmsOff(who);
  if (off) return off;
  if (!Array.isArray(contactIds) || contactIds.some((id) => typeof id !== 'string')) return { ok: false, error: 'Pick the buyers to text.' };
  return run(
    async () => ({ ok: true, id: (await prepareSmsBatch(getConsoleDb(), who, { templateId: String(templateId), contactIds, listingId: String(listingId) })).id }),
    'Could not prepare the texts',
  );
}

/** Approve & Send: the claim, once. The texting runs after the response — or at 9 am, outside the hours. */
export async function approveSmsBatchAction(batchId: string): Promise<SmsBatchResult> {
  const who = await actor();
  const off = await bulkSmsOff(who);
  if (off) return off;
  return run(async () => {
    const now = new Date();
    const { result, sendsAt } = await approveSmsBatch(getConsoleDb(), who, batchId, now);
    if (result !== 'approved') return { ok: true, id: batchId, note: 'Already approved — nothing new was sent' };
    sendLater(batchId);
    const later = sendsAt.getTime() > now.getTime();
    return { ok: true, id: batchId, note: later ? 'Approved — the texts go at the start of sending hours' : 'Sending started' };
  }, 'Could not approve the texts');
}

export async function cancelSmsBatchAction(batchId: string): Promise<SmsBatchResult> {
  const who = await actor();
  return run(async () => (await cancelBatch(getConsoleDb(), who, batchId), { ok: true, id: batchId }), 'Could not cancel');
}

/** Retry only the failed people — the same text row is sent again, never a second one. */
export async function retrySmsFailedAction(batchId: string): Promise<SmsBatchResult> {
  const who = await actor();
  const off = await bulkSmsOff(who);
  if (off) return off;
  return run(async () => {
    const { requeued } = await retryFailed(getConsoleDb(), who, batchId);
    if (requeued) sendLater(batchId);
    return { ok: true, id: batchId, note: requeued ? `Retrying ${requeued}` : 'Nothing to retry' };
  }, 'Could not retry');
}
