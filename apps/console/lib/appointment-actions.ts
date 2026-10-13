'use server';

import { revalidatePath } from 'next/cache';
import {
  AppointmentError,
  bookTeamMeeting,
  cancelAppointment,
  completeAppointment,
  declineTeamMeeting,
  previewInvitation,
  rescheduleAppointment,
  retryAppointmentSync,
  scheduleAppointment,
  sendInvitation,
  syncAppointment,
  syncDepsFromEnv,
  teamMeetingDepsFromEnv,
  tellIfUntold,
  tellTeamMeeting,
  type FinishAppointmentInput,
  type InvitationPreview,
  type RescheduleAppointmentInput,
  type ScheduleAppointmentInput,
  type ScheduleTeamMeetingInput,
  type TeamMeetingNotice,
} from '@repo/core/appointments';
import { ContactError } from '@repo/core/contacts';
import { mailDepsFromEnv } from '@repo/core/mail';
import { getConsoleDb } from './db';
import { loadActor } from './load-actor';
import { requireActionUserId } from './auth-account';

/**
 * The appointment actions (docs/adr/0019). The actor is rebuilt from the
 * session on every call; every decision is can()'s, inside packages/core.
 * Nothing here emails a CONTACT unless the person pressed Send. A team
 * meeting's people (members, ADR 0038) are told of a booking, move, cancel or
 * decline as it happens — by core, after the change and its sync.
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

/** Tell a team meeting's people (core does nothing for a client appointment). Never throws: the change already stands. */
async function tell(id: string, event: 'booked' | 'moved' | 'cancelled' | 'declined', notice: TeamMeetingNotice): Promise<void> {
  try {
    await tellTeamMeeting(getConsoleDb(), teamMeetingDepsFromEnv(), id, event, notice);
  } catch (err) {
    console.error('[appointments] team meeting notice failed', err instanceof Error ? err.message : 'unknown');
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
    const { kind } = await cancelAppointment(getConsoleDb(), who, id, input);
    await mirror(id);
    if (kind === 'team') await tell(id, 'cancelled', { actorId: who.userId });
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
    const { kind, was } = await rescheduleAppointment(getConsoleDb(), who, id, input);
    await mirror(id);
    if (kind === 'team') await tell(id, 'moved', { actorId: who.userId, was });
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
): Promise<{ ok: true; status: 'sent' | 'failed' | 'sending'; error: string | null } | { ok: false; error: string }> {
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
    // A team meeting booked while Zoom failed: now that it has its link, its people are told.
    await tellIfUntold(getConsoleDb(), teamMeetingDepsFromEnv(), id, who.userId);
    refresh();
    return { ok: true, id };
  } catch (err) {
    return failure(err, 'Could not sync the appointment');
  }
}

export type TeamMeetingResult = { ok: true; id: string; told: boolean; zoomError: string | null } | { ok: false; error: string };

/** Book a team meeting (ADR 0038): booked → Zoom → everyone emailed with the link. */
export async function scheduleTeamMeetingAction(input: ScheduleTeamMeetingInput): Promise<TeamMeetingResult> {
  const who = await actor();
  try {
    const r = await bookTeamMeeting(getConsoleDb(), { sync: syncDepsFromEnv(), notice: teamMeetingDepsFromEnv() }, who, input);
    refresh();
    return { ok: true, ...r };
  } catch (err) {
    return failure(err, 'Could not book the team meeting');
  }
}

/** "I can't make it" — a colleague on a team meeting; the host is told. */
export async function declineTeamMeetingAction(id: string): Promise<AppointmentResult> {
  const who = await actor();
  try {
    const { declined } = await declineTeamMeeting(getConsoleDb(), who, id);
    if (declined) await tell(id, 'declined', { actorId: who.userId });
    refresh();
    return { ok: true, id };
  } catch (err) {
    return failure(err, 'Could not decline the meeting');
  }
}
