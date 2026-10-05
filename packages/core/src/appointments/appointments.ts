import { and, asc, desc, eq, gte, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  appointment,
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
import {
  ACTIVE_STATUSES,
  finishAppointmentSchema,
  rescheduleAppointmentSchema,
  scheduleAppointmentSchema,
  type AppointmentListQuery,
  type AppointmentStatus,
  type AppointmentType,
  type FinishAppointmentInput,
  type RescheduleAppointmentInput,
  type ScheduleAppointmentInput,
} from './appointment-schema';

/**
 * Appointments (docs/adr/0019) — the platform's own calendar. Google Calendar
 * and Zoom mirror it in Phase 3b; until then the external columns stay empty.
 *
 * Who sees what is `appointment:read` in permissions.ts and its SQL twin
 * below: admins the agency's whole calendar; anybody else what is assigned to
 * them or what they booked. Every change writes an `activity` row on the
 * contact in the same transaction, so it is on their timeline.
 */

export class AppointmentError extends Error {
  readonly code: 'forbidden' | 'not_found' | 'invalid' | 'conflict' | 'limit';
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
    filters.push(or(eq(appointment.assignedAgentId, actor.userId), eq(appointment.createdBy, actor.userId))!);
  }
  return filters;
}

export function appointmentResource(a: {
  id: string;
  agencyId: string;
  assignedAgentId: string | null;
  createdBy: string | null;
}): Resource {
  return {
    type: 'appointment',
    id: a.id,
    agencyId: a.agencyId,
    ...(a.assignedAgentId ? { ownerId: a.assignedAgentId } : {}),
    createdBy: a.createdBy,
  };
}

export type AppointmentView = {
  id: string;
  contactId: string;
  contactName: string;
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
  /** Decided by can(); the screen draws its buttons from this. */
  mayUpdate: boolean;
};

const columns = {
  id: appointment.id,
  agencyId: appointment.agencyId,
  contactId: appointment.contactId,
  contactName: contact.name,
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
};

type Row = {
  [K in keyof typeof columns]: unknown;
} & { id: string; agencyId: string; contactId: string; assignedAgentId: string | null; createdBy: string | null };

function toView(actor: Actor, r: Row): AppointmentView {
  return {
    id: r.id,
    contactId: r.contactId,
    contactName: r.contactName as string,
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
    mayUpdate: can(actor, 'appointment:update', appointmentResource({ ...r, agencyId: r.agencyId })),
  };
}

function baseQuery(db: DbOrTx) {
  return db
    .select(columns)
    .from(appointment)
    .innerJoin(contact, eq(contact.id, appointment.contactId))
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
  if (!can(actor, 'appointment:read', appointmentResource(row))) throw APPOINTMENT_NOT_FOUND();
  return { ...toView(actor, row), agencyId: row.agencyId, createdBy: row.createdBy };
}

function firstIssue(err: { issues: { message: string }[] }): string {
  return err.issues[0]?.message ?? 'Check the highlighted fields';
}

/** May `userId` own appointments here — an active member who could change one of their own? */
async function assertAssignable(db: DbOrTx, actor: Actor, userId: string): Promise<void> {
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
  if (assignee !== actor.userId) await assertAssignable(db, actor, assignee);
  if (v.propertyId) await assertContactProperty(db, head.row.id, agencyId, v.propertyId);

  return db.transaction(async (tx) => {
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
      })
      .returning({ id: appointment.id });
    const id = row!.id;
    await recordActivity(tx, actor, agencyId, head.row.id, 'appointment_scheduled', activityPayload({ id, ...v }));
    return { id };
  });
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
): Promise<void> {
  const parsed = finishAppointmentSchema.safeParse(input);
  if (!parsed.success) throw new AppointmentError('invalid', firstIssue(parsed.error));
  const a = await loadChangeable(db, actor, id);
  const kind: ActivityKind = status === 'completed' ? 'appointment_completed' : 'appointment_cancelled';
  await db.transaction(async (tx) => {
    // Guarded on the status it was loaded with: two clicks finish it once.
    const done = await tx
      .update(appointment)
      .set({ status, outcome: parsed.data.outcome ?? null, updatedAt: sql`now()` })
      .where(and(eq(appointment.id, a.id), inArray(appointment.status, [...ACTIVE_STATUSES])))
      .returning({ id: appointment.id });
    if (!done.length) throw new AppointmentError('conflict', 'This appointment was changed by somebody else — reload');
    await recordActivity(tx, actor, a.agencyId, a.contactId, kind, activityPayload(a, { outcome: parsed.data.outcome ?? null }));
  });
}

export function completeAppointment(db: Db, actor: Actor, id: string, input: FinishAppointmentInput) {
  return finish(db, actor, id, input, 'completed');
}

export function cancelAppointment(db: Db, actor: Actor, id: string, input: FinishAppointmentInput) {
  return finish(db, actor, id, input, 'cancelled');
}

/** Move it. Status becomes `rescheduled`; the timeline records from → to. */
export async function rescheduleAppointment(
  db: Db,
  actor: Actor,
  id: string,
  input: RescheduleAppointmentInput,
): Promise<void> {
  const parsed = rescheduleAppointmentSchema.safeParse(input);
  if (!parsed.success) throw new AppointmentError('invalid', firstIssue(parsed.error));
  const v = parsed.data;
  const a = await loadChangeable(db, actor, id);
  await db.transaction(async (tx) => {
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
        updatedAt: sql`now()`,
      })
      .where(and(eq(appointment.id, a.id), inArray(appointment.status, [...ACTIVE_STATUSES])))
      .returning({ id: appointment.id });
    if (!done.length) throw new AppointmentError('conflict', 'This appointment was changed by somebody else — reload');
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
  });
}
