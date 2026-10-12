import { and, eq, isNull, ne } from 'drizzle-orm';
import { contact } from '@repo/db';
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
import { assignableMember, contactDetailsOf, UNSUBSCRIBED_REASON, type ContactDetails, type ContactDetailsPatch } from '../contacts/write-contacts';
import { CONTACT_ROLE_LABELS, type ContactRoleKind } from '../contacts/contact-schema';
import { loadComposeTarget } from '../mail/compose';
import { MailError } from '../mail/threads';
import { resolveSender, senderLine } from '../mail/sender';
import { listColleagues } from '../team-messages/messages';
import type { messageColleaguesInput, sendEmailInput } from './schema';
import type { addNoteInput, assignContactsInput, removeAgentInput, updateAgentInput, cancelAppointmentInput, recordMarketingConsentInput, setContactArchivedInput, updateContactInput, withdrawMarketingConsentInput, createDashboardInput, rescheduleAppointmentInput, scheduleAppointmentInput, sendTemplateEmailInput, setNextActionInput } from './schema';
import { cancelBatch, getBatch, prepareBatch } from '../template-email/batches';
import { TemplateEmailError } from '../template-email/templates';
import { SKIP_REASON_LABELS } from '../template-email/schema';
import { checkEmailLimits, devAllowlistProblem, emailLimitsFromEnv } from '../email/limits';
import { clashMessage, findClash } from '../appointments/clash';
import { AUDIENCE_LABELS, createDashboardSchema } from '../dashboards';
import { agencyTimeZone, renderWidget, WIDGETS, type WidgetData } from '../widgets/registry';
import type { ToolContext, ToolOutcome } from './tools';
import {
  changedFields,
  checkTeamEdit,
  loadTeamTarget,
  OPERATIONAL_ROLE_LABELS,
  TEAM_FIELD_LABELS,
  TeamEditError,
  teamMemberPatchSchema,
  type TeamEditField,
  type TeamMemberDetails,
  type TeamTarget,
} from '../team/edit-member';
import { offboardingPreview, OffboardError } from '../team/offboarding';
import type { z } from 'zod';

