import { can } from '../permissions';
import { loadContactHead } from '../contacts/get-contact';
import { contactResource } from '../contacts/visibility';
import { getAppointment, AppointmentError } from '../appointments/appointments';
import { ACTIVE_STATUSES, APPOINTMENT_TYPE_LABELS } from '../appointments/appointment-schema';
import { requireIntegrations } from '../integrations/accounts';
import { PROVIDERS, type IntegrationProvider } from '../integrations/providers';
import { formatInZone, localDateTimeToInstant } from '../time/local-input';
import { propose, type FrozenArgs } from './actions';
import { resolveHandle } from './handles';
import type { ProposalCard } from './schema';
import type { addNoteInput, cancelAppointmentInput, rescheduleAppointmentInput, scheduleAppointmentInput, setNextActionInput } from './schema';
import type { ToolContext, ToolOutcome } from './tools';
import type { z } from 'zod';

/**
 * The assistant's WRITE tools (ADR 0025 §8; Phase B: notes and next action,
 * Phase C: appointments). Each one only PROPOSES: it resolves the model's
 * references through the conversation's own map, asks can() as the person,
 * builds the card from the database, and stores the frozen, resolved
 * arguments. The same core function a screen uses runs it later — only when
 * the person presses Approve — and asks can() again.
 *
 * Invitations are never sent from here (decided for Phase C): the card says
 * which screen sends one.
 */

const UNKNOWN_REF = 'That reference is not one you were given in this conversation. Use a reference from an earlier result.';
const NO_CONTACT = 'That contact is not available to this person.';

function refused(message: string, label: string): ToolOutcome {
  return { result: { error: message }, isError: true, label };
}

/** The contact behind a reference, if this person may see it now. */
async function visibleContact(ctx: ToolContext, ref: string) {
  const id = resolveHandle(ctx.handles, ref, 'contact');
  if (!id) return { error: UNKNOWN_REF } as const;
  const head = await loadContactHead(ctx.db, ctx.actor, id);
  if (!head || head.row.mergedIntoId) return { error: NO_CONTACT } as const;
  const resource = contactResource(head.facts);
  if (!can(ctx.actor, 'contact:read', resource)) return { error: NO_CONTACT } as const;
  return { head, resource } as const;
}

function when(instant: Date, tz: string): string {
  return formatInZone(instant, tz);
}

function untilTime(instant: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-AU', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(instant);
}

const NOTHING_YET = 'Nothing happens until you press Approve.';
const NO_INVITE = 'No invitation is emailed. To send one, open the contact’s Calendar tab and press Send invitation.';

export async function proposeAddNote(ctx: ToolContext, input: z.infer<typeof addNoteInput>, label: string): Promise<ToolOutcome> {
  const c = await visibleContact(ctx, input.contact);
  if ('error' in c) return refused(c.error!, label);
  if (!can(ctx.actor, 'note:create', c.resource)) return refused('This person can read that contact but not add notes to it.', label);
  const name = c.head.row.name;
  const card: ProposalCard = {
    title: `Add a ${input.private ? 'private ' : ''}note to ${name}`,
    contact: { id: c.head.row.id, name },
    lines: [
      { label: 'Contact', value: name },
      { label: 'Who can read it', value: input.private ? 'Only you and the agency’s owners and admins (private)' : 'Everyone who can see this contact' },
    ],
    text: { label: 'Note', value: input.body },
    notes: [NOTHING_YET],
  };
  const args: FrozenArgs = { tool: 'add_note', contactId: c.head.row.id, body: input.body, private: input.private };
  return propose(ctx, label, { tool: 'add_note', args, card, contactId: c.head.row.id });
}

export async function proposeSetNextAction(ctx: ToolContext, input: z.infer<typeof setNextActionInput>, label: string): Promise<ToolOutcome> {
  const c = await visibleContact(ctx, input.contact);
  if ('error' in c) return refused(c.error!, label);
  if (!can(ctx.actor, 'contact:update', c.resource)) {
    return refused('Only the agent this contact is assigned to, or an admin, may change its next action.', label);
  }
  let at: Date | null = null;
  if (input.date) {
    at = localDateTimeToInstant(input.date, input.time ?? '09:00', ctx.timeZone);
    if (!at) return refused('That date or time is not valid.', label);
  }
  const row = c.head.row;
  const current = row.nextAction
    ? `${row.nextAction}${row.nextActionAt ? ` (due ${when(new Date(row.nextActionAt), ctx.timeZone)})` : ''}`
    : 'None';
  const card: ProposalCard = {
    title: input.text ? `Set the next action for ${row.name}` : `Clear the next action for ${row.name}`,
    contact: { id: row.id, name: row.name },
    lines: [
      { label: 'Contact', value: row.name },
      { label: 'Now', value: current },
      { label: 'Due', value: at ? when(at, ctx.timeZone) : 'No date' },
    ],
    text: { label: 'New next action', value: input.text || '(cleared)' },
    notes: [NOTHING_YET],
  };
  const args: FrozenArgs = {
    tool: 'set_next_action',
    contactId: row.id,
    nextAction: input.text || null,
    nextActionAt: at ? at.toISOString() : null,
  };
  return propose(ctx, label, { tool: 'set_next_action', args, card, contactId: row.id });
}

