import { and, asc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { agency, appointment, contact, user, type Db } from '@repo/db';
import { can } from '../permissions';
import { provenAddress } from '../mail/verify-email';
import type { CustomerIdentity } from '../mail/customer';
import type { AppointmentStatus, AppointmentType } from './appointment-schema';

/**
 * A buyer's meetings on the website (ADR 0032 §5).
 *
 * Theirs = the contact's address is the one they PROVED they receive mail at
 * (the same rule as /account/messages, ADR 0016 — sign-up confirms nothing),
 * AND the agency sent them the invitation. A meeting nobody told them about is
 * not shown: the invitation is what makes it theirs to see, and its join link
 * is already in that email.
 *
 * Upcoming and still-running ones, soonest first — and a cancelled one that
 * was still to come, so the page can say it is off. Internal notes, the
 * outcome and the agent's own fields are never selected.
 */

export type CustomerMeeting = {
  id: string;
  title: string;
  type: AppointmentType;
  status: AppointmentStatus;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  location: string | null;
  meetingUrl: string | null;
  agencyName: string;
  agentName: string | null;
};

export type CustomerMeetingList = { rows: CustomerMeeting[]; addressProved: boolean };

/** Two statements: the proof, then the list. */
export async function listCustomerMeetings(
  db: Db,
  who: CustomerIdentity,
  opts: { now?: Date; limit?: number } = {},
): Promise<CustomerMeetingList> {
  if (!can({ userId: who.userId }, 'meeting:read_own', { type: 'meeting', ownerId: who.userId })) {
    return { rows: [], addressProved: false };
  }
  const proved = await provenAddress(db, who);
  if (!proved) return { rows: [], addressProved: false };
  const now = opts.now ?? new Date();

  const rows = await db
    .select({
      id: appointment.id,
      title: appointment.title,
      type: appointment.type,
      status: appointment.status,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      timezone: appointment.timezone,
      location: appointment.location,
      meetingUrl: appointment.meetingUrl,
      agencyName: agency.name,
      agentName: user.name,
    })
    .from(appointment)
    .innerJoin(contact, eq(contact.id, appointment.contactId))
    .innerJoin(agency, eq(agency.id, appointment.agencyId))
    .leftJoin(user, eq(user.id, appointment.assignedAgentId))
    .where(
      and(
        sql`lower(${contact.email}) = ${proved}`,
        isNotNull(appointment.invitationSentAt),
        inArray(appointment.status, ['scheduled', 'rescheduled', 'cancelled']),
        gte(appointment.endsAt, now),
      ),
    )
    .orderBy(asc(appointment.startsAt), asc(appointment.id))
    .limit(Math.min(opts.limit ?? 20, 50));

  return { rows: rows as CustomerMeeting[], addressProved: true };
}