/**
 * The assistant's WRITE tools (ADR 0025 §8; Phase B: notes and next action,
 * Phase C: appointments). Each one only PROPOSES: it resolves the model's
 * references through the conversation's own map, asks can() as the person,
 * builds the card from the database, and stores the frozen, resolved
 * arguments. The same core function a screen uses runs it later — only when
 * the person presses Approve — and asks can() again.
 *
 * An appointment's invitation may ride on its booking card (ADR 0032 §1):
 * the card names the recipient, and on Approve the meeting is booked, synced
 * (the Zoom link) and THEN the ADR 0019 template is sent — every check
 * repeated. It is still a template the person approved, never model text.
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
  // On the person's own calendar. Only a Zoom type NEEDS an account (theirs, else the
  // agency's); Google Calendar is used when connected and skipped when not (ADR 0032 §2).
  const requires: IntegrationProvider[] = input.type === 'zoom' ? ['zoom'] : [];
  const missing = await connectFirst(ctx, requires, label);
  if (missing) return missing;

  const minutes = input.duration_minutes ?? (input.type === 'phone_call' ? 30 : 60);
  const s = slot(input.date, input.time, minutes, ctx.timeZone);
  if (!s) return refused('That date or time is not valid.', label);
  if (s.start.getTime() <= ctx.now.getTime()) return refused('That time has already passed.', label);
  const clash = await findClash(ctx.db, ctx.actor.userId, s.start, s.end);
  if (clash) return refused(clashMessage(clash, true), label);

  const accounts = await requireIntegrations(ctx.db, ctx.actor, ['google_calendar', 'zoom'], ctx.now);
  const calendar = accounts.results.find((r) => r.provider === 'google_calendar')!;
  const zoom = input.type === 'zoom' ? accounts.results.find((r) => r.provider === 'zoom') : undefined;
  const name = c.head.row.name;
  const typeLabel = APPOINTMENT_TYPE_LABELS[input.type];

  // The invitation, checked now as Send would check it — and again when it runs.
  const invite = input.send_invitation ? await invitationProblem(ctx, c.head.row.email) : null;
  const sendInvitation = Boolean(input.send_invitation) && invite === null;
  const inviteLine = !input.send_invitation
    ? 'Not sent — say so if you want it emailed'
    : invite
      ? `Not sent — ${invite}`
      : `Emailed to ${name} (${c.head.row.email})${input.type === 'zoom' ? ' with the Zoom link' : ''}, right after the meeting is booked`;

  const card: ProposalCard = {
    title: `Book ${typeLabel.toLowerCase()} with ${name}${sendInvitation ? ' and invite them' : ''}`,
    contact: { id: c.head.row.id, name },
    lines: [
      { label: 'With', value: name },
      { label: 'What', value: `${input.title} (${typeLabel})` },
      { label: 'When', value: `${when(s.start, ctx.timeZone)} – ${untilTime(s.end, ctx.timeZone)}` },
      { label: 'Google Calendar', value: calendar.state === 'connected' ? accountLine(calendar, 'calendar') : 'Not connected — not added to a calendar' },
      { label: 'Zoom', value: zoom ? `${accountLine(zoom, 'Zoom')} — the meeting is created when you approve` : 'Not used' },
      ...(input.location ? [{ label: 'Where', value: input.location }] : []),
      { label: 'Invitation', value: inviteLine },
      { label: 'Reminder', value: '15 minutes before — to you, and to them once invited' },
    ],
    notes: [NOTHING_YET, ...(sendInvitation ? [] : [NO_INVITE])],
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
    sendInvitation,
  };
  const outcome = await propose(ctx, label, { tool: 'schedule_appointment', args, card, contactId: c.head.row.id });
  // Tell the model plainly when the invitation it was asked for will not go.
  if (input.send_invitation && invite && outcome.result && typeof outcome.result === 'object') {
    outcome.result = { ...(outcome.result as Record<string, unknown>), invitation_not_sent: invite };
  }
  return outcome;
}

/** Why an invitation to this address could not be sent today, or null. Sends nothing. */
async function invitationProblem(ctx: ToolContext, email: string | null): Promise<string | null> {
  if (!email) return 'this contact has no email address';
  if (devAllowlistProblem(email)) return 'outside production only addresses on EMAIL_DEV_ALLOWLIST are emailed';
  const limits = await checkEmailLimits(ctx.db, { agencyId: ctx.actor.agencyId!, userId: ctx.actor.userId }, emailLimitsFromEnv());
  return limits.ok ? null : (limits.reason ?? 'today’s email limit is reached');
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
  if (a.assignedAgentId) {
    const clash = await findClash(ctx.db, a.assignedAgentId, s.start, s.end, a.id);
    if (clash) return refused(clashMessage(clash, a.assignedAgentId === ctx.actor.userId), label);
  }
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

/**
 * Phase D (ADR 0025 §8, ADR 0022): send an APPROVED template to contacts the
 * person picked (S…) or found (C…). Recipients come only from references the
 * server issued — resolved to ids here, then re-scoped by `prepareBatch`
 * through the directory's own rule. The card is the frozen ADR 0022 batch:
 * every recipient, every skip with its reason, the email as the first person
 * will get it. Approve runs ADR 0022's own Approve & Send, which checks every
 * recipient again at the moment of sending. Sent from the platform address.
 */
export async function proposeSendTemplateEmail(
  ctx: ToolContext,
  input: z.infer<typeof sendTemplateEmailInput>,
  label: string,
): Promise<ToolOutcome> {
  const templateId = resolveHandle(ctx.handles, input.template, 'template');
  if (!templateId) return refused(UNKNOWN_REF, label);
  const contactIds: string[] = [];
  for (const ref of input.recipients) {
    const id = resolveHandle(ctx.handles, ref, 'contact');
    if (!id) return refused(`${ref}: ${UNKNOWN_REF}`, label);
    contactIds.push(id);
  }
  const { actor, db } = ctx;
  if (!actor.agencyId || !can(actor, 'email_batch:create', { type: 'email_batch', agencyId: actor.agencyId })) {
    return refused('This person cannot send bulk email.', label);
  }

  const limits = emailLimitsFromEnv();
  let prepared: { id: string; notFound: number };
  try {
    prepared = await prepareBatch(db, actor, { templateId, contactIds: [...new Set(contactIds)] }, limits, ctx.now);
  } catch (err) {
    if (err instanceof TemplateEmailError) return refused(err.message, label);
    throw err;
  }
  const batch = await getBatch(db, actor, prepared.id, ctx.now);
  const people = batch.recipients.map((r) => ({
    name: r.name,
    email: r.email,
    willReceive: r.status === 'queued',
    reason: r.skipReason ? SKIP_REASON_LABELS[r.skipReason] : null,
  }));

  // Nobody can receive it: no card — say why, and take the empty batch away.
  if (batch.counts.toSend === 0) {
    await cancelBatch(db, actor, batch.id).catch(() => undefined);
    return {
      label,
      result: {
        proposed: false,
        tell_the_user: 'Nobody on that list can receive this email right now, so nothing was proposed.',
        skipped: people.map((p) => ({ name: p.name, why: p.reason })),
      },
    };
  }

  const check = await checkEmailLimits(db, { agencyId: actor.agencyId, userId: actor.userId }, limits);
  const first = batch.recipients.find((r) => r.status === 'queued')!;
  const n = batch.counts.toSend;
  const card: ProposalCard = {
    title: `Send “${batch.template.name}” to ${n} ${n === 1 ? 'person' : 'people'}`,
    contact: { id: first.contactId, name: first.name },
    lines: [
      { label: 'Template', value: `${batch.template.name} (approved)` },
      // The batch's own preview: rendered for its first recipient who will receive it — `first` here.
      { label: 'Subject', value: batch.preview?.subject ?? batch.template.subject },
      { label: 'Recipients', value: `${n} will receive it${batch.counts.skipped ? ` · ${batch.counts.skipped} skipped (see below)` : ''}` },
      { label: 'Sent from', value: 'The platform address, with your agency’s name and an unsubscribe link — template email never goes from a Gmail (ADR 0026)' },
      { label: 'Today', value: `${check.agentUsed} of ${check.limits.perAgentDay} platform emails sent by you today` },
    ],
    text: { label: `Email to ${first.name} (each person gets their own name)`, value: batch.preview?.body ?? batch.template.body },
    people,
    notes: [
      NOTHING_YET,
      'At the moment of sending, consent, unsubscribes, archiving, the 7-day rule, today’s limits and the development allowlist are checked again — anyone who no longer qualifies is skipped and shown.',
      ...(prepared.notFound ? [`${prepared.notFound} of the people asked for could not be found for you and are not on the list.`] : []),
    ],
  };
  const args: FrozenArgs = { tool: 'send_template_email', batchId: batch.id, templateId, contactIds: batch.recipients.map((r) => r.contactId) };
  return propose(ctx, label, { tool: 'send_template_email', args, card, contactId: first.contactId });
}

/** A figure in words, for a card's "as of" line — from SQL numbers, never the model's. */
function figure(d: WidgetData): string {
  const money = (n: number) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 }).format(n);
  switch (d.kind) {
    case 'money':
      return `${money(d.total)} from ${d.count} sale${d.count === 1 ? '' : 's'}${d.undisclosed ? ` · ${d.undisclosed} sold with no disclosed price (not counted as $0)` : ''}`;
    case 'count':
      return String(d.total);
    case 'breakdown':
      return String(d.total);
    case 'status':
      return `${d.active} (${d.rows.map((r) => `${r.value} ${r.label.toLowerCase()}`).join(', ')})`;
    case 'agents':
      return `${d.received} received · ${d.sent} sent · ${d.people} ${d.people === 1 ? 'person' : 'people'}`;
  }
}