/**
 * "Connect X first": the answer when an account the action needs is not
 * usable. Nothing is proposed; the panel shows the accounts with a link.
 */
async function connectFirst(ctx: ToolContext, providers: IntegrationProvider[], label: string): Promise<ToolOutcome | null> {
  if (!providers.length) return null;
  const check = await requireIntegrations(ctx.db, ctx.actor, providers, ctx.now);
  if (check.ok) return null;
  const names = check.missing.map((p) => PROVIDERS[p].label);
  return {
    label,
    frame: {
      kind: 'connections',
      rows: check.results.map((r) => ({
        provider: r.provider,
        label: PROVIDERS[r.provider].label,
        state: r.state,
        whose: r.ownerType === 'user' ? ('yours' as const) : r.ownerType === 'agency' ? ('agency' as const) : null,
        mayConnect: r.mayConnect,
      })),
    },
    result: {
      proposed: false,
      tell_the_user: `Connect ${names.join(' and ')} first — from Integrations (the link is on screen). Nothing was proposed.`,
    },
  };
}

function accountLine(r: { ownerType: string | null; accountLabel: string | null }, what: string): string {
  const whose = r.ownerType === 'agency' ? `The agency’s ${what}` : `Your ${what}`;
  return r.accountLabel ? `${whose} (${r.accountLabel})` : whose;
}

function slot(date: string, time: string, minutes: number, tz: string) {
  const start = localDateTimeToInstant(date, time, tz);
  if (!start) return null;
  return { start, end: new Date(start.getTime() + minutes * 60_000) };
}

export async function proposeScheduleAppointment(
  ctx: ToolContext,
  input: z.infer<typeof scheduleAppointmentInput>,
  label: string,
): Promise<ToolOutcome> {
  const c = await visibleContact(ctx, input.contact);
  if ('error' in c) return refused(c.error!, label);
  const agencyId = c.head.row.agencyId;
  if (!can(ctx.actor, 'appointment:create', { type: 'appointment', agencyId })) {
    return refused('This person can view appointments but not book them.', label);
  }
  // Always on the person's own calendar; a Zoom type needs a Zoom (theirs, else the agency's).
  const requires: IntegrationProvider[] = ['google_calendar', ...(input.type === 'zoom' ? (['zoom'] as const) : [])];
  const missing = await connectFirst(ctx, requires, label);
  if (missing) return missing;

  const minutes = input.duration_minutes ?? (input.type === 'phone_call' ? 30 : 60);
  const s = slot(input.date, input.time, minutes, ctx.timeZone);
  if (!s) return refused('That date or time is not valid.', label);
  if (s.start.getTime() <= ctx.now.getTime()) return refused('That time has already passed.', label);

  const accounts = await requireIntegrations(ctx.db, ctx.actor, requires, ctx.now);
  const calendar = accounts.results.find((r) => r.provider === 'google_calendar')!;
  const zoom = accounts.results.find((r) => r.provider === 'zoom');
  const name = c.head.row.name;
  const typeLabel = APPOINTMENT_TYPE_LABELS[input.type];
  const card: ProposalCard = {
    title: `Book ${typeLabel.toLowerCase()} with ${name}`,
    contact: { id: c.head.row.id, name },
    lines: [
      { label: 'With', value: name },
      { label: 'What', value: `${input.title} (${typeLabel})` },
      { label: 'When', value: `${when(s.start, ctx.timeZone)} – ${untilTime(s.end, ctx.timeZone)}` },
      { label: 'Google Calendar', value: accountLine(calendar, 'calendar') },
      { label: 'Zoom', value: zoom ? `${accountLine(zoom, 'Zoom')} — the meeting is created when you approve` : 'Not used' },
      ...(input.location ? [{ label: 'Where', value: input.location }] : []),
    ],
    notes: [NOTHING_YET, NO_INVITE],
  };
  const args: FrozenArgs = {
    tool: 'schedule_appointment',
    contactId: c.head.row.id,
    title: input.title,
    type: input.type,
    startsAt: s.start.toISOString(),
    endsAt: s.end.toISOString(),
    timezone: ctx.timeZone,
    location: input.location ?? null,
    requires,
  };
  return propose(ctx, label, { tool: 'schedule_appointment', args, card, contactId: c.head.row.id });
}

