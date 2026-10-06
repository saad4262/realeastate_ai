'use server';

import { revalidatePath } from 'next/cache';
import {
  AppointmentError,
  cancelAppointment,
  completeAppointment,
  previewInvitation,
  rescheduleAppointment,
  retryAppointmentSync,
  scheduleAppointment,
  sendInvitation,
  syncAppointment,
  syncDepsFromEnv,
  type FinishAppointmentInput,
  type InvitationPreview,
  type RescheduleAppointmentInput,
  type ScheduleAppointmentInput,
} from '@repo/core/appointments';
import { ContactError } from '@repo/core/contacts';
import { mailDepsFromEnv } from '@repo/core/mail';
import { getConsoleDb } from './db';
import { loadActor } from './load-actor';
import { requireActionUserId } from './auth-account';

/**
 * The appointment actions (docs/adr/0019). The actor is rebuilt from the
 * session on every call; every decision is can()'s, inside packages/core.
 * Nothing here sends an email unless the person pressed Send.
 *
 * After each change commits, Google Calendar and Zoom are brought into line
 * (Phase 3b) — awaited, so the screen shows the result (and the new Zoom
 * link) at once. A sync problem never undoes the change: it is written on the
 * appointment, with Retry; the cron resumes one that never ran.
 */

export type AppointmentResult = { ok: true; id: string } | { ok: false; error: string };

async function actor() {
  const userId = await requireActionUserId();
  const loaded = await loadActor(userId);
  if (!loaded) throw new AppointmentError('forbidden', 'Database is not configured.');
  return loaded;
}

function refresh() {
  // The calendars and every contact profile's Calendar tab and timeline.
  revalidatePath('/calendar');
  revalidatePath('/my-calendar');
  revalidatePath('/customers', 'layout');
  revalidatePath('/my-contacts', 'layout');
}

/** Never throws: the outcome is on the row for the screen to show. */
async function mirror(id: string): Promise<void> {
  try {
    await syncAppointment(getConsoleDb(), syncDepsFromEnv(), id);
  } catch (err) {
    console.error('[appointments] sync failed', err instanceof Error ? err.message : 'unknown');
  }
}

function failure(err: unknown, fallback: string): { ok: false; error: string } {
  if (err instanceof AppointmentError || err instanceof ContactError) return { ok: false, error: err.message };
  console.error('[appointments] action failed', err);
  return { ok: false, error: fallback };
}

export async function scheduleAppointmentAction(
  contactId: string,
  input: ScheduleAppointmentInput,
): Promise<AppointmentResult> {
  const who = await actor();
  try {
    const { id } = await scheduleAppointment(getConsoleDb(), who, contactId, input);
    await mirror(id);
    refresh();
    return { ok: true, id };
  } catch (err) {
    return failure(err, 'Could not book the appointment');
  }
}

export async function completeAppointmentAction(id: string, input: FinishAppointmentInput): Promise<AppointmentResult> {
  const who = await actor();
  try {
    await completeAppointment(getConsoleDb(), who, id, input);
    await mirror(id);
    refresh();
    return { ok: true, id };
  } catch (err) {
    return failure(err, 'Could not complete the appointment');
  }
}

export async function cancelAppointmentAction(id: string, input: FinishAppointmentInput): Promise<AppointmentResult> {
  const who = await actor();
  try {
    await cancelAppointment(getConsoleDb(), who, id, input);
    await mirror(id);
    refresh();
    return { ok: true, id };
  } catch (err) {
    return failure(err, 'Could not cancel the appointment');
  }
}

export async function rescheduleAppointmentAction(
  id: string,
  input: RescheduleAppointmentInput,
): Promise<AppointmentResult> {
  const who = await actor();
  try {
    await rescheduleAppointment(getConsoleDb(), who, id, input);
    await mirror(id);
    refresh();
    return { ok: true, id };
  } catch (err) {
    return failure(err, 'Could not move the appointment');
  }
}

/** Exactly what Send would send, and whether it may be sent. Sends nothing. */
export async function previewInvitationAction(
  id: string,
): Promise<{ ok: true; preview: InvitationPreview } | { ok: false; error: string }> {
  const who = await actor();
  try {
    return { ok: true, preview: await previewInvitation(getConsoleDb(), who, id) };
  } catch (err) {
    return failure(err, 'Could not prepare the invitation');
  }
}

/** The explicit Send. Every check is repeated in core; the preview is not a token. */
export async function sendInvitationAction(
  id: string,
): Promise<{ ok: true; status: 'sent' | 'failed'; error: string | null } | { ok: false; error: string }> {
  const who = await actor();
  const deps = mailDepsFromEnv();
  if (!deps) return { ok: false, error: 'Email is not set up on this server yet, so nothing was sent.' };
  try {
    const result = await sendInvitation(getConsoleDb(), deps, who, id);
    refresh();
    revalidatePath('/inbox');
    revalidatePath('/my-inbox');
    return { ok: true, status: result.status, error: result.error };
  } catch (err) {
    return failure(err, 'Could not send the invitation');
  }
}

/** Retry a failed sync, or "Keep ours" on a change made in Google: push this appointment again. */
export async function retryAppointmentSyncAction(id: string): Promise<AppointmentResult> {
  const who = await actor();
  try {
    await retryAppointmentSync(getConsoleDb(), syncDepsFromEnv(), who, id);
    refresh();
    return { ok: true, id };
  } catch (err) {
    return failure(err, 'Could not sync the appointment');
  }
}