/**
 * ADR 0027: save a dashboard, as a card. Owners/admins only. The card lists
 * every widget in plain words with its figure as of now (SQL, as this person),
 * and who will be able to open it. Approve saves it through createDashboard,
 * which asks dashboard:create again; the card then shows its link.
 */
export async function proposeCreateDashboard(
  ctx: ToolContext,
  input: z.infer<typeof createDashboardInput>,
  label: string,
): Promise<ToolOutcome> {
  const { actor, db } = ctx;
  if (!actor.agencyId || !can(actor, 'dashboard:create', { type: 'dashboard', agencyId: actor.agencyId })) {
    return refused('Only an owner or admin can save a dashboard. You can ask to see a figure here instead.', label);
  }
  const widgets = input.widgets.map((w) => ({ widget: w.widget, params: w.range ? { range: w.range } : {} }));
  const parsed = createDashboardSchema.safeParse({ title: input.title, widgets, audience: input.audience });
  if (!parsed.success) return refused(parsed.error.issues[0]?.message ?? 'That dashboard is not valid.', label);
  const timeZone = await agencyTimeZone(db, actor.agencyId);
  const lines: { label: string; value: string }[] = [];
  const frozen: { widget: string; params: Record<string, unknown> }[] = [];
  for (const w of parsed.data.widgets) {
    const params = WIDGETS[w.widget].params.parse(w.params ?? {}) as Record<string, unknown>;
    frozen.push({ widget: w.widget, params });
    const tile = await renderWidget({ db, actor, now: ctx.now, timeZone }, { widget: w.widget, params });
    lines.push({ label: tile.description, value: tile.state === 'ok' ? `${figure(tile.data)} (now)` : 'Not available' });
  }
  const card: ProposalCard = {
    title: `Save the dashboard “${parsed.data.title}”`,
    contact: { id: '', name: '' },
    lines: [
      ...lines,
      { label: 'Who can open it', value: AUDIENCE_LABELS[parsed.data.audience] },
      { label: 'Updates', value: 'Every 30–60 seconds while it is open' },
    ],
    notes: [NOTHING_YET, 'Only signed-in members of your agency can open its link; nobody else, ever.'],
  };
  const args: FrozenArgs = { tool: 'create_dashboard', title: parsed.data.title, widgets: frozen, audience: parsed.data.audience };
  return propose(ctx, label, { tool: 'create_dashboard', args, card, contactId: null });
}


/** Every contact a multi-contact card names, each visible to this person now — or the first refusal. */
async function visibleContacts(ctx: ToolContext, refs: string[]) {
  const seen = new Set<string>();
  const out: NonNullable<Extract<Awaited<ReturnType<typeof visibleContact>>, { head: unknown }>>[] = [];
  for (const ref of refs) {
    const c = await visibleContact(ctx, ref);
    if ('error' in c) return { error: `${ref}: ${c.error}` } as const;
    if (seen.has(c.head.row.id)) continue;
    seen.add(c.head.row.id);
    out.push(c);
  }
  return { contacts: out } as const;
}

/**
 * Give contacts to a member (owners/admins only — `contact:assign`, asked at
 * the door in runAssistantTool and again by assignContact when it runs). The
 * receiver is an `M` reference from find_team_members and must be an active
 * member who may hold contacts. The card lists every contact with its email,
 * who has it now and who will — from the database. Leads are not touched.
 */
