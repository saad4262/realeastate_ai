'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { AutomationError, createAutomation, deleteAutomation, setAutomationStatus, undoAutomationEvent } from '@repo/core/automation';
import { ensureConsumerAccount } from '../../../lib/account';
import { getWebDb } from '../../../lib/db';

/**
 * Automation's page writes (ADR 0080, C8 decisions 8–11). The actor from the session; `can()` and the fixed lists decide
 * in core. Creating needs Automation on; pausing, deleting and Undo never do.
 */

const str = (v: FormDataEntryValue | null) => (v === null || String(v).trim() === '' ? undefined : String(v).trim());

export async function createAutomationAction(form: FormData): Promise<void> {
  const user = await ensureConsumerAccount();
  if (!user) redirect('/login?next=/account/automations');
  const trigger = str(form.get('trigger'));
  const input = {
    trigger,
    scope: trigger === 'new_match' ? 'search' : str(form.get('scope')),
    ...(trigger === 'new_match' && str(form.get('searchId')) ? { searchId: str(form.get('searchId')) } : {}),
    action: str(form.get('action')),
    delivery: str(form.get('delivery')) ?? 'daily',
    timeZone: str(form.get('timeZone')) ?? 'Australia/Sydney',
  };
  try {
    await createAutomation(getWebDb(), { userId: user.id }, input);
  } catch (err) {
    const message = err instanceof AutomationError ? err.message : 'That automation could not be saved. Try again.';
    if (!(err instanceof AutomationError)) console.error('[automation] create failed', err);
    redirect(`/account/automations?error=${encodeURIComponent(message)}`);
  }
  revalidatePath('/account/automations');
  redirect('/account/automations');
}

async function own(form: FormData, fn: (actor: { userId: string }, id: string) => Promise<void>): Promise<void> {
  const user = await ensureConsumerAccount();
  if (!user) redirect('/login?next=/account/automations');
  try {
    await fn({ userId: user.id }, String(form.get('id') ?? ''));
  } catch (err) {
    if (!(err instanceof AutomationError)) console.error('[automation] change failed', err);
  }
  revalidatePath('/account/automations');
  revalidatePath('/account/shortlist');
}

export async function pauseAutomationAction(form: FormData) {
  await own(form, (a, id) => setAutomationStatus(getWebDb(), a, id, 'paused'));
}
export async function resumeAutomationAction(form: FormData) {
  await own(form, (a, id) => setAutomationStatus(getWebDb(), a, id, 'active'));
}
export async function deleteAutomationAction(form: FormData) {
  await own(form, (a, id) => deleteAutomation(getWebDb(), a, id));
}
export async function undoAutomationAction(form: FormData) {
  await own(form, (a, id) => undoAutomationEvent(getWebDb(), a, id));
}
