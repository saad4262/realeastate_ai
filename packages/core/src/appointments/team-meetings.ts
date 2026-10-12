import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { agency, appointment, appointmentParticipant, membership, notification, user, type Db } from '@repo/db';
import { can, type Actor, type MembershipRole } from '../permissions';
import { buildTeamMeetingEmail, type TeamMeetingEvent } from '../email/team-notices';
import type { EmailTransport } from '../email/transport';
import { noticeMailFromEnv, type SenderIdentity } from '../email/resend-transport';
import { formatInZone } from '../time/local-input';
import { buildMeetingIcs, icsSequence } from './ics';
import { ACTIVE_STATUSES, type ScheduleTeamMeetingInput } from './appointment-schema';
import { scheduleTeamMeeting } from './appointments';
import { syncAppointment, type SyncDeps } from './sync';

/**
 * Telling the people on a team meeting (ADR 0038 §5) — after the change has
 * committed and, for a booking, after the Zoom sync, so the email carries the
 * join link. Every word is a template; no model writes any of it.
 *
 * Who hears:
 *  - booked / moved / cancelled: the host and every colleague who has not
 *    declined, except whoever made the change (they know);
 *  - declined: the host, and whoever booked it if that is someone else.
 * Only ACTIVE members of the agency. A bell notification each (deduped per
 * event and version, so a retry tells nobody twice) and, with mail set up, an
 * email with the meeting's .ics. Never throws for one failed email.
 */

export type TeamMeetingDeps = {
  mailer: { sender: SenderIdentity; transport: EmailTransport };
  urls: { agentUrl: string; agencyUrl: string };
};

export function teamMeetingDepsFromEnv(env: NodeJS.ProcessEnv = process.env): TeamMeetingDeps | null {
  const notice = noticeMailFromEnv(env);
  return notice ? { mailer: notice.mailer, urls: notice.urls } : null;
}

export const NOTIFICATION_KIND_TEAM_MEETING = 'team_meeting';

type Person = { userId: string; name: string; email: string; role: MembershipRole; declined: boolean; host: boolean };

const display = (p: { name: string | null; email: string }) => p.name?.trim() || p.email;

function calendarPath(role: MembershipRole, agencyId: string): '/calendar' | '/my-calendar' {
  const a: Actor = { userId: '', agencyId, membershipRole: role };
  return can(a, 'console:agency', { type: 'console' }) ? '/calendar' : '/my-calendar';
}

function whenText(startsAt: Date, endsAt: Date, timezone: string): string {
  const until = new Intl.DateTimeFormat('en-AU', { timeZone: timezone, hour: 'numeric', minute: '2-digit' }).format(endsAt);
  return `${formatInZone(startsAt, timezone)} – ${until}`;
}

export type TeamMeetingNotice = {
  /** Who made the change — never told about their own action. */
  actorId: string;
  /** For `moved`: when it was. */
  was?: { startsAt: Date; endsAt: Date } | null;
  now?: Date;
};