export async function proposeAssignContacts(ctx: ToolContext, input: z.infer<typeof assignContactsInput>, label: string): Promise<ToolOutcome> {
  const to = resolveHandle(ctx.handles, input.to, 'member');
  if (!to) return refused(UNKNOWN_REF, label);
  const found = await visibleContacts(ctx, input.contacts);
  if ('error' in found) return refused(found.error!, label);
  for (const c of found.contacts) {
    if (!can(ctx.actor, 'contact:assign', c.resource)) return refused('Only an owner or admin can assign contacts.', label);
  }
  const receiver = await assignableMember(ctx.db, ctx.actor, to);
  if (!receiver) return refused('That person cannot be given contacts: they must be an active member of this agency who may work contacts (not read-only).', label);

  const holder = (row: { assignedTo: string | null; assigneeName: string | null; assigneeEmail: string | null }) =>
    row.assignedTo ? (row.assigneeName || row.assigneeEmail || 'A former member') : 'Nobody';
  const changes = found.contacts.map(({ head: { row } }) => ({
    name: row.name,
    email: row.email,
    before: holder(row),
    after: receiver.name,
    skipped: row.assignedTo === receiver.userId ? `Already ${receiver.name}’s` : null,
  }));
  const moving = found.contacts.filter(({ head: { row } }) => row.assignedTo !== receiver.userId);
  if (!moving.length) {
    return { label, result: { proposed: false, tell_the_user: `All of them are already ${receiver.name}’s, so nothing was proposed.` } };
  }
  const n = moving.length;
  const first = moving[0]!.head.row;
  const card: ProposalCard = {
    title: `Give ${n} contact${n === 1 ? '' : 's'} to ${receiver.name}`,
    contact: { id: first.id, name: first.name },
    lines: [
      { label: 'Give them to', value: receiver.name },
      { label: 'Contacts', value: `${n} will move${changes.length > n ? ` · ${changes.length - n} already theirs` : ''}` },
    ],
    changes,
    notes: [
      NOTHING_YET,
      'Only the contacts move. Their enquiries (leads), appointments and emails stay with whoever has them now.',
      `${receiver.name} is not emailed about it; the contacts appear in their directory.`,
    ],
  };
  const args: FrozenArgs = {
    tool: 'assign_contacts',
    to: receiver.userId,
    contactIds: moving.map((c) => c.head.row.id),
    from: Object.fromEntries(moving.map((c) => [c.head.row.id, c.head.row.assignedTo])),
  };
  return propose(ctx, label, { tool: 'assign_contacts', args, card, contactId: first.id });
}

/** Every contact on a card, each one this person may EDIT (the edit form's rule) — or the first refusal. */
async function editableContacts(ctx: ToolContext, refs: string[], what: string) {
  const found = await visibleContacts(ctx, refs);
  if ('error' in found) return found;
  for (const c of found.contacts) {
    if (!can(ctx.actor, 'contact:update', c.resource)) {
      const ref = refs.find((r) => resolveHandle(ctx.handles, r, 'contact') === c.head.row.id) ?? '';
      return { error: `${ref}: only the agent ${c.head.row.name} is assigned to, or an admin, may ${what}. Nothing was proposed.` } as const;
    }
  }
  return found;
}

function shortDay(d: Date | string, tz: string): string {
  return new Intl.DateTimeFormat('en-AU', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(d));
}

const CONSENT_NOTE =
  'Consent means they agreed to receive marketing email from the agency. Record it only if they did — the Spam Act asks who agreed, when and how, and this card saves all three.';

/**
 * Record marketing consent for contacts the person may edit (ADR 0022 stays:
 * an enquiry is not consent; someone who unsubscribed can only opt back in
 * themselves). `how` is the person's words, saved on each contact with the
 * date and who recorded it. Skipped, with the reason on the card: anyone who
 * unsubscribed, anyone who already agreed.
 */
export async function proposeRecordConsent(ctx: ToolContext, input: z.infer<typeof recordMarketingConsentInput>, label: string): Promise<ToolOutcome> {
  const found = await editableContacts(ctx, input.contacts, 'record their consent');
  if ('error' in found) return refused(found.error!, label);
  const changes = found.contacts.map(({ head: { row } }) => ({
    name: row.name,
    email: row.email,
    before: row.marketingConsentAt ? `Consent since ${shortDay(row.marketingConsentAt, ctx.timeZone)}` : 'No consent',
    after: 'Consent',
    skipped: row.emailOptOutAt
      ? UNSUBSCRIBED_REASON
      : row.marketingConsentAt
        ? `already agreed on ${shortDay(row.marketingConsentAt, ctx.timeZone)}${row.marketingConsentNote ? ` (${row.marketingConsentNote})` : ''}`
        : null,
  }));
  const recording = found.contacts.filter(({ head: { row } }) => !row.emailOptOutAt && !row.marketingConsentAt);
  if (!recording.length) {
    return {
      label,
      result: { proposed: false, tell_the_user: 'Nobody on that list can have consent recorded, so nothing was proposed.', skipped: changes.map((c) => ({ name: c.name, why: c.skipped })) },
    };
  }
  const n = recording.length;
  const first = recording[0]!.head.row;
  const card: ProposalCard = {
    title: `Record marketing consent for ${n} contact${n === 1 ? '' : 's'}`,
    contact: { id: first.id, name: first.name },
    lines: [
      { label: 'Contacts', value: `${n} will be recorded${changes.length > n ? ` · ${changes.length - n} skipped (see below)` : ''}` },
      { label: 'Recorded as', value: 'You, dated when you approve' },
    ],
    text: { label: 'How they agreed (saved on each contact)', value: input.how },
    changes,
    notes: [NOTHING_YET, CONSENT_NOTE],
  };
  const args: FrozenArgs = { tool: 'record_marketing_consent', contactIds: recording.map((c) => c.head.row.id), how: input.how };
  return propose(ctx, label, { tool: 'record_marketing_consent', args, card, contactId: first.id });
}

