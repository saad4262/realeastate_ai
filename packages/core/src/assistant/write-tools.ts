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
import { assignableMember } from '../contacts/write-contacts';
import type { addNoteInput, assignContactsInput, cancelAppointmentInput, createDashboardInput, rescheduleAppointmentInput, scheduleAppointmentInput, sendTemplateEmailInput, setNextActionInput } from './schema';
import { cancelBatch, getBatch, prepareBatch } from '../template-email/batches';
import { TemplateEmailError } from '../template-email/templates';
import { SKIP_REASON_LABELS } from '../template-email/schema';
import { checkEmailLimits, emailLimitsFromEnv } from '../email/limits';
import { AUDIENCE_LABELS, createDashboardSchema } from '../dashboards';
import { agencyTimeZone, renderWidget, WIDGETS, type WidgetData } from '../widgets/registry';
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