export async function notifyTeamMeeting(
  db: Db,
  deps: TeamMeetingDeps | null,
  appointmentId: string,
  event: TeamMeetingEvent,
  notice: TeamMeetingNotice,
): Promise<{ notified: number; emailed: number; failed: number }> {
  const none = { notified: 0, emailed: 0, failed: 0 };
  const [m] = await db
    .select({
      id: appointment.id,
      agencyId: appointment.agencyId,
      kind: appointment.kind,
      title: appointment.title,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      timezone: appointment.timezone,
      location: appointment.location,
      meetingUrl: appointment.meetingUrl,
      notes: appointment.notes,
      status: appointment.status,
      hostId: appointment.assignedAgentId,
      createdBy: appointment.createdBy,
      updatedAt: appointment.updatedAt,
      agencyName: agency.name,
    })
    .from(appointment)
    .innerJoin(agency, eq(agency.id, appointment.agencyId))
    .where(eq(appointment.id, appointmentId))
    .limit(1);
  if (!m || m.kind !== 'team') return none;

  // The host and the colleagues, each with their CURRENT active membership (a member who left hears nothing).
  const rows = await db
    .select({
      userId: user.id,
      name: user.name,
      email: user.email,
      role: membership.role,
      declinedAt: appointmentParticipant.declinedAt,
      host: sql<boolean>`${user.id} = ${m.hostId ?? '00000000-0000-0000-0000-000000000000'}::uuid`,
    })
    .from(user)
    .innerJoin(membership, and(eq(membership.userId, user.id), eq(membership.agencyId, m.agencyId), eq(membership.status, 'active')))
    .leftJoin(appointmentParticipant, and(eq(appointmentParticipant.appointmentId, m.id), eq(appointmentParticipant.userId, user.id)))
    .where(
      sql`${user.id} = ${m.hostId ?? '00000000-0000-0000-0000-000000000000'}::uuid
        or exists (select 1 from ${appointmentParticipant} p where p.appointment_id = ${m.id} and p.user_id = ${user.id})`,
    );
  const people: Person[] = rows.map((r) => ({
    userId: r.userId,
    name: display(r),
    email: r.email,
    role: r.role as MembershipRole,
    declined: Boolean(r.declinedAt),
    host: r.host === true || (r.host as unknown) === 't',
  }));
  const host = people.find((p) => p.host) ?? null;
  const by = people.find((p) => p.userId === notice.actorId)?.name ?? 'A colleague';

  const recipients =
    event === 'declined'
      ? people.filter((p) => (p.host || p.userId === m.createdBy) && p.userId !== notice.actorId)
      : people.filter((p) => !p.declined && p.userId !== notice.actorId);
  if (!recipients.length) return none;

  const startsAt = new Date(m.startsAt);
  const endsAt = new Date(m.endsAt);
  const when = whenText(startsAt, endsAt, m.timezone);
  const version = icsSequence(new Date(m.updatedAt));
  const coming = people.filter((p) => !p.host && !p.declined).map((p) => p.name);

  const titles: Record<TeamMeetingEvent, string> = {
    booked: `${by} invited you: ${m.title}`,
    moved: `Moved: ${m.title}`,
    cancelled: `Cancelled: ${m.title}`,
    declined: `${by} can’t make it: ${m.title}`,
  };
  await db
    .insert(notification)
    .values(
      recipients.map((p) => ({
        userId: p.userId,
        agencyId: m.agencyId,
        kind: NOTIFICATION_KIND_TEAM_MEETING,
        appointmentId: m.id,
        title: titles[event].slice(0, 200),
        body: when,
        href: calendarPath(p.role, m.agencyId),
        joinUrl: event === 'cancelled' ? null : m.meetingUrl,
        dedupeKey: `team_meeting:${event}:${m.id}:${event === 'declined' ? notice.actorId : version}`,
      })),
    )
    .onConflictDoNothing();

  const out = { notified: recipients.length, emailed: 0, failed: 0 };
  if (!deps) return out;

  const ics =
    event === 'declined'
      ? null
      : buildMeetingIcs({
          appointmentId: m.id,
          sequence: version,
          status: event === 'cancelled' ? 'CANCELLED' : 'CONFIRMED',
          title: m.title,
          description: [
            `Team meeting at ${m.agencyName}`,
            host ? `Host: ${host.name}` : null,
            coming.length ? `With: ${coming.join(', ')}` : null,
            m.meetingUrl ? `Join: ${m.meetingUrl}` : null,
            m.notes ? `\n${m.notes}` : null,
          ]
            .filter(Boolean)
            .join('\n'),
          location: m.location,
          url: m.meetingUrl,
          startsAt,
          endsAt,
          now: notice.now ?? new Date(),
        });

  for (const p of recipients) {
    const path = calendarPath(p.role, m.agencyId);
    const base = path === '/calendar' ? deps.urls.agencyUrl : deps.urls.agentUrl;
    try {
      const result = await deps.mailer.transport.send(
        buildTeamMeetingEmail({
          to: { email: p.email, name: p.name },
          from: deps.mailer.sender.from,
          postalAddress: deps.mailer.sender.postalAddress,
          agencyName: m.agencyName,
          event,
          title: m.title,
          when,
          was: notice.was ? whenText(notice.was.startsAt, notice.was.endsAt, m.timezone) : null,
          by,
          host: host?.name ?? 'No host',
          people: coming.filter((n) => n !== p.name),
          agenda: m.notes,
          location: m.location,
          joinUrl: m.meetingUrl,
          calendarUrl: `${base}${path}`,
          ics,
        }),
      );
      if (result.ok) out.emailed += 1;
      else {
        out.failed += 1;
        console.error(`[meetings] team meeting ${m.id} ${event} email not sent: ${result.error}`);
      }
    } catch (err) {
      out.failed += 1;
      console.error(`[meetings] team meeting ${m.id} ${event} email not sent:`, err instanceof Error ? err.message : err);
    }
  }
  return out;
}