/** Withdraw consent, by card, with the reason on each timeline. Contacts with none are skipped. */
export async function proposeWithdrawConsent(ctx: ToolContext, input: z.infer<typeof withdrawMarketingConsentInput>, label: string): Promise<ToolOutcome> {
  const found = await editableContacts(ctx, input.contacts, 'withdraw their consent');
  if ('error' in found) return refused(found.error!, label);
  const changes = found.contacts.map(({ head: { row } }) => ({
    name: row.name,
    email: row.email,
    before: row.marketingConsentAt ? `Consent since ${shortDay(row.marketingConsentAt, ctx.timeZone)}` : 'No consent',
    after: 'No consent',
    skipped: row.marketingConsentAt ? null : 'has no consent to withdraw',
  }));
  const withdrawing = found.contacts.filter(({ head: { row } }) => row.marketingConsentAt);
  if (!withdrawing.length) {
    return { label, result: { proposed: false, tell_the_user: 'None of them has consent recorded, so nothing was proposed.' } };
  }
  const n = withdrawing.length;
  const first = withdrawing[0]!.head.row;
  const card: ProposalCard = {
    title: `Withdraw marketing consent for ${n} contact${n === 1 ? '' : 's'}`,
    contact: { id: first.id, name: first.name },
    lines: [{ label: 'Contacts', value: `${n} will have consent withdrawn${changes.length > n ? ` · ${changes.length - n} skipped` : ''}` }],
    text: { label: 'Reason (kept on each timeline)', value: input.reason },
    changes,
    notes: [NOTHING_YET, 'They stop receiving template email. Recording consent again later needs how they agreed.'],
  };
  const args: FrozenArgs = { tool: 'withdraw_marketing_consent', contactIds: withdrawing.map((c) => c.head.row.id), reason: input.reason };
  return propose(ctx, label, { tool: 'withdraw_marketing_consent', args, card, contactId: first.id });
}

const DETAIL_LABELS: Record<keyof ContactDetails, string> = { name: 'Name', email: 'Email', phone: 'Phone', roles: 'Roles' };

function shown(k: keyof ContactDetails, v: ContactDetails[keyof ContactDetails]): string {
  if (k === 'roles') return (v as ContactRoleKind[]).length ? (v as ContactRoleKind[]).map((r) => CONTACT_ROLE_LABELS[r]).join(', ') : '(none)';
  return (v as string | null) || '(none)';
}

/**
 * Change one contact's details — the edit form's name, email, phone, roles —
 * as a card that shows each field before → after, from the database. Never
 * assignment, consent, the next action or the archive (the schema has no
 * field for them). An email another contact already has: no card, and why.
 */
export async function proposeUpdateContact(ctx: ToolContext, input: z.infer<typeof updateContactInput>, label: string): Promise<ToolOutcome> {
  const patch: ContactDetailsPatch = {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.email !== undefined ? { email: input.email ? input.email.toLowerCase() : null } : {}),
    ...(input.phone !== undefined ? { phone: input.phone || null } : {}),
    ...(input.roles !== undefined ? { roles: [...new Set(input.roles)] } : {}),
  };
  if (!Object.keys(patch).length) return refused('Say which detail to change: name, email, phone or roles.', label);
  const c = await visibleContact(ctx, input.contact);
  if ('error' in c) return refused(c.error!, label);
  const row = c.head.row;
  if (!can(ctx.actor, 'contact:update', c.resource)) {
    return refused(`Only the agent ${row.name} is assigned to, or an admin, may edit this contact. Nothing was proposed.`, label);
  }
  const before = contactDetailsOf(row);
  const after: ContactDetails = { ...before, ...patch } as ContactDetails;
  const fields = (Object.keys(patch) as (keyof ContactDetails)[]).filter((k) =>
    k === 'roles' ? [...before.roles].sort().join() !== [...after.roles].sort().join() : before[k] !== after[k],
  );
  if (!fields.length) return { label, result: { proposed: false, tell_the_user: `${row.name}’s details are already like that, so nothing was proposed.` } };
  if (!after.email && !after.phone) return refused('A contact must keep an email or a phone number. Nothing was proposed.', label);
  if (after.email && after.email !== before.email) {
    const [holder] = await ctx.db
      .select({ id: contact.id })
      .from(contact)
      .where(and(eq(contact.agencyId, row.agencyId), eq(contact.email, after.email), isNull(contact.mergedIntoId), ne(contact.id, row.id)))
      .limit(1);
    if (holder) {
      return {
        label,
        result: {
          proposed: false,
          tell_the_user: 'Another contact in the agency already has that email address, so nothing was proposed. If they are the same person, merge them from the contact’s page.',
        },
      };
    }
  }
  const card: ProposalCard = {
    title: `Change ${row.name}’s details`,
    contact: { id: row.id, name: row.name },
    lines: fields.map((k) => ({ label: DETAIL_LABELS[k], value: `${shown(k, before[k])} → ${shown(k, after[k])}` })),
    notes: [NOTHING_YET, 'Only these details change. Who they are assigned to, consent, the next action and the archive stay as they are.'],
  };
  const args: FrozenArgs = {
    tool: 'update_contact',
    contactId: row.id,
    patch: Object.fromEntries(fields.map((k) => [k, after[k]])) as ContactDetailsPatch,
    before: Object.fromEntries(fields.map((k) => [k, before[k]])) as Partial<ContactDetails>,
  };
  return propose(ctx, label, { tool: 'update_contact', args, card, contactId: row.id });
}

