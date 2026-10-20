import { and, asc, desc, eq, gte, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { emitWorkflowEvent } from '../workflows/events';
import { alias } from 'drizzle-orm/pg-core';
import {
  appointment,
  appointmentParticipant,
  contact,
  contactProperty,
  lead,
  membership,
  property,
  user,
  type AppointmentAttendee,
  type Db,
  type DbOrTx,
} from '@repo/db';
import { can, type Actor, type MembershipRole, type Resource } from '../permissions';
import { formatAddress } from '../listings/listing-schema';
import { loadContactHead, type ReadableContact } from '../contacts/get-contact';
import { CONTACT_NOT_FOUND } from '../contacts/list-contacts';
import { contactResource } from '../contacts/visibility';
import { recordActivity } from '../contacts/write-contacts';
import type { ActivityKind } from '../contacts/contact-schema';
import { resolveIntegration } from '../integrations/accounts';
import type { CalendarConflict } from '@repo/db';
import { pendingSyncFields, syncAppointment, type SyncDeps, type SyncOutcome, type SyncState } from './sync';
import { clashMessage, findClash, findFirstClash, isOverlapViolation, OVERLAP_MESSAGE, teamClashMessage } from './clash';
import {
  ACTIVE_STATUSES,
  contactNoticeFor,
  finishAppointmentSchema,
  rescheduleAppointmentSchema,
  scheduleAppointmentSchema,
  scheduleTeamMeetingSchema,
  type AppointmentKind,
  type AppointmentListQuery,
  type AppointmentStatus,
  type AppointmentType,
  type ContactNotice,
  type FinishAppointmentInput,
  type RescheduleAppointmentInput,
  type ScheduleAppointmentInput,
  type ScheduleTeamMeetingInput,
} from './appointment-schema';

/**
 * Appointments (docs/adr/0019) — the platform's own calendar. Google Calendar
 * and Zoom mirror it (Phase 3b, `sync.ts`): every change here marks the row
 * `pending` in its own transaction, and the caller then runs the sync.
 *
 * Who sees what is `appointment:read` in permissions.ts and its SQL twin
 * below: admins the agency's whole calendar; anybody else what is assigned to
 * them, what they booked, and the team meetings they are on (ADR 0038). Every
 * change to a CLIENT appointment writes an `activity` row on the contact in
 * the same transaction, so it is on their timeline; a team meeting has no
 * contact and no timeline.
 */

export class AppointmentError extends Error {
  readonly code: 'forbidden' | 'not_found' | 'invalid' | 'conflict' | 'limit' | 'integration';
  constructor(code: AppointmentError['code'], message: string) {
    super(message);
    this.name = 'AppointmentError';
    this.code = code;
  }
}

export const APPOINTMENT_NOT_FOUND = () => new AppointmentError('not_found', 'That appointment was not found');

const agentUser = alias(user, 'agent_user');

/** The appointments this actor may see, as WHERE clauses — the SQL twin of `appointment:read`. */
export function appointmentScopeFilters(actor: Actor): SQL[] {
  const agencyId = actor.agencyId ?? '00000000-0000-0000-0000-000000000000';
  const filters: SQL[] = [eq(appointment.agencyId, agencyId)];
  if (!can(actor, 'appointment:read_all', { type: 'appointment', agencyId })) {
    filters.push(
      or(
        eq(appointment.assignedAgentId, actor.userId),
        eq(appointment.createdBy, actor.userId),
        sql`exists (select 1 from ${appointmentParticipant} ap where ap.appointment_id = ${appointment.id} and ap.user_id = ${actor.userId})`,
      )!,
    );
  }
  return filters;
}

export function appointmentResource(a: {
  id: string;
  agencyId: string;
  assignedAgentId: string | null;
  createdBy: string | null;
  participantIds?: string[];
}): Resource {
  return {
    type: 'appointment',
    id: a.id,
    agencyId: a.agencyId,
    ...(a.assignedAgentId ? { ownerId: a.assignedAgentId } : {}),
    createdBy: a.createdBy,
    ...(a.participantIds?.length ? { participantIds: a.participantIds } : {}),
  };
}

/** A colleague on a team meeting, besides its host. */
export type TeamParticipantView = { userId: string; name: string; declined: boolean };

export type AppointmentView = {
  id: string;
  /** `team`: an internal meeting between members, with no contact (ADR 0038). */
  kind: AppointmentKind;
  /** Null exactly when `kind` is `team`. */
  contactId: string | null;
  contactName: string | null;
  /** A team meeting's colleagues besides the host (empty for a client appointment). */
  participants: TeamParticipantView[];
  title: string;
  type: AppointmentType;
  status: AppointmentStatus;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  location: string | null;
  meetingUrl: string | null;
  notes: string | null;
  outcome: string | null;
  attendees: AppointmentAttendee[];
  reminderMinutes: number | null;
  invitationSentAt: Date | null;
  propertyId: string | null;
  propertyAddress: string | null;
  assignedAgentId: string | null;
  assignedAgentName: string | null;
  /** Google Calendar mirror: null = not mirrored (the agent has no calendar connected). */
  calendarSyncState: SyncState | null;
  calendarSyncedAt: Date | null;
  calendarSyncError: string | null;
  calendarConflict: CalendarConflict | null;
  /** A Zoom meeting we created (its join link is `meetingUrl`). */
  zoomMeeting: boolean;
  zoomSyncState: SyncState | null;
  zoomSyncError: string | null;
  /**
   * The Zoom link changed (the meeting moved when its agent left the agency)
   * and no invitation has gone out since: "resend the invitation".
   */
  zoomLinkChanged: boolean;
  /** The contact was emailed about it at some point (an invitation or an update) — they hold its details. */
  contactInvitedBefore: boolean;
  /** The contact was emailed that it is cancelled. */
  cancellationSent: boolean;
  /** The email the contact needs now, sent by a person from a preview (`contactNoticeFor`); null for none. */
  contactNotice: ContactNotice | null;
  /** Decided by can(); the screen draws its buttons from this. */
  mayUpdate: boolean;
  /** A participant of a team meeting who has not declined it yet. */
  mayDecline: boolean;
};

const columns = {
  id: appointment.id,
  agencyId: appointment.agencyId,
  kind: appointment.kind,
  contactId: appointment.contactId,
  contactName: contact.name,
  // Written out as `appointment.id` (see single-table-subquery.test.ts) though this query joins.
  participants: sql<{ userId: string; name: string | null; email: string; declined: boolean }[] | null>`(
    select json_agg(json_build_object('userId', u.id, 'name', u.name, 'email', u.email, 'declined', ap.declined_at is not null)
      order by lower(coalesce(nullif(u.name, ''), u.email)))
    from appointment_participant ap join "user" u on u.id = ap.user_id
    where ap.appointment_id = appointment.id
  )`,
  title: appointment.title,
  type: appointment.type,
  status: appointment.status,
  startsAt: appointment.startsAt,
  endsAt: appointment.endsAt,
  timezone: appointment.timezone,
  location: appointment.location,
  meetingUrl: appointment.meetingUrl,
  notes: appointment.notes,
  outcome: appointment.outcome,
  attendees: appointment.attendees,
  reminderMinutes: appointment.reminderMinutes,
  invitationSentAt: appointment.invitationSentAt,
  createdBy: appointment.createdBy,
  assignedAgentId: appointment.assignedAgentId,
  agentName: agentUser.name,
  agentEmail: agentUser.email,
  propertyId: appointment.propertyId,
  unit: property.unit,
  streetNumber: property.streetNumber,
  street: property.street,
  suburb: property.suburb,
  state: property.state,
  postcode: property.postcode,
  calendarSyncState: appointment.calendarSyncState,
  calendarSyncedAt: appointment.calendarSyncedAt,
  calendarSyncError: appointment.calendarSyncError,
  calendarConflict: appointment.calendarConflict,
  zoomMeetingId: appointment.zoomMeetingId,
  zoomSyncState: appointment.zoomSyncState,
  zoomSyncError: appointment.zoomSyncError,
  /** The last time an offboarding moved this appointment's Zoom meeting (ADR 0030 §5.2). In the same statement. */
  zoomLinkChangedAt: sql<string | null>`(select max(x.occurred_at) from activity x where x.kind = 'zoom_link_changed' and x.payload->>'appointmentId' = ${appointment.id}::text)`,
  /** What the contact was emailed about it (invitation.ts), in the same statement; by contact first, for activity_contact_idx. */
  contactNotifiedAt: sql<string | null>`(select max(x.occurred_at) from activity x
    where x.contact_id = appointment.contact_id and x.kind in ('appointment_invitation_sent', 'appointment_update_sent')
      and x.payload->>'appointmentId' = appointment.id::text)`,
  cancellationSentAt: sql<string | null>`(select max(x.occurred_at) from activity x
    where x.contact_id = appointment.contact_id and x.kind = 'appointment_cancellation_sent'
      and x.payload->>'appointmentId' = appointment.id::text)`,
  externalCalendarId: appointment.externalCalendarId,
};

type Row = {
  [K in keyof typeof columns]: unknown;
} & { id: string; agencyId: string; contactId: string | null; assignedAgentId: string | null; createdBy: string | null };

type ParticipantJson = { userId: string; name: string | null; email: string; declined: boolean };

/** The json_agg column, whether the driver parsed it or handed back the text. */
function participantsOf(r: Row): ParticipantJson[] {
  const raw = typeof r.participants === 'string' ? (JSON.parse(r.participants) as unknown) : r.participants;
  return Array.isArray(raw) ? (raw as ParticipantJson[]) : [];
}

function rowResource(r: Row) {
  return appointmentResource({ ...r, participantIds: participantsOf(r).map((p) => p.userId) });
}

function toView(actor: Actor, r: Row): AppointmentView {
  const people = participantsOf(r);
  const resource = rowResource(r);
  const me = people.find((p) => p.userId === actor.userId);
  const kind = (r.kind as AppointmentKind | null) ?? 'client';
  // Currently invited counts too: a delivery finished by the stuck-mail sweep writes no timeline entry.
  const contactInvitedBefore = Boolean(r.contactNotifiedAt) || Boolean(r.invitationSentAt);
  const cancellationSent = Boolean(r.cancellationSentAt);
  return {
    id: r.id,
    kind: (r.kind as AppointmentKind | null) ?? 'client',
    contactId: r.contactId,
    contactName: (r.contactName as string | null) ?? null,
    participants: people.map((p) => ({ userId: p.userId, name: p.name?.trim() || p.email, declined: Boolean(p.declined) })),
    title: r.title as string,
    type: r.type as AppointmentType,
    status: r.status as AppointmentStatus,
    startsAt: new Date(r.startsAt as Date),
    endsAt: new Date(r.endsAt as Date),
    timezone: r.timezone as string,
    location: (r.location as string | null) ?? null,
    meetingUrl: (r.meetingUrl as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    outcome: (r.outcome as string | null) ?? null,
    attendees: Array.isArray(r.attendees) ? (r.attendees as AppointmentAttendee[]) : [],
    reminderMinutes: (r.reminderMinutes as number | null) ?? null,
    invitationSentAt: r.invitationSentAt ? new Date(r.invitationSentAt as Date) : null,
    propertyId: (r.propertyId as string | null) ?? null,
    propertyAddress: r.suburb
      ? formatAddress({
          unit: r.unit as string | null,
          streetNumber: r.streetNumber as string | null,
          street: r.street as string | null,
          suburb: r.suburb as string,
          state: (r.state as string) ?? '',
          postcode: (r.postcode as string) ?? '',
        })
      : null,
    assignedAgentId: r.assignedAgentId,
    assignedAgentName: r.assignedAgentId ? ((r.agentName as string | null) || (r.agentEmail as string | null)) : null,
    calendarSyncState: (r.calendarSyncState as SyncState | null) ?? null,
    calendarSyncedAt: r.calendarSyncedAt ? new Date(r.calendarSyncedAt as Date) : null,
    calendarSyncError: (r.calendarSyncError as string | null) ?? null,
    calendarConflict: (r.calendarConflict as CalendarConflict | null) ?? null,
    zoomMeeting: Boolean(r.zoomMeetingId),
    zoomSyncState: (r.zoomSyncState as SyncState | null) ?? null,
    zoomSyncError: (r.zoomSyncError as string | null) ?? null,
    zoomLinkChanged: Boolean(r.zoomLinkChangedAt) && !r.invitationSentAt,
    contactInvitedBefore,
    cancellationSent,
    contactNotice: contactNoticeFor({
      kind,
      status: r.status as AppointmentStatus,
      invitationSentAt: (r.invitationSentAt as Date | string | null) ?? null,
      contactInvitedBefore,
      cancellationSent,
    }),
    mayUpdate: can(actor, 'appointment:update', resource),
    mayDecline: Boolean(me && !me.declined) && can(actor, 'appointment:respond', resource),
  };
}

function baseQuery(db: DbOrTx) {
  return db
    .select(columns)
    .from(appointment)
    // Left: a team meeting has no contact (ADR 0038).
    .leftJoin(contact, eq(contact.id, appointment.contactId))
    .leftJoin(agentUser, eq(agentUser.id, appointment.assignedAgentId))
    .leftJoin(property, eq(property.id, appointment.propertyId));
}

export type AppointmentPage = { rows: AppointmentView[]; seesAll: boolean };

/**
 * Upcoming (soonest first) or past (latest first) appointments this actor may
 * see — the whole calendar, or one contact's (`contactId`, for the Calendar
 * tab, after getContact said the contact may be read). One statement.
 */
export async function listAppointments(
  db: Db,
  actor: Actor,
  opts: Partial<AppointmentListQuery> & { contact?: ReadableContact; limit?: number; now?: Date } = {},
): Promise<AppointmentPage> {
  if (!actor.agencyId) throw new AppointmentError('forbidden', 'You do not have permission to view this calendar');
  const calendar = { type: 'appointment', agencyId: actor.agencyId };
  if (!can(actor, 'appointment:read', calendar)) {
    throw new AppointmentError('forbidden', 'You do not have permission to view this calendar');
  }
  const seesAll = can(actor, 'appointment:read_all', calendar);
  const now = opts.now ?? new Date();
  const upcoming = (opts.when ?? 'upcoming') === 'upcoming';

  const filters = appointmentScopeFilters(actor);
  if (opts.contact) filters.push(eq(appointment.contactId, opts.contact.id));
  if (opts.agent && seesAll) filters.push(eq(appointment.assignedAgentId, opts.agent));
  // Upcoming: still on, and not yet over. Past: over, or finished either way.
  filters.push(
    upcoming
      ? and(inArray(appointment.status, [...ACTIVE_STATUSES]), gte(appointment.endsAt, now))!
      : or(lt(appointment.endsAt, now), inArray(appointment.status, ['completed', 'cancelled']))!,
  );

  const rows = await baseQuery(db)
    .where(and(...filters))
    .orderBy(upcoming ? asc(appointment.startsAt) : desc(appointment.startsAt), asc(appointment.id))
    .limit(Math.min(opts.limit ?? 100, 200));
  return { rows: rows.map((r) => toView(actor, r as Row)), seesAll };
}

/** One appointment, if this actor may see it. Not-found otherwise — ids cannot be probed. */
export async function getAppointment(db: DbOrTx, actor: Actor, id: string): Promise<AppointmentView & { agencyId: string; createdBy: string | null }> {
  if (!actor.agencyId || !/^[0-9a-f-]{36}$/i.test(id)) throw APPOINTMENT_NOT_FOUND();
  const [r] = await baseQuery(db)
    .where(and(eq(appointment.id, id), eq(appointment.agencyId, actor.agencyId)))
    .limit(1);
  if (!r) throw APPOINTMENT_NOT_FOUND();
  const row = r as Row;
  if (!can(actor, 'appointment:read', rowResource(row))) throw APPOINTMENT_NOT_FOUND();
  return { ...toView(actor, row), agencyId: row.agencyId, createdBy: row.createdBy };
}

function firstIssue(err: { issues: { message: string }[] }): string {
  return err.issues[0]?.message ?? 'Check the highlighted fields';
}

/** May `userId` own appointments here — an active member who could change one of their own? */
async function assertAssignable(db: DbOrTx, actor: Actor, userId: string): Promise<Actor> {
  const [row] = await db
    .select({ role: membership.role })
    .from(membership)
    .where(
      and(eq(membership.agencyId, actor.agencyId as string), eq(membership.userId, userId), eq(membership.status, 'active')),
    )
    .limit(1);
  const them: Actor = { userId, agencyId: actor.agencyId, membershipRole: row?.role as MembershipRole };
  if (
    !row ||
    !can(them, 'appointment:update', { type: 'appointment', id: 'probe', agencyId: actor.agencyId, ownerId: userId })
  ) {
    throw new AppointmentError('invalid', 'That person cannot be given appointments');
  }
  return them;
}

/**
 * A Zoom appointment without a link of its own needs a Zoom to create the
 * meeting on: the assigned agent's own, else the agency's. Checked before
 * anything is written, so "Connect Zoom first" is said instead of a booking
 * that can never get its link.
 */
async function assertZoomUsable(db: DbOrTx, assignee: Actor, forSelf: boolean): Promise<void> {
  const { accountId, requirement } = await resolveIntegration(db, assignee, 'zoom');
  if (accountId) return;
  const who = forSelf ? 'You have' : 'That agent has';
  const why =
    requirement.state === 'expired'
      ? 'Zoom needs reconnecting (Integrations)'
      : requirement.state === 'permission_missing'
        ? 'Zoom is connected without every permission — reconnect it (Integrations)'
        : `Connect Zoom first — ${who.toLowerCase()} no Zoom connected, and neither does the agency`;
  throw new AppointmentError('integration', `${why}. Or paste a meeting link of your own.`);
}

/** The related property must be one of this contact's: linked to them, or one they asked about. */
async function assertContactProperty(db: DbOrTx, contactId: string, agencyId: string, propertyId: string) {
  const [ok] = await db
    .select({ id: property.id })
    .from(property)
    .where(
      and(
        eq(property.id, propertyId),
        or(
          sql`exists (select 1 from ${contactProperty} cp where cp.contact_id = ${contactId} and cp.property_id = ${property.id})`,
          sql`exists (select 1 from ${lead} l where l.contact_id = ${contactId} and l.agency_id = ${agencyId} and l.property_id = ${property.id})`,
        ),
      ),
    )
    .limit(1);
  if (!ok) throw new AppointmentError('invalid', "Pick one of this contact's properties");
}

function activityPayload(a: { id: string; title: string; type: string; startsAt: Date; endsAt: Date }, extra: Record<string, unknown> = {}) {
  return {
    appointmentId: a.id,
    title: a.title,
    type: a.type,
    startsAt: a.startsAt.toISOString(),
    endsAt: a.endsAt.toISOString(),
    ...extra,
  };
}

/**
 * Book an appointment with a contact. Whoever may see the contact and is not
 * read-only; an agent's is their own, an admin may book it for somebody.
 * Nothing is emailed here — an invitation is a separate, explicit Send.
 */
export async function scheduleAppointment(
  db: Db,
  actor: Actor,
  contactId: string,
  input: ScheduleAppointmentInput,
): Promise<{ id: string }> {
  const head = await loadContactHead(db, actor, contactId);
  if (!head || head.row.mergedIntoId) throw CONTACT_NOT_FOUND();
  if (!can(actor, 'contact:read', contactResource(head.facts))) throw CONTACT_NOT_FOUND();
  const agencyId = head.row.agencyId;
  const calendar = { type: 'appointment', agencyId };
  if (!can(actor, 'appointment:create', calendar)) {
    throw new AppointmentError('forbidden', 'You can view appointments but not book them');
  }
  const parsed = scheduleAppointmentSchema.safeParse(input);
  if (!parsed.success) throw new AppointmentError('invalid', firstIssue(parsed.error));
  const v = parsed.data;

  const assignee = can(actor, 'appointment:assign', calendar) ? (v.assignedAgentId ?? actor.userId) : actor.userId;
  const assigneeActor = assignee !== actor.userId ? await assertAssignable(db, actor, assignee) : actor;
  if (v.propertyId) await assertContactProperty(db, head.row.id, agencyId, v.propertyId);
  if (v.type === 'zoom' && !v.meetingUrl) await assertZoomUsable(db, assigneeActor, assignee === actor.userId);
  const clash = await findClash(db, assignee, v.startsAt, v.endsAt);
  if (clash) throw new AppointmentError('conflict', clashMessage(clash, assignee === actor.userId));

  return overlapGuard(() => db.transaction(async (tx) => {
    const [row] = await tx
      .insert(appointment)
      .values({
        agencyId,
        contactId: head.row.id,
        propertyId: v.propertyId ?? null,
        createdBy: actor.userId,
        assignedAgentId: assignee,
        title: v.title,
        type: v.type,
        startsAt: v.startsAt,
        endsAt: v.endsAt,
        timezone: v.timezone,
        location: v.location ?? null,
        meetingUrl: v.meetingUrl ?? null,
        notes: v.notes ?? null,
        attendees: v.attendees,
        reminderMinutes: v.reminderMinutes,
        ...pendingSyncFields({ type: v.type, meetingUrl: v.meetingUrl ?? null, zoomMeeting: false }, 'scheduled'),
      })
      .returning({ id: appointment.id });
    const id = row!.id;
    await recordActivity(tx, actor, agencyId, head.row.id, 'appointment_scheduled', activityPayload({ id, ...v }));
    // ADR 0041: an appointment with a contact may trigger a workflow — in the same transaction.
    await emitWorkflowEvent(tx, { agencyId, kind: 'appointment.booked', appointmentId: id, contactId: head.row.id, actor, data: { type: v.type } });
    return { id };
  }));
}

/** The no-overlap constraint beat the check (two tabs, one slot): the same refusal, in words. */
async function overlapGuard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (isOverlapViolation(err)) throw new AppointmentError('conflict', OVERLAP_MESSAGE);
    throw err;
  }
}

