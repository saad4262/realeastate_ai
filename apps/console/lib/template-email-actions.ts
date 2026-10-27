'use server';

import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import {
  approveBatch,
  cancelBatch,
  createTemplate,
  prepareBatch,
  retireTemplate,
  retryFailed,
  saveContactFilter,
  sendBatch,
  TemplateEmailError,
  templateSendDepsFromEnv,
  updateTemplate,
  type TemplateInput,
} from '@repo/core/template-email';
import { emailLimitsFromEnv } from '@repo/core/email';
import { holderOf, isSkillOn, skillOffMessage } from '@repo/core/skill-switches';
import type { Actor } from '@repo/core/permissions';
import { getConsoleDb } from './db';
import { loadActor } from './load-actor';
import { requireActionUserId } from './auth-account';

/**
 * Template email actions (docs/adr/0022). The actor is rebuilt from the
 * session; can() decides inside packages/core. Nothing here sends on its own:
 * only "Approve & Send" sends, and only the batch it was pressed on.
 */

export type TemplateEmailResult = { ok: true; id?: string; note?: string } | { ok: false; error: string };

async function actor() {
  const userId = await requireActionUserId();
  const loaded = await loadActor(userId);
  if (!loaded) throw new TemplateEmailError('forbidden', 'Database is not configured.');
  return loaded;
}

function refresh() {
  revalidatePath('/bulk-email', 'layout');
  revalidatePath('/my-bulk-email', 'layout');
}

function failure(err: unknown, fallback: string): TemplateEmailResult {
  if (err instanceof TemplateEmailError) return { ok: false, error: err.message };
  console.error('[template-email] action failed', err instanceof Error ? err.message : err);
  return { ok: false, error: fallback };
}

async function run(fn: () => Promise<TemplateEmailResult>, fallback: string): Promise<TemplateEmailResult> {
  try {
    const r = await fn();
    refresh();
    return r;
  } catch (err) {
    return failure(err, fallback);
  }
}

export async function createTemplateAction(input: TemplateInput): Promise<TemplateEmailResult> {
  const who = await actor();
  return run(async () => ({ ok: true, id: (await createTemplate(getConsoleDb(), who, input)).id }), 'Could not save the template');
}

export async function updateTemplateAction(id: string, input: TemplateInput): Promise<TemplateEmailResult> {
  const who = await actor();
  return run(async () => (await updateTemplate(getConsoleDb(), who, id, input), { ok: true, id }), 'Could not save the template');
}

/** Retire a template — its author or an admin (ADR 0043: there is no approval step left). */
export async function retireTemplateAction(id: string): Promise<TemplateEmailResult> {
  const who = await actor();
  return run(async () => (await retireTemplate(getConsoleDb(), who, id), { ok: true, id }), 'Could not retire the template');
}

export async function saveFilterAction(name: string, query: Record<string, string | undefined>): Promise<TemplateEmailResult> {
  const who = await actor();
  return run(async () => ({ ok: true, id: (await saveContactFilter(getConsoleDb(), who, name, query)).id }), 'Could not save the filter');
}

/**
 * Bulk email switched off in Skills (ADR 0058) stops this page preparing or sending a batch. Only the
 * page: a template the assistant or a workflow sends is the Template email skill's, not this one's.
 */
async function bulkEmailOff(who: Actor): Promise<TemplateEmailResult | null> {
  return (await isSkillOn(getConsoleDb(), who, 'bulk_email')) ? null : { ok: false, error: skillOffMessage('bulk_email', holderOf(who.membershipRole)) };
}

export async function prepareBatchAction(templateId: string, filterId: string): Promise<TemplateEmailResult> {
  const who = await actor();
  const off = await bulkEmailOff(who);
  if (off) return off;
  return run(
    async () => ({ ok: true, id: (await prepareBatch(getConsoleDb(), who, { templateId, filterId }, emailLimitsFromEnv())).id }),
    'Could not prepare the batch',
  );
}

/**
 * Approve & Send. The claim happens here, once; the sending runs after the
 * response so the page can show progress. A second click finds the batch
 * already claimed and starts nothing new.
 */
export async function approveAndSendAction(batchId: string): Promise<TemplateEmailResult> {
  const who = await actor();
  const off = await bulkEmailOff(who);
  if (off) return off;
  const sendDeps = templateSendDepsFromEnv();
  if (!sendDeps.ok) return { ok: false, error: `${sendDeps.reason} Nothing was sent.` };
  return run(async () => {
    const { result } = await approveBatch(getConsoleDb(), who, batchId, sendDeps.deps.limits);
    if (result === 'approved') {
      after(() =>
        sendBatch(getConsoleDb(), sendDeps.deps, batchId).catch((err: unknown) =>
          console.error(`[template-email] batch ${batchId} send failed`, err instanceof Error ? err.message : err),
        ),
      );
    }
    return { ok: true, id: batchId, note: result === 'approved' ? 'Sending started' : 'Already approved — nothing new was sent' };
  }, 'Could not approve the batch');
}

export async function cancelBatchAction(batchId: string): Promise<TemplateEmailResult> {
  const who = await actor();
  return run(async () => (await cancelBatch(getConsoleDb(), who, batchId), { ok: true, id: batchId }), 'Could not cancel the batch');
}

/** Retry only the failed recipients — re-delivering their existing message. */
export async function retryFailedAction(batchId: string): Promise<TemplateEmailResult> {
  const who = await actor();
  const sendDeps = templateSendDepsFromEnv();
  if (!sendDeps.ok) return { ok: false, error: sendDeps.reason };
  return run(async () => {
    const { requeued } = await retryFailed(getConsoleDb(), who, batchId);
    if (requeued) {
      after(() =>
        sendBatch(getConsoleDb(), sendDeps.deps, batchId).catch((err: unknown) =>
          console.error(`[template-email] batch ${batchId} retry failed`, err instanceof Error ? err.message : err),
        ),
      );
    }
    return { ok: true, id: batchId, note: requeued ? `Retrying ${requeued}` : 'Nothing to retry' };
  }, 'Could not retry');
}