/** Archive a contact, or bring it back — its own small card. Deleting is not something the assistant can do. */
export async function proposeSetArchived(ctx: ToolContext, input: z.infer<typeof setContactArchivedInput>, label: string): Promise<ToolOutcome> {
  const c = await visibleContact(ctx, input.contact);
  if ('error' in c) return refused(c.error!, label);
  const row = c.head.row;
  if (!can(ctx.actor, 'contact:archive', c.resource)) {
    return refused(`Only the agent ${row.name} is assigned to, or an admin, may archive this contact. Nothing was proposed.`, label);
  }
  if (Boolean(row.archivedAt) === input.archived) {
    return { label, result: { proposed: false, tell_the_user: `${row.name} is already ${input.archived ? 'archived' : 'in the directory'}, so nothing was proposed.` } };
  }
  const card: ProposalCard = {
    title: input.archived ? `Archive ${row.name}` : `Bring ${row.name} back from the archive`,
    contact: { id: row.id, name: row.name },
    lines: [
      { label: 'Contact', value: `${row.name}${row.email ? ` · ${row.email}` : ''}` },
      { label: 'Now', value: input.archived ? 'In the directory' : 'Archived' },
      { label: 'After', value: input.archived ? 'Archived — hidden from the directory’s default view' : 'In the directory' },
    ],
    notes: [NOTHING_YET, 'Nothing is deleted. A new enquiry from them still lands on this contact.'],
  };
  const args: FrozenArgs = { tool: 'set_contact_archived', contactId: row.id, archived: input.archived };
  return propose(ctx, label, { tool: 'set_contact_archived', args, card, contactId: row.id });
}

/** The member or invite behind an M/I reference from find_agents. */
function teamTarget(ctx: ToolContext, ref: string): TeamTarget | null {
  if (ref.startsWith('I')) {
    const inviteId = resolveHandle(ctx.handles, ref, 'invite');
    return inviteId ? { kind: 'invite', inviteId } : null;
  }
  const userId = resolveHandle(ctx.handles, ref, 'member');
  return userId ? { kind: 'member', userId } : null;
}

function teamValue(k: TeamEditField, v: TeamMemberDetails[TeamEditField], tz: string): string {
  if (v === null || v === undefined || v === '') return '(none)';
  if (k === 'territorySuburbs') return (v as string[]).join(', ') || '(none)';
  if (k === 'operationalRole') return OPERATIONAL_ROLE_LABELS[v as keyof typeof OPERATIONAL_ROLE_LABELS] ?? String(v);
  if (k === 'licenceExpiry') return shortDay(`${v as string}T00:00:00.000Z`, 'UTC');
  void tz;
  return String(v);
}

/**
 * Change a team member's or a pending invite's details (ADR 0033; owners/admins,
 * asked at the door and again by editTeamMember when it runs). The card shows
 * each field before → after from the database; every refusal editTeamMember
 * would give (an active member's email, your own role, an owner's role, an
 * email someone has) is given here first, so no card is made that cannot run.
 */
export async function proposeUpdateAgent(ctx: ToolContext, input: z.infer<typeof updateAgentInput>, label: string): Promise<ToolOutcome> {
  const target = teamTarget(ctx, input.agent);
  if (!target) return refused(UNKNOWN_REF, label);
  const parsed = teamMemberPatchSchema.safeParse({
    ...(input.first_name !== undefined ? { firstName: input.first_name } : {}),
    ...(input.last_name !== undefined ? { lastName: input.last_name } : {}),
    ...(input.display_name !== undefined ? { displayName: input.display_name } : {}),
    ...(input.email !== undefined ? { email: input.email.toLowerCase() } : {}),
    ...(input.phone !== undefined ? { phone: input.phone } : {}),
    ...(input.licence_number !== undefined ? { licenceNumber: input.licence_number } : {}),
    ...(input.licence_expiry !== undefined ? { licenceExpiry: input.licence_expiry || null } : {}),
    ...(input.territory_suburbs !== undefined ? { territorySuburbs: input.territory_suburbs } : {}),
    ...(input.role !== undefined ? { operationalRole: input.role } : {}),
  });
  if (!parsed.success) return refused(`${parsed.error.issues[0]?.message ?? 'Those details are not valid'}. Nothing was proposed.`, label);
  const patch = parsed.data;
  try {
    const t = await loadTeamTarget(ctx.db, ctx.actor, target);
    const fields = changedFields(t.details, patch);
    if (!fields.length) return { label, result: { proposed: false, tell_the_user: `${t.name}’s details are already like that, so nothing was proposed.` } };
    await checkTeamEdit(ctx.db, ctx.actor, t, fields, patch);
    const after = { ...t.details, ...patch } as TeamMemberDetails;
    const notes = [NOTHING_YET];
    if (target.kind === 'invite' && fields.includes('email')) {
      notes.push('The invite link already sent stops working. A new link goes to the new address, and is on the Agents & Team screen too.');
    }
    if (fields.includes('operationalRole')) {
      notes.push(
        after.operationalRole === 'principal'
          ? 'Principal makes them an admin: they can run the agency console, manage the team and see every contact and lead.'
          : 'The role decides what they may do in the console from the moment you approve.',
      );
    }
    const card: ProposalCard = {
      title: target.kind === 'invite' ? `Change ${t.name}’s invite` : `Change ${t.name}’s details`,
      contact: { id: '', name: '' },
      lines: [
        { label: 'Who', value: `${t.name} · ${t.details.email}${t.status === 'invited' ? ' (invited, not joined yet)' : ''}` },
        ...fields.map((k) => ({ label: TEAM_FIELD_LABELS[k], value: `${teamValue(k, t.details[k], ctx.timeZone)} → ${teamValue(k, after[k], ctx.timeZone)}` })),
      ],
      notes,
    };
    const args: FrozenArgs = {
      tool: 'update_agent',
      target,
      patch: Object.fromEntries(fields.map((k) => [k, after[k]])),
      before: Object.fromEntries(fields.map((k) => [k, t.details[k]])) as Partial<TeamMemberDetails>,
    };
    return propose(ctx, label, { tool: 'update_agent', args, card, contactId: null });
  } catch (err) {
    if (err instanceof TeamEditError) return refused(`${err.message}. Nothing was proposed.`, label);
    throw err;
  }
}