/**
 * Serialise bookings that involve the same people (ADR 0038 §4): the EXCLUDE
 * constraint covers a host, not a team meeting's colleagues, so two bookings
 * racing for one colleague's slot are put in a queue — per person, in id
 * order so two of them never wait on each other — and the second re-checks.
 */
async function lockPeople(tx: DbOrTx, userIds: readonly (string | null)[]): Promise<void> {
  const ids = [...new Set(userIds.filter((x): x is string => Boolean(x)))].sort();
  for (const id of ids) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`appointment-person:${id}`}, 0))`);
}

/** Active members of this agency, by id, with a display name — the people a team meeting may have on it. */
async function activeMembers(db: DbOrTx, agencyId: string, ids: readonly string[]) {
  if (!ids.length) return [];
  return db
    .select({ userId: user.id, name: user.name, email: user.email })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(and(eq(membership.agencyId, agencyId), eq(membership.status, 'active'), inArray(membership.userId, [...ids])));
}

const displayName = (p: { name: string | null; email: string }) => p.name?.trim() || p.email;

/**
 * Book a team meeting (ADR 0038): the host (yourself; an admin may name
 * another member) and 1–10 colleagues, all ACTIVE members of your agency, none
 * of them busy then. Nobody is told here — the caller runs the Zoom sync and
 * then `notifyTeamMeeting`, so the email carries the join link.
 */
export async function scheduleTeamMeeting(db: Db, actor: Actor, input: ScheduleTeamMeetingInput): Promise<{ id: string }> {
  if (!actor.agencyId) throw new AppointmentError('forbidden', 'You can view appointments but not book them');
  const agencyId = actor.agencyId;
  const calendar = { type: 'appointment', agencyId };
  if (!can(actor, 'appointment:create', calendar)) {
    throw new AppointmentError('forbidden', 'You can view appointments but not book them');
  }
  const parsed = scheduleTeamMeetingSchema.safeParse(input);
  if (!parsed.success) throw new AppointmentError('invalid', firstIssue(parsed.error));
  const v = parsed.data;

  const host = can(actor, 'appointment:assign', calendar) ? (v.hostId ?? actor.userId) : actor.userId;
  const hostActor = host !== actor.userId ? await assertAssignable(db, actor, host) : actor;
  const others = v.participantIds.filter((id) => id !== host);
  if (!others.length) throw new AppointmentError('invalid', 'Pick at least one colleague besides the host');
  const members = await activeMembers(db, agencyId, others);
  if (members.length !== others.length) throw new AppointmentError('invalid', 'Everyone on a team meeting must be an active member of your agency');
  const nameOf = new Map(members.map((m) => [m.userId, displayName(m)]));

  if (v.type === 'zoom' && !v.meetingUrl) await assertZoomUsable(db, hostActor, host === actor.userId);
  const hostClash = await findClash(db, host, v.startsAt, v.endsAt);
  if (hostClash) throw new AppointmentError('conflict', clashMessage(hostClash, host === actor.userId));
  const hit = await findFirstClash(db, others, v.startsAt, v.endsAt);
  if (hit) throw new AppointmentError('conflict', teamClashMessage(hit.clash, nameOf.get(hit.userId)!));

  return overlapGuard(() => db.transaction(async (tx) => {
    await lockPeople(tx, [host, ...others]);
    const late = await findFirstClash(tx, others, v.startsAt, v.endsAt);
    if (late) throw new AppointmentError('conflict', teamClashMessage(late.clash, nameOf.get(late.userId)!));
    const [row] = await tx
      .insert(appointment)
      .values({
        agencyId,
        kind: 'team',
        contactId: null,
        createdBy: actor.userId,
        assignedAgentId: host,
        title: v.title,
        type: v.type,
        startsAt: v.startsAt,
        endsAt: v.endsAt,
        timezone: v.timezone,
        location: v.location ?? null,
        meetingUrl: v.meetingUrl ?? null,
        notes: v.notes ?? null,
        reminderMinutes: v.reminderMinutes,
        ...pendingSyncFields({ type: v.type, meetingUrl: v.meetingUrl ?? null, zoomMeeting: false }, 'scheduled'),
      })
      .returning({ id: appointment.id });
    const id = row!.id;
    await tx.insert(appointmentParticipant).values(others.map((userId) => ({ appointmentId: id, userId, agencyId })));
    return { id };
  }));
}

/**
 * "I can't make it": a colleague on a team meeting declines it for themselves.
 * They stay on the list (the host sees who declined) and get no reminder.
 * Returns whether this call changed anything, so the caller tells the host once.
 */
export async function declineTeamMeeting(db: DbOrTx, actor: Actor, id: string): Promise<{ declined: boolean }> {
  const a = await getAppointment(db, actor, id);
  if (!a.mayDecline) {
    if (a.participants.some((p) => p.userId === actor.userId && p.declined)) return { declined: false };
    throw new AppointmentError('forbidden', 'Only a colleague invited to this meeting can decline it');
  }
  if (!ACTIVE_STATUSES.includes(a.status)) throw new AppointmentError('conflict', `This meeting is already ${a.status}`);
  const done = await db
    .update(appointmentParticipant)
    .set({ declinedAt: sql`now()` })
    .where(
      and(
        eq(appointmentParticipant.appointmentId, a.id),
        eq(appointmentParticipant.userId, actor.userId),
        sql`${appointmentParticipant.declinedAt} is null`,
      ),
    )
    .returning({ id: appointmentParticipant.appointmentId });
  return { declined: done.length > 0 };
}

/** Load for a change: visible, changeable, and still on. */
async function loadChangeable(db: DbOrTx, actor: Actor, id: string) {
  const a = await getAppointment(db, actor, id);
  if (!a.mayUpdate) {
    throw new AppointmentError('forbidden', 'Only the agent this appointment is assigned to, or an admin, may change it');
  }
  if (!ACTIVE_STATUSES.includes(a.status)) {
    throw new AppointmentError('conflict', `This appointment is already ${a.status}`);
  }
  return a;
}

async function finish(
  db: Db,
  actor: Actor,
  id: string,
  input: FinishAppointmentInput,
  status: 'completed' | 'cancelled',
): Promise<{ kind: AppointmentKind }> {
  const parsed = finishAppointmentSchema.safeParse(input);
  if (!parsed.success) throw new AppointmentError('invalid', firstIssue(parsed.error));
  const a = await loadChangeable(db, actor, id);
  const kind: ActivityKind = status === 'completed' ? 'appointment_completed' : 'appointment_cancelled';
  await db.transaction(async (tx) => {
    // Guarded on the status it was loaded with: two clicks finish it once.
    const done = await tx
      .update(appointment)
      .set({ status, outcome: parsed.data.outcome ?? null, updatedAt: sql`now()`, ...pendingSyncFields(a, status) })
      .where(and(eq(appointment.id, a.id), inArray(appointment.status, [...ACTIVE_STATUSES])))
      .returning({ id: appointment.id });
    if (!done.length) throw new AppointmentError('conflict', 'This appointment was changed by somebody else — reload');
    if (a.contactId) await recordActivity(tx, actor, a.agencyId, a.contactId, kind, activityPayload(a, { outcome: parsed.data.outcome ?? null }));
  });
  return { kind: a.kind };
}

export function completeAppointment(db: Db, actor: Actor, id: string, input: FinishAppointmentInput) {
  return finish(db, actor, id, input, 'completed');
}

export function cancelAppointment(db: Db, actor: Actor, id: string, input: FinishAppointmentInput) {
  return finish(db, actor, id, input, 'cancelled');
}

/**
 * Move it. Status becomes `rescheduled`; the timeline records from → to.
 * Returns the time it was, for a team meeting's "moved" notice (ADR 0038 §5).
 */
export async function rescheduleAppointment(
  db: Db,
  actor: Actor,
  id: string,
  input: RescheduleAppointmentInput,
): Promise<{ kind: AppointmentKind; was: { startsAt: Date; endsAt: Date } }> {
  const parsed = rescheduleAppointmentSchema.safeParse(input);
  if (!parsed.success) throw new AppointmentError('invalid', firstIssue(parsed.error));
  const v = parsed.data;
  const a = await loadChangeable(db, actor, id);
  if (a.assignedAgentId) {
    const clash = await findClash(db, a.assignedAgentId, v.startsAt, v.endsAt, a.id);
    if (clash) throw new AppointmentError('conflict', clashMessage(clash, a.assignedAgentId === actor.userId));
  }
  // A team meeting moves for everyone still coming (ADR 0038 §4).
  const coming = a.participants.filter((p) => !p.declined);
  if (coming.length) {
    const hit = await findFirstClash(db, coming.map((p) => p.userId), v.startsAt, v.endsAt, a.id);
    if (hit) throw new AppointmentError('conflict', teamClashMessage(hit.clash, coming.find((p) => p.userId === hit.userId)!.name));
  }
  await overlapGuard(() => db.transaction(async (tx) => {
    await lockPeople(tx, [a.assignedAgentId, ...coming.map((p) => p.userId)]);
    if (coming.length) {
      const late = await findFirstClash(tx, coming.map((p) => p.userId), v.startsAt, v.endsAt, a.id);
      if (late) throw new AppointmentError('conflict', teamClashMessage(late.clash, coming.find((p) => p.userId === late.userId)!.name));
    }
    const done = await tx
      .update(appointment)
      .set({
        startsAt: v.startsAt,
        endsAt: v.endsAt,
        timezone: v.timezone,
        status: 'rescheduled',
        outcome: v.outcome ?? a.outcome,
        // A moved appointment's invitation names the old time.
        invitationSentAt: null,
        // …and its reminder is for the new time.
        reminderSentAt: null,
        updatedAt: sql`now()`,
        ...pendingSyncFields(a, 'rescheduled'),
      })
      .where(and(eq(appointment.id, a.id), inArray(appointment.status, [...ACTIVE_STATUSES])))
      .returning({ id: appointment.id });
    if (!done.length) throw new AppointmentError('conflict', 'This appointment was changed by somebody else — reload');
    if (!a.contactId) return;
    await recordActivity(
      tx,
      actor,
      a.agencyId,
      a.contactId,
      'appointment_rescheduled',
      activityPayload(
        { ...a, startsAt: v.startsAt, endsAt: v.endsAt },
        { fromStartsAt: a.startsAt.toISOString(), outcome: v.outcome ?? null },
      ),
    );
  }));
  return { kind: a.kind, was: { startsAt: a.startsAt, endsAt: a.endsAt } };
}

/**
 * Retry — or "Keep ours" on a conflict: push this appointment to Google
 * Calendar and Zoom again. Whoever may change the appointment may ask; the
 * sync itself acts as the assigned agent.
 */
export async function retryAppointmentSync(db: DbOrTx, deps: SyncDeps, actor: Actor, id: string): Promise<SyncOutcome> {
  const a = await getAppointment(db, actor, id);
  if (!a.mayUpdate) {
    throw new AppointmentError('forbidden', 'Only the agent this appointment is assigned to, or an admin, may change it');
  }
  // Marked first, so a crash between here and the sync is resumed by the cron.
  await db
    .update(appointment)
    .set({
      calendarSyncState: a.calendarSyncState === 'removed' ? 'removed' : 'pending',
      ...(a.zoomSyncState === 'failed' ? { zoomSyncState: 'pending' } : {}),
    })
    .where(eq(appointment.id, a.id));
  const out = await syncAppointment(db, deps, a.id);
  if (!out.ran) throw new AppointmentError('conflict', 'It is syncing right now — give it a moment and reload');
  return out;
}
