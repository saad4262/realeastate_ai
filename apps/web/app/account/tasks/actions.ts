'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ScheduleError } from '@repo/core/schedules';
import { createTask, deleteTask, setTaskSkipEmpty, setTaskStatus, TASK_SECTIONS } from '@repo/core/tasks';
import { ensureConsumerAccount } from '../../../lib/account';
import { getWebDb } from '../../../lib/db';

/**
 * Tasks' page writes (ADR 0080, C8 decisions 5–7). The actor from the session only; core's strict schema reads the form
 * and `can()` decides. Creating needs Tasks on (core says so); pausing and deleting never do.
 */

const num = (v: FormDataEntryValue | null) => (v === null || String(v).trim() === '' ? undefined : Number(String(v).replace(/[^\d.]/g, '')));
const str = (v: FormDataEntryValue | null) => (v === null || String(v).trim() === '' ? undefined : String(v).trim());

export async function createTaskAction(form: FormData): Promise<void> {
  const user = await ensureConsumerAccount();
  if (!user) redirect('/login?next=/account/tasks');
  const [h, m] = (str(form.get('time')) ?? '07:00').split(':').map(Number);
  const input = {
    name: str(form.get('name')) ?? '',
    area: {
      ...(str(form.get('suburb')) ? { suburb: str(form.get('suburb')) } : {}),
      ...(str(form.get('state')) ? { state: str(form.get('state')) } : {}),
      channel: form.get('channel') === 'rent' ? 'rent' : 'sale',
      ...(num(form.get('priceTo')) ? { priceTo: num(form.get('priceTo')) } : {}),
      ...(num(form.get('bedrooms')) !== undefined ? { bedrooms: num(form.get('bedrooms')) } : {}),
      ...(str(form.get('type')) ? { propertyType: str(form.get('type')) } : {}),
    },
    sections: form.getAll('sections').map(String).filter((s) => (TASK_SECTIONS as readonly string[]).includes(s)),
    cadence: str(form.get('cadence')) ?? 'weekly',
    sendAtMinute: (h ?? 7) * 60 + (m ?? 0),
    ...(str(form.get('cadence')) === 'weekly' ? { sendOnWeekday: num(form.get('weekday')) ?? 1 } : {}),
    timezone: str(form.get('timezone')) ?? 'Australia/Sydney',
    skipEmpty: form.get('skipEmpty') === 'on',
  };
  let id: string;
  try {
    id = (await createTask(getWebDb(), { userId: user.id }, input)).id;
  } catch (err) {
    const message = err instanceof ScheduleError ? err.message : 'That task could not be saved. Try again.';
    if (!(err instanceof ScheduleError)) console.error('[tasks] create failed', err);
    redirect(`/account/tasks?error=${encodeURIComponent(message)}`);
  }
  revalidatePath('/account/tasks');
  redirect(`/account/tasks/${id}`);
}

async function own(form: FormData, fn: (actor: { userId: string }, id: string) => Promise<void>): Promise<void> {
  const user = await ensureConsumerAccount();
  if (!user) redirect('/login?next=/account/tasks');
  const id = String(form.get('id') ?? '');
  try {
    await fn({ userId: user.id }, id);
  } catch (err) {
    if (!(err instanceof ScheduleError)) console.error('[tasks] change failed', err);
  }
  revalidatePath('/account/tasks');
  revalidatePath(`/account/tasks/${id}`);
}

export async function pauseTaskAction(form: FormData) {
  await own(form, (a, id) => setTaskStatus(getWebDb(), a, id, 'paused'));
}
export async function resumeTaskAction(form: FormData) {
  await own(form, (a, id) => setTaskStatus(getWebDb(), a, id, 'active'));
}
export async function skipEmptyAction(form: FormData) {
  await own(form, (a, id) => setTaskSkipEmpty(getWebDb(), a, id, form.get('skipEmpty') === 'on'));
}
export async function deleteTaskAction(form: FormData) {
  await own(form, (a, id) => deleteTask(getWebDb(), a, id));
  redirect('/account/tasks');
}
