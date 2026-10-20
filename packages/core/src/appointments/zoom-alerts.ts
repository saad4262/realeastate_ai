import { and, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { appointment, contact, membership, notification, user, type Db } from '@repo/db';
import { can, type Actor, type MembershipRole } from '../permissions';
import { buildZoomFailedEmail } from '../email/team-notices';
import { formatInZone } from '../time/local-input';
import { ACTIVE_STATUSES } from './appointment-schema';
import type { ReminderDeps } from './reminders';

/**
 * "No Zoom link yet" (run by the every-minute tick).
 *
 * A Zoom meeting whose sync failed keeps its booking but has no link: no
 * invitation goes out (ADR 0032 §1), a team meeting's colleagues are not told
 * (ADR 0038 §5), and nothing retries it by itself — the agent's Retry does.
 * The person who pressed Book sees the error, but the HOST may not (an admin
 * booked it, the assistant ran it later, a reschedule failed in the
 * background). So the host and the booker are told: a bell notification and,
 * with mail set up, an email saying why and how to fix it.
 *
 * Once per booking or change: a row is alerted when no `zoom_failed`
 * notification for it is newer than its `updated_at` (Retry does not touch
 * `updated_at`, a reschedule does). The notifications are the claim — inserted
 * with a dedupe key, and only the rows actually inserted are emailed — so two
 * overlapping ticks tell nobody twice. A grace period leaves the person who is
 * booking a moment to reconnect and Retry before anything is sent.
 *
 * Every line is a template; no model writes any of it.
 */

export const NOTIFICATION_KIND_ZOOM_FAILED = 'zoom_failed';
/** How long a failure may stand before anyone is alerted: the booker is usually still on the page. */
export const ZOOM_ALERT_GRACE_MS = 2 * 60 * 1000;
const BATCH = 25;

export type ZoomAlertReport = { alerted: number; notified: number; emailed: number; failed: number };

const assignee = alias(user, 'za_assignee');
const assigneeM = alias(membership, 'za_assignee_m');
const booker = alias(user, 'za_booker');
const bookerM = alias(membership, 'za_booker_m');

type Person = { userId: string; email: string; name: string | null; role: MembershipRole };

export async function runZoomFailureAlerts(db: Db, deps: Pick<ReminderDeps, 'notice' | 'now'> = {}): Promise<ZoomAlertReport> {
  const now = (deps.now ?? (() => new Date()))();
  const report: ZoomAlertReport = { alerted: 0, notified: 0, emailed: 0, failed: 0 };

  const rows = await db
    .select({
      id: appointment.id,
      agencyId: appointment.agencyId,
      title: appointment.title,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      timezone: appointment.timezone,
      updatedAt: appointment.updatedAt,
      reason: appointment.zoomSyncError,
      contactName: contact.name,
      assigneeId: assignee.id,
      assigneeEmail: assignee.email,
      assigneeName: assignee.name,
      assigneeRole: assigneeM.role,
      bookerId: booker.id,
      bookerEmail: booker.email,
      bookerName: booker.name,
      bookerRole: bookerM.role,
    })
    .from(appointment)
    .leftJoin(contact, eq(contact.id, appointment.contactId))
    .leftJoin(assignee, eq(assignee.id, appointment.assignedAgentId))
    .leftJoin(assigneeM, and(eq(assigneeM.userId, appointment.assignedAgentId), eq(assigneeM.agencyId, appointment.agencyId), eq(assigneeM.status, 'active')))
    .leftJoin(booker, eq(booker.id, appointment.createdBy))
    .leftJoin(bookerM, and(eq(bookerM.userId, appointment.createdBy), eq(bookerM.agencyId, appointment.agencyId), eq(bookerM.status, 'active')))
    .where(
      and(
        eq(appointment.type, 'zoom'),
        eq(appointment.zoomSyncState, 'failed'),
        isNull(appointment.meetingUrl),
        inArray(appointment.status, [...ACTIVE_STATUSES]),
        gt(appointment.endsAt, now),
        lt(appointment.updatedAt, new Date(now.getTime() - ZOOM_ALERT_GRACE_MS)),
        sql`not exists (
          select 1 from ${notification} n
          where n.appointment_id = ${appointment.id} and n.kind = ${NOTIFICATION_KIND_ZOOM_FAILED} and n.created_at >= ${appointment.updatedAt}
        )`,
      ),
    )
    .orderBy(appointment.startsAt)
    .limit(BATCH);
  if (!rows.length) return report;

  const planned = rows.map((r) => {
    const people: Person[] = [];
    if (r.assigneeId && r.assigneeRole && r.assigneeEmail) people.push({ userId: r.assigneeId, email: r.assigneeEmail, name: r.assigneeName, role: r.assigneeRole as MembershipRole });
    if (r.bookerId && r.bookerRole && r.bookerEmail && r.bookerId !== r.assigneeId) people.push({ userId: r.bookerId, email: r.bookerEmail, name: r.bookerName, role: r.bookerRole as MembershipRole });
    const startsAt = new Date(r.startsAt);
    const until = new Intl.DateTimeFormat('en-AU', { timeZone: r.timezone, hour: 'numeric', minute: '2-digit' }).format(new Date(r.endsAt));
    return {
      ...r,
      people,
      when: `${formatInZone(startsAt, r.timezone)} – ${until}`,
      withWhom: r.contactName ?? 'your colleagues',
      reason: r.reason ?? 'Zoom did not create the meeting.',
      dedupeKey: `${NOTIFICATION_KIND_ZOOM_FAILED}:${r.id}:${new Date(r.updatedAt).getTime()}`,
    };
  });

  const values = planned.flatMap((r) =>
    r.people.map((p) => ({
      userId: p.userId,
      agencyId: r.agencyId,
      kind: NOTIFICATION_KIND_ZOOM_FAILED,
      appointmentId: r.id,
      title: `No Zoom link yet: ${r.title}`.slice(0, 200),
      body: `${r.when} · ${r.reason}`,
      href: calendarPath(p, r.agencyId),
      joinUrl: null,
      dedupeKey: r.dedupeKey,
    })),
  );
  if (!values.length) return report;
  // The claim: only who was inserted now is emailed.
  const inserted = await db.insert(notification).values(values).onConflictDoNothing().returning({ userId: notification.userId, appointmentId: notification.appointmentId });
  report.notified = inserted.length;
  report.alerted = new Set(inserted.map((i) => i.appointmentId)).size;

  // ── Emails, after the insert committed (a network call never runs inside a transaction).
  if (!deps.notice) return report;
  for (const r of planned) {
    for (const p of r.people) {
      if (!inserted.some((i) => i.appointmentId === r.id && i.userId === p.userId)) continue;
      try {
        const path = calendarPath(p, r.agencyId);
        const base = path === '/calendar' ? deps.notice.urls.agencyUrl : deps.notice.urls.agentUrl;
        const sent = await deps.notice.mailer.transport.send(
          buildZoomFailedEmail({
            to: { email: p.email, ...(p.name ? { name: p.name } : {}) },
            from: deps.notice.mailer.sender.from,
            postalAddress: deps.notice.mailer.sender.postalAddress,
            title: r.title,
            withWhom: r.withWhom,
            when: r.when,
            reason: r.reason,
            calendarUrl: `${base}${path}`,
          }),
        );
        if (sent.ok) report.emailed++;
        else report.failed++;
      } catch {
        report.failed++;
      }
    }
  }
  return report;
}

/** The person's own calendar: the agency's for an owner/admin, theirs for anyone else. */
function calendarPath(p: Person, agencyId: string): '/calendar' | '/my-calendar' {
  const actor: Actor = { userId: p.userId, agencyId, membershipRole: p.role };
  return can(actor, 'console:agency', { type: 'console' }) ? '/calendar' : '/my-calendar';
}