/**
 * Tell them, then mark the meeting told (`invitation_sent_at` — for a team
 * meeting it means "its people were told about this time"). A reschedule
 * clears it; the "moved" notice sets it again.
 */
export async function tellTeamMeeting(
  db: Db,
  deps: TeamMeetingDeps | null,
  appointmentId: string,
  event: TeamMeetingEvent,
  notice: TeamMeetingNotice,
): Promise<{ notified: number; emailed: number; failed: number }> {
  const out = await notifyTeamMeeting(db, deps, appointmentId, event, notice);
  if (event === 'booked' || event === 'moved') {
    await db
      .update(appointment)
      .set({ invitationSentAt: sql`now()` })
      .where(and(eq(appointment.id, appointmentId), eq(appointment.kind, 'team')));
  }
  return out;
}

export type TeamMeetingBooking = {
  id: string;
  /** False when a Zoom meeting was wanted and could not be made: nobody is told until Retry works. */
  told: boolean;
  zoomError: string | null;
};

/**
 * Book → make the Zoom meeting → tell everyone, with the link (ADR 0038 §5).
 * If Zoom fails the booking stands, nobody is emailed a meeting without a
 * link, and the host sees Retry; `tellIfUntold` finishes the job after it.
 */
export async function bookTeamMeeting(
  db: Db,
  deps: { sync: SyncDeps; notice: TeamMeetingDeps | null },
  actor: Actor,
  input: ScheduleTeamMeetingInput,
): Promise<TeamMeetingBooking> {
  const { id } = await scheduleTeamMeeting(db, actor, input);
  try {
    await syncAppointment(db, deps.sync, id);
  } catch (err) {
    console.error('[meetings] team meeting sync failed', err instanceof Error ? err.message : 'unknown');
  }
  return tellIfUntold(db, deps.notice, id, actor.userId);
}

/** A team meeting nobody has been told about yet (booked while Zoom failed): tell them now if it has what it needs. */
export async function tellIfUntold(db: Db, deps: TeamMeetingDeps | null, appointmentId: string, actorId: string): Promise<TeamMeetingBooking> {
  const [a] = await db
    .select({ type: appointment.type, meetingUrl: appointment.meetingUrl, zoomSyncError: appointment.zoomSyncError })
    .from(appointment)
    .where(
      and(
        eq(appointment.id, appointmentId),
        eq(appointment.kind, 'team'),
        isNull(appointment.invitationSentAt),
        inArray(appointment.status, [...ACTIVE_STATUSES]),
      ),
    )
    .limit(1);
  if (!a) return { id: appointmentId, told: false, zoomError: null };
  if (a.type === 'zoom' && !a.meetingUrl) return { id: appointmentId, told: false, zoomError: a.zoomSyncError ?? 'The Zoom meeting was not created yet.' };
  await tellTeamMeeting(db, deps, appointmentId, 'booked', { actorId });
  return { id: appointmentId, told: true, zoomError: null };
}