/** The appointment behind a reference, if this person may change it now. */
async function changeableAppointment(ctx: ToolContext, ref: string) {
  const id = resolveHandle(ctx.handles, ref, 'appointment');
  if (!id) return { error: UNKNOWN_REF } as const;
  try {
    const a = await getAppointment(ctx.db, ctx.actor, id);
    if (!a.mayUpdate) return { error: 'Only the agent this appointment is assigned to, or an admin, may change it.' } as const;
    if (!ACTIVE_STATUSES.includes(a.status)) return { error: `That appointment is already ${a.status}.` } as const;
    return { a } as const;
  } catch (err) {
    if (err instanceof AppointmentError) return { error: 'That appointment is not available to this person.' } as const;
    throw err;
  }
}

/** What an existing appointment uses: its calendar event and Zoom meeting move or go with it. */
function usedBy(a: { calendarSyncState: string | null; zoomMeeting: boolean; assignedAgentId: string | null }, actorId: string): IntegrationProvider[] {
  // Only the person's own accounts are theirs to "connect first"; an admin
  // changing an agent's appointment leaves the agent's sync to report itself.
  if (a.assignedAgentId !== actorId) return [];
  return [...(a.calendarSyncState ? (['google_calendar'] as const) : []), ...(a.zoomMeeting ? (['zoom'] as const) : [])];
}

export async function proposeRescheduleAppointment(
  ctx: ToolContext,
  input: z.infer<typeof rescheduleAppointmentInput>,
  label: string,
): Promise<ToolOutcome> {
  const r = await changeableAppointment(ctx, input.appointment);
  if ('error' in r) return refused(r.error!, label);
  const a = r.a;
  const requires = usedBy(a, ctx.actor.userId);
  const missing = await connectFirst(ctx, requires, label);
  if (missing) return missing;
  const minutes = input.duration_minutes ?? Math.round((a.endsAt.getTime() - a.startsAt.getTime()) / 60_000);
  const s = slot(input.date, input.time, minutes, ctx.timeZone);
  if (!s) return refused('That date or time is not valid.', label);
  if (s.start.getTime() <= ctx.now.getTime()) return refused('That time has already passed.', label);
  const card: ProposalCard = {
    title: `Move “${a.title}” with ${a.contactName}`,
    contact: { id: a.contactId, name: a.contactName },
    lines: [
      { label: 'With', value: a.contactName },
      { label: 'From', value: `${when(a.startsAt, ctx.timeZone)} – ${untilTime(a.endsAt, ctx.timeZone)}` },
      { label: 'To', value: `${when(s.start, ctx.timeZone)} – ${untilTime(s.end, ctx.timeZone)}` },
      { label: 'Google Calendar', value: a.calendarSyncState ? 'The event moves too' : 'Not on a calendar' },
      { label: 'Zoom', value: a.zoomMeeting ? 'The meeting moves too (same link)' : 'Not used' },
    ],
    notes: [NOTHING_YET, 'Its invitation is not re-sent. To send a new one, open the contact’s Calendar tab and press Send invitation.'],
  };
  const args: FrozenArgs = {
    tool: 'reschedule_appointment',
    appointmentId: a.id,
    contactId: a.contactId,
    startsAt: s.start.toISOString(),
    endsAt: s.end.toISOString(),
    timezone: ctx.timeZone,
    requires,
  };
  return propose(ctx, label, { tool: 'reschedule_appointment', args, card, contactId: a.contactId });
}

export async function proposeCancelAppointment(
  ctx: ToolContext,
  input: z.infer<typeof cancelAppointmentInput>,
  label: string,
): Promise<ToolOutcome> {
  const r = await changeableAppointment(ctx, input.appointment);
  if ('error' in r) return refused(r.error!, label);
  const a = r.a;
  const requires = usedBy(a, ctx.actor.userId);
  const missing = await connectFirst(ctx, requires, label);
  if (missing) return missing;
  const card: ProposalCard = {
    title: `Cancel “${a.title}” with ${a.contactName}`,
    contact: { id: a.contactId, name: a.contactName },
    lines: [
      { label: 'With', value: a.contactName },
      { label: 'When', value: `${when(a.startsAt, ctx.timeZone)} – ${untilTime(a.endsAt, ctx.timeZone)}` },
      { label: 'Google Calendar', value: a.calendarSyncState ? 'The event is removed' : 'Not on a calendar' },
      { label: 'Zoom', value: a.zoomMeeting ? 'The meeting is deleted' : 'Not used' },
    ],
    ...(input.reason ? { text: { label: 'Reason (kept on the appointment)', value: input.reason } } : {}),
    notes: [NOTHING_YET, 'Nobody is emailed about the cancellation.'],
  };
  const args: FrozenArgs = { tool: 'cancel_appointment', appointmentId: a.id, contactId: a.contactId, reason: input.reason ?? null, requires };
  return propose(ctx, label, { tool: 'cancel_appointment', args, card, contactId: a.contactId });
}
