import { and, asc, eq, gt, inArray, lt, ne, sql } from 'drizzle-orm';
import { appointment, type DbOrTx } from '@repo/db';
import { formatInZone } from '../time/local-input';
import { ACTIVE_STATUSES } from './appointment-schema';

/**
 * One agent is never booked twice at once (ADR 0032 §3).
 *
 * The database holds the rule — `appointment_agent_no_overlap`, an EXCLUDE on
 * (assigned_agent_id, tstzrange(starts_at, ends_at, '[)')) over active rows —
 * so two tabs booking the same slot cannot both win. This file is the
 * readable half: `findClash` asks first so the person is told WHICH meeting is
 * in the way, and `isOverlapViolation` turns the constraint's error (a race
 * the check lost) into the same kind of sentence.
 *
 * Half-open, like the constraint: a meeting ending at 20:00 and one starting
 * at 20:00 do not clash.
 */

export const OVERLAP_CONSTRAINT = 'appointment_agent_no_overlap';

export type Clash = { id: string; title: string; startsAt: Date; endsAt: Date; timezone: string };

/** The first active appointment of this agent that overlaps [startsAt, endsAt), other than `excludeId`. */
export async function findClash(
  db: DbOrTx,
  agentId: string,
  startsAt: Date,
  endsAt: Date,
  excludeId?: string,
): Promise<Clash | null> {
  const [row] = await db
    .select({
      id: appointment.id,
      title: appointment.title,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      timezone: appointment.timezone,
    })
    .from(appointment)
    .where(
      and(
        eq(appointment.assignedAgentId, agentId),
        inArray(appointment.status, [...ACTIVE_STATUSES]),
        lt(appointment.startsAt, endsAt),
        gt(appointment.endsAt, startsAt),
        ...(excludeId ? [ne(appointment.id, excludeId)] : []),
      ),
    )
    .orderBy(asc(appointment.startsAt), asc(appointment.id))
    .limit(1);
  return row ?? null;
}

/** For the screen: who is busy, with what, when — in the zone the other meeting was booked in. */
export function clashMessage(c: Clash, forSelf: boolean): string {
  const until = new Intl.DateTimeFormat('en-AU', { timeZone: c.timezone, hour: 'numeric', minute: '2-digit' }).format(c.endsAt);
  const who = forSelf ? 'You already have' : 'That agent already has';
  return `${who} “${c.title}” at that time (${formatInZone(c.startsAt, c.timezone)} – ${until}). Pick another time.`;
}

/** The message when the constraint, not the check, refused it. */
export const OVERLAP_MESSAGE = 'Someone just booked that time for this agent. Pick another time.';

/** True when `err` is the no-overlap constraint (Postgres 23P01), however the driver wrapped it. */
export function isOverlapViolation(err: unknown): boolean {
  for (let e = err as { code?: unknown; constraint_name?: unknown; constraint?: unknown; cause?: unknown } | undefined, i = 0; e && i < 4; e = e.cause as typeof e, i++) {
    if (e.code === '23P01' && (e.constraint_name ?? e.constraint ?? OVERLAP_CONSTRAINT) === OVERLAP_CONSTRAINT) return true;
  }
  return false;
}

/**
 * Of `ids`, the ones that would overlap an active appointment `agentId`
 * already holds — so a hand-over moves the rest and queues these (offboarding).
 * One statement.
 */
export async function clashingIds(db: DbOrTx, agentId: string, ids: readonly string[]): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await db
    .select({ id: appointment.id })
    .from(appointment)
    .where(
      and(
        inArray(appointment.id, [...ids]),
        sql`exists (
          select 1 from ${appointment} other
          where other.assigned_agent_id = ${agentId}
            and other.status in ('scheduled', 'rescheduled')
            and other.id <> ${appointment.id}
            and other.starts_at < ${appointment.endsAt}
            and other.ends_at > ${appointment.startsAt}
        )`,
      ),
    );
  return rows.map((r) => r.id);
}
