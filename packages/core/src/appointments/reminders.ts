import { and, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { agency, appointment, appointmentParticipant, contact, mailThread, membership, notification, user, type Db } from '@repo/db';
import { can, type Actor, type MembershipRole } from '../permissions';
import { buildMeetingReminderEmail } from '../email/team-notices';
import type { EmailTransport } from '../email/transport';
import type { SenderIdentity } from '../email/resend-transport';
import { deliverOutbound, recordOutbound, type MailDeps } from '../mail/send';
import { formatInZone } from '../time/local-input';
import { ACTIVE_STATUSES, APPOINTMENT_TYPE_LABELS, type AppointmentType } from './appointment-schema';

/**
 * Meeting reminders (ADR 0032 §4), run by the every-minute cron tick.
 *
 * Due = active, a reminder asked for, not yet reminded, its reminder time
 * reached and the meeting not over. Each due appointment is CLAIMED
 * (`reminder_sent_at`) in the same transaction that writes the console
 * notifications, so a second tick — or two overlapping ticks — reminds nobody
 * twice. A reschedule clears the claim.
 *
 * Who hears:
 *  - the agent it is assigned to and whoever booked it (one row each, the
 *    same person once), while they are ACTIVE members of the agency: a bell
 *    notification, and an email if mail is set up;
 *  - on a team meeting (ADR 0038 §6), also every colleague on it who has not
 *    declined, the same way — once they were told about it (a Zoom failure
 *    leaves them untold; see `reminderRecipients`);
 *  - a Zoom meeting with no link says so ("No Zoom link yet … Retry") rather
 *    than going out as if nothing were wrong;
 *  - the contact, by email, only if they were sent the invitation — a
 *    reminder about a meeting nobody told them of would be the first they
 *    heard of it. It goes through the conversation pipeline (ADR 0016), so the
 *    dev allowlist applies and their reply lands in the console.
 *
 * Emails go after the commit and are best effort: a failed reminder is not
 * retried (it would arrive after the meeting started). Every line is a
 * template — no model writes any of it.
 */

export const REMINDER_KIND = 'appointment_reminder';
export const NOTIFICATION_KIND_REMINDER = 'meeting_reminder';
const BATCH = 25;

export type ReminderDeps = {
  /** Staff email (platform → member). Null: bell only. */
  notice?: { mailer: { sender: SenderIdentity; transport: EmailTransport }; urls: { agentUrl: string; agencyUrl: string } } | null;
  /** The contact's email, through the conversation pipeline. Null: the contact is not emailed. */
  mail?: MailDeps | null;
  now?: () => Date;
};

export type ReminderReport = { claimed: number; notified: number; staffEmailed: number; contactsEmailed: number; failed: number };

const assignee = alias(user, 'assignee');
const assigneeM = alias(membership, 'assignee_m');
const booker = alias(user, 'booker');
const bookerM = alias(membership, 'booker_m');

type Person = { userId: string; email: string; name: string | null; role: MembershipRole };

/** The line a reminder carries when a Zoom meeting has no link: it was never created (Zoom failed). */
export const NO_ZOOM_LINK = 'No Zoom link yet — the Zoom meeting was not created. Open it in your calendar and press Retry.';

/** A Zoom meeting whose link was never made: reminding about it must say so, not just omit the link. */
export function zoomLinkMissing(r: { type: string; meetingUrl: string | null }): boolean {
  return r.type === 'zoom' && !r.meetingUrl;
}

/**
 * Who a reminder reaches: the agent it is assigned to and whoever booked it,
 * then a team meeting's colleagues — but only once they were told about it
 * (`invitation_sent_at`). A team meeting whose Zoom failed was never sent to
 * its colleagues; a "starts soon" would be the first they heard of it, with no
 * link. Its host and booker are still reminded, so they can fix it.
 */
export function reminderRecipients(
  r: {
    kind: string;
    invitationSentAt: Date | string | null;
    assignee: Person | null;
    booker: Person | null;
  },
  colleagues: Person[],
): Person[] {
  const people: Person[] = [];
  if (r.assignee) people.push(r.assignee);
  if (r.booker && r.booker.userId !== r.assignee?.userId) people.push(r.booker);
  const told = r.kind !== 'team' || r.invitationSentAt !== null;
  if (told) for (const c of colleagues) if (!people.some((p) => p.userId === c.userId)) people.push(c);
  return people;
}

/** "in 15 minutes", "in 1 hour", "now" — for a subject line, from the tick's clock. */
export function startsIn(startsAt: Date, now: Date): string {
  const mins = Math.round((startsAt.getTime() - now.getTime()) / 60_000);
  if (mins <= 0) return 'starting now';
  if (mins < 60) return `in ${mins} minute${mins === 1 ? '' : 's'}`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours} hour${hours === 1 ? '' : 's'}`;
  return 'tomorrow';
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/** The contact's reminder: a template, like the invitation it follows. */
export function buildContactReminder(
  a: { title: string; type: AppointmentType; startsAt: Date; endsAt: Date; timezone: string; location: string | null; meetingUrl: string | null; contactName: string },
  from: { agentName: string; agencyName: string },
  now: Date,
): { subject: string; body: string } {
  const until = new Intl.DateTimeFormat('en-AU', { timeZone: a.timezone, hour: 'numeric', minute: '2-digit' }).format(a.endsAt);
  const what = APPOINTMENT_TYPE_LABELS[a.type].toLowerCase();
  const subject = `Reminder: ${a.title} — ${startsIn(a.startsAt, now)}`;
  const lines = [
    `Hi ${firstName(a.contactName)},`,
    '',
    `A reminder of your ${what} with ${from.agentName} from ${from.agencyName}.`,
    '',
    `What: ${a.title}`,
    `When: ${formatInZone(a.startsAt, a.timezone)} – ${until}`,
    ...(a.location ? [`Where: ${a.location}`] : []),
    ...(a.meetingUrl ? [`Join: ${a.meetingUrl}`] : []),
    '',
    "If you can't make it, just reply to this email.",
  ];
  return { subject, body: lines.join('\n') };
}

export async function runReminderTick(db: Db, deps: ReminderDeps = {}): Promise<ReminderReport> {
  const now = (deps.now ?? (() => new Date()))();
  const report: ReminderReport = { claimed: 0, notified: 0, staffEmailed: 0, contactsEmailed: 0, failed: 0 };

  const due = and(
    inArray(appointment.status, [...ACTIVE_STATUSES]),
    isNull(appointment.reminderSentAt),
    isNotNull(appointment.reminderMinutes),
    // A raw expression has no column type to map a Date through: bind the instant as text.
    sql`${appointment.startsAt} - make_interval(mins => ${appointment.reminderMinutes}) <= ${now.toISOString()}::timestamptz`,
    gt(appointment.endsAt, now),
  );

  const claimed = await db.transaction(async (tx) => {
    // Claim first; SKIP LOCKED keeps two overlapping ticks off the same rows.
    const ids = await tx
      .update(appointment)
      .set({ reminderSentAt: now })
      .where(
        and(
          inArray(appointment.id, tx.select({ id: appointment.id }).from(appointment).where(due).orderBy(appointment.startsAt).limit(BATCH).for('update', { skipLocked: true })),
          isNull(appointment.reminderSentAt),
        ),
      )
      .returning({ id: appointment.id });
    if (!ids.length) return [];

    const rows = await tx
      .select({
        id: appointment.id,
        agencyId: appointment.agencyId,
        contactId: appointment.contactId,
        kind: appointment.kind,
        title: appointment.title,
        type: appointment.type,
        startsAt: appointment.startsAt,
        endsAt: appointment.endsAt,
        timezone: appointment.timezone,
        location: appointment.location,
        meetingUrl: appointment.meetingUrl,
        invitationSentAt: appointment.invitationSentAt,
        contactName: contact.name,
        contactEmail: contact.email,
        agencyName: agency.name,
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
      // Left: a team meeting has no contact (ADR 0038).
      .leftJoin(contact, eq(contact.id, appointment.contactId))
      .innerJoin(agency, eq(agency.id, appointment.agencyId))
      .leftJoin(assignee, eq(assignee.id, appointment.assignedAgentId))
      .leftJoin(assigneeM, and(eq(assigneeM.userId, appointment.assignedAgentId), eq(assigneeM.agencyId, appointment.agencyId), eq(assigneeM.status, 'active')))
      .leftJoin(booker, eq(booker.id, appointment.createdBy))
      .leftJoin(bookerM, and(eq(bookerM.userId, appointment.createdBy), eq(bookerM.agencyId, appointment.agencyId), eq(bookerM.status, 'active')))
      .where(inArray(appointment.id, ids.map((r) => r.id)));

    // A team meeting's colleagues who are still coming and still members. One statement for the batch.
    const colleagues = await tx
      .select({ appointmentId: appointmentParticipant.appointmentId, userId: user.id, email: user.email, name: user.name, role: membership.role })
      .from(appointmentParticipant)
      .innerJoin(user, eq(user.id, appointmentParticipant.userId))
      .innerJoin(membership, and(eq(membership.userId, appointmentParticipant.userId), eq(membership.agencyId, appointmentParticipant.agencyId), eq(membership.status, 'active')))
      .where(and(inArray(appointmentParticipant.appointmentId, ids.map((r) => r.id)), isNull(appointmentParticipant.declinedAt)));

    const out = rows.map((r) => {
      const mine = colleagues.filter((c) => c.appointmentId === r.id);
      const people = reminderRecipients(
        {
          kind: r.kind,
          invitationSentAt: r.invitationSentAt,
          assignee: r.assigneeId && r.assigneeRole && r.assigneeEmail ? { userId: r.assigneeId, email: r.assigneeEmail, name: r.assigneeName, role: r.assigneeRole as MembershipRole } : null,
          booker: r.bookerId && r.bookerRole && r.bookerEmail ? { userId: r.bookerId, email: r.bookerEmail, name: r.bookerName, role: r.bookerRole as MembershipRole } : null,
        },
        mine.map((c) => ({ userId: c.userId, email: c.email, name: c.name, role: c.role as MembershipRole })),
      );
      // Who it is with, for the reminder: the contact, or the team meeting's people.
      const team = [r.assigneeName || r.assigneeEmail, ...mine.map((c) => c.name?.trim() || c.email)].filter((n): n is string => Boolean(n));
      return { ...r, people, linkMissing: zoomLinkMissing(r), withWhom: r.contactName ?? `your colleagues (${team.join(', ')})` };
    });

    const values = out.flatMap((r) =>
      r.people.map((p) => ({
        userId: p.userId,
        agencyId: r.agencyId,
        kind: NOTIFICATION_KIND_REMINDER,
        appointmentId: r.id,
        title: `Starts soon: ${r.title}`,
        body: `${formatInZone(r.startsAt, r.timezone)} · with ${r.withWhom}${r.linkMissing ? ` · ${NO_ZOOM_LINK}` : ''}`,
        href: calendarPath(p, r.agencyId),
        joinUrl: r.meetingUrl,
        // The same start time is reminded once, whatever happens to the claim.
        dedupeKey: `reminder:${r.id}:${r.startsAt.toISOString()}`,
      })),
    );
    if (values.length) {
      const inserted = await tx.insert(notification).values(values).onConflictDoNothing().returning({ id: notification.id });
      report.notified = inserted.length;
    }
    return out;
  });
  report.claimed = claimed.length;

  // ── Emails, after the commit (a network call never runs inside a transaction).
  for (const r of claimed) {
    const when = `${formatInZone(r.startsAt, r.timezone)} – ${new Intl.DateTimeFormat('en-AU', { timeZone: r.timezone, hour: 'numeric', minute: '2-digit' }).format(r.endsAt)}`;
    if (deps.notice) {
      for (const p of r.people) {
        try {
          const base = calendarPath(p, r.agencyId) === '/calendar' ? deps.notice.urls.agencyUrl : deps.notice.urls.agentUrl;
          const sent = await deps.notice.mailer.transport.send(
            buildMeetingReminderEmail({
              to: { email: p.email, ...(p.name ? { name: p.name } : {}) },
              from: deps.notice.mailer.sender.from,
              postalAddress: deps.notice.mailer.sender.postalAddress,
              title: r.title,
              withWhom: r.withWhom,
              when,
              startsIn: startsIn(r.startsAt, now),
              location: r.location,
              joinUrl: r.meetingUrl,
              ...(r.linkMissing ? { problem: NO_ZOOM_LINK } : {}),
              calendarUrl: `${base}${calendarPath(p, r.agencyId)}`,
            }),
          );
          if (sent.ok) report.staffEmailed++;
          else report.failed++;
        } catch {
          report.failed++;
        }
      }
    }

    const sentBy = r.assigneeId ?? r.bookerId;
    // A client appointment only: a team meeting has no contact and no invitation.
    const contactId = r.contactId;
    const contactName = r.contactName;
    if (deps.mail && r.invitationSentAt && contactId && contactName && r.contactEmail && sentBy) {
      try {
        const agentName = r.assigneeName || r.bookerName || 'your agent';
        const { subject, body } = buildContactReminder({ ...r, contactName, type: r.type as AppointmentType }, { agentName, agencyName: r.agencyName }, now);
        const messageId = await db.transaction(async (tx) => {
          const [thread] = await tx
            .insert(mailThread)
            .values({ agencyId: r.agencyId, contactId, subject, contactEmail: r.contactEmail!, contactName })
            .returning({ id: mailThread.id });
          return recordOutbound(tx as unknown as Db, deps.mail!, {
            threadId: thread!.id,
            agencyId: r.agencyId,
            subject,
            to: r.contactEmail!,
            body,
            sentBy,
            channel: 'console',
            kind: REMINDER_KIND,
          });
        });
        const outcome = await deliverOutbound(db, deps.mail, messageId);
        if (outcome.status === 'sent') report.contactsEmailed++;
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