const ASK_RECEIVER =
  'Removing an active member needs a decision first: ask the person who should receive their contacts, leads, appointments and listings (a team member — find_agents gives M references), or whether to leave that work unassigned in the "Needs an owner" queue. Nothing was proposed.';

/**
 * "Delete" an agent (ADR 0033, decided: offboarding). A pending invite is
 * withdrawn. An active member goes through ADR 0030's removal, which needs a
 * receiver or "leave for review" — without one, no card: the model asks. The
 * card's counts are SQL (offboardingPreview), never the model's.
 */
export async function proposeRemoveAgent(ctx: ToolContext, input: z.infer<typeof removeAgentInput>, label: string): Promise<ToolOutcome> {
  const target = teamTarget(ctx, input.agent);
  if (!target) return refused(UNKNOWN_REF, label);

  if (target.kind === 'invite') {
    try {
      const t = await loadTeamTarget(ctx.db, ctx.actor, target);
      const card: ProposalCard = {
        title: `Withdraw ${t.name}’s invite`,
        contact: { id: '', name: '' },
        lines: [
          { label: 'Who', value: `${t.name} · ${t.details.email}` },
          { label: 'Now', value: 'Invited, has not joined yet' },
          { label: 'After', value: 'The invite link says “This invite was withdrawn”' },
        ],
        notes: [NOTHING_YET, 'Nothing else exists for them yet, so nothing else changes. You can invite them again later.'],
      };
      return propose(ctx, label, { tool: 'remove_agent', args: { tool: 'remove_agent', target, choice: null }, card, contactId: null });
    } catch (err) {
      if (err instanceof TeamEditError) return refused(`${err.message}. Nothing was proposed.`, label);
      throw err;
    }
  }

  if (input.receiver && input.leave_for_review) {
    return refused('Choose a receiver or leave their work for review — not both. Ask the person which. Nothing was proposed.', label);
  }
  if (!input.receiver && !input.leave_for_review) {
    return { label, result: { proposed: false, tell_the_user: ASK_RECEIVER } };
  }
  const receiverId = input.receiver ? resolveHandle(ctx.handles, input.receiver, 'member') : null;
  if (input.receiver && !receiverId) return refused(`${input.receiver}: ${UNKNOWN_REF}`, label);
  try {
    const preview = await offboardingPreview(ctx.db, ctx.actor, target.userId, ctx.now);
    const receiver = receiverId ? preview.receivers.find((r) => r.userId === receiverId) : null;
    if (receiverId && !receiver) {
      return refused('That person cannot receive their work: they must be another active member of this agency who may work contacts (not read-only). Nothing was proposed.', label);
    }
    const name = preview.member.name || preview.member.email;
    const c = preview.counts;
    const card: ProposalCard = {
      title: `Remove ${name} from the agency`,
      contact: { id: '', name: '' },
      lines: [
        { label: 'Who', value: `${name} · ${preview.member.email}` },
        { label: 'Their work goes to', value: receiver ? receiver.name : 'Nobody yet — the “Needs an owner” queue on Overview' },
        { label: 'Contacts', value: String(c.contacts) },
        { label: 'Leads', value: String(c.leads) },
        { label: 'Upcoming appointments', value: String(c.upcomingAppointments) },
        { label: 'Listings', value: `${c.listings}${c.onlyAgentListings ? ` (${c.onlyAgentListings} with no other agent)` : ''}` },
        { label: 'Their connected accounts', value: `${c.ownAccounts} disconnected and revoked` },
      ],
      notes: [
        NOTHING_YET,
        'They lose access to the console as soon as it runs. Their upcoming calendar events and their own Zoom meetings are deleted; waiting cards, prepared emails and imports of theirs are cancelled.',
        `Nothing is deleted from the agency’s records. An owner or admin can restore them for 30 days from Agents & Team → Removed members.`,
      ],
    };
    const args: FrozenArgs = { tool: 'remove_agent', target, choice: receiver ? { receiver: receiver.userId } : { review: true } };
    return propose(ctx, label, { tool: 'remove_agent', args, card, contactId: null });
  } catch (err) {
    if (err instanceof OffboardError) return refused(`${err.message}. Nothing was proposed.`, label);
    throw err;
  }
}

// ── Writing (ADR 0035 §4) ─────────────────────────────────────────────────

const WRITTEN_BY_ASSISTANT = 'Written by the assistant. Read every word — names, dates and figures — before you approve; what you approve is what is sent.';

/**
 * Every figure in a text the assistant wrote — "$950,000", "14", "10:30am",
 * "3.5%" — listed on the card so the person checks each one. The model never
 * produces a number the person did not give it (CLAUDE.md #4); this is how a
 * wrong one is caught before it reaches anybody.
 */
export function figuresIn(text: string): string[] {
  const found = text.match(/\$?\d[\d,.:/]*(?:\s?(?:%|k\b|m\b|am\b|pm\b))?/gi) ?? [];
  return [...new Set(found.map((f) => f.trim().replace(/[.,:/]+$/, '')))].filter(Boolean).slice(0, 20);
}

/** A new email to one contact: the exact subject and body on the card; sent only on Approve. */
export async function proposeSendEmail(ctx: ToolContext, input: z.infer<typeof sendEmailInput>, label: string): Promise<ToolOutcome> {
  const c = await visibleContact(ctx, input.contact);
  if ('error' in c) return refused(c.error!, label);
  let target;
  try {
    target = await loadComposeTarget(ctx.db, ctx.actor, c.head.row.id);
  } catch (err) {
    if (err instanceof MailError) return refused(NO_CONTACT, label);
    throw err;
  }
  if (target.problem) return refused(`${target.problem} Nothing was proposed.`, label);
  const limits = await checkEmailLimits(ctx.db, { agencyId: target.contact.agencyId, userId: ctx.actor.userId }, emailLimitsFromEnv());
  if (!limits.ok) return refused(`${limits.reason ?? 'Today’s email limit has been reached.'} Nothing was proposed.`, label);

  const name = target.contact.name;
  const figures = figuresIn(`${input.subject}\n${input.body}`);
  const card: ProposalCard = {
    title: `Email ${name}`,
    contact: { id: target.contact.id, name },
    lines: [
      { label: 'To', value: `${name} · ${target.contact.email}` },
      { label: 'From', value: senderLine(await resolveSender(ctx.db, ctx.actor)) },
      { label: 'Subject', value: input.subject },
    ],
    text: { label: 'Email', value: input.body },
    ...(figures.length ? { figures } : {}),
    notes: [
      'Nothing is sent until you press Approve.',
      WRITTEN_BY_ASSISTANT,
      'It is signed with your name and the agency’s, and carries an unsubscribe link. Their reply comes back to the inbox.',
    ],
  };
  const args: FrozenArgs = { tool: 'send_email', contactId: target.contact.id, subject: input.subject, body: input.body };
  return propose(ctx, label, { tool: 'send_email', args, card, contactId: target.contact.id });
}

/** A message to colleagues: in Team messages and by email to each. Sent only on Approve. */
export async function proposeMessageColleagues(ctx: ToolContext, input: z.infer<typeof messageColleaguesInput>, label: string): Promise<ToolOutcome> {
  if (!can(ctx.actor, 'team_message:send', { type: 'team_thread', agencyId: ctx.actor.agencyId ?? undefined })) {
    return refused('This person may read team messages but not write them.', label);
  }
  const ids: string[] = [];
  for (const ref of input.to) {
    const id = resolveHandle(ctx.handles, ref, 'member');
    if (!id) return refused(`${ref}: ${UNKNOWN_REF} Use find_colleagues first.`, label);
    if (id !== ctx.actor.userId && !ids.includes(id)) ids.push(id);
  }
  if (!ids.length) return refused('Choose at least one colleague — not the person themselves. Nothing was proposed.', label);
  const colleagues = await listColleagues(ctx.db, ctx.actor);
  const to = ids.map((id) => colleagues.find((c) => c.userId === id));
  if (to.some((c) => !c)) return refused('Someone you chose is no longer an active member of the agency. Nothing was proposed.', label);

  const people = to as NonNullable<(typeof to)[number]>[];
  const figures = figuresIn(`${input.subject}\n${input.body}`);
  const card: ProposalCard = {
    title: `Message ${people.map((p) => p.name).join(', ')}`,
    contact: { id: '', name: '' },
    lines: [
      { label: 'To', value: people.map((p) => `${p.name} (${p.roleLabel})`).join(', ') },
      { label: 'Subject', value: input.subject },
    ],
    text: { label: 'Message', value: input.body },
    ...(figures.length ? { figures } : {}),
    notes: [
      'Nothing is sent until you press Approve.',
      WRITTEN_BY_ASSISTANT,
      'Only the people on it can read it — in Team messages, and by email.',
    ],
  };
  const args: FrozenArgs = { tool: 'message_colleagues', to: ids, subject: input.subject, body: input.body };
  return propose(ctx, label, { tool: 'message_colleagues', args, card, contactId: null });
}
