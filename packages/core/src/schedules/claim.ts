import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { scheduleRun, searchSchedule, user, type Db } from '@repo/db';
import { savedSearchQuerySchema, type SavedSearchQuery } from '../listings/search-url';
import { nextRunFor } from './next-run';
import type { ScheduleCadence } from './schedule-schema';

/** How many schedules one tick will take. A tick that finds more leaves them. */
export const DEFAULT_CLAIM_LIMIT = 10;

/**
 * `ownerId` — narrow a tick to one person's schedules.
 *
 * The scheduler never passes it: a tick's whole job is to find what is due
 * without being told, and `/api/cron/alerts` accepts no parameters at all
 * (§ 9). It exists because the test suite otherwise had no way to exercise
 * the real claim path without sweeping up whatever live schedules happened
 * to be due at the time — and it did, repeatedly, leaving half-finished
 * runs on a real person's saved search.
 *
 * Written as a narrowing rather than a test hook: it composes into the same
 * WHERE as everything else, cannot widen anything, and an omitted value
 * behaves exactly as before.
 */

export type ClaimedSchedule = {
  runId: string;
  scheduleId: string;
  userId: string;
  email: string;
  name: string;
  prompt: string;
  query: SavedSearchQuery;
  /** The slot this run belongs to — the `next_run_at` that was taken. */
  scheduledFor: Date;
  /** Listing ids the previous run reported, for the "what is new" diff. */
  previousListingIds: string[];
  consecutiveFailures: number;
};

type DueRow = {
  id: string;
  userId: string;
  email: string;
  name: string;
  prompt: string;
  query: unknown;
  cadence: ScheduleCadence;
  sendAtMinute: number;
  sendOnWeekday: number | null;
  intervalMinutes: number | null;
  timezone: string;
  nextRunAt: Date;
  consecutiveFailures: number;
};

/**
 * Take up to `limit` due schedules and open a run for each.
 *
 * ## Why this is a short transaction and not the whole run
 *
 * A run makes two network calls — the model and the mail provider — and
 * ARCHITECTURE § 8 says network calls happen before the transaction opens,
 * never inside one. Holding `FOR UPDATE` across an LLM call would also pin a
 * row lock for seconds and park the next tick behind it.
 *
 * So the tick is three phases: claim (this, one short transaction), run (no
 * transaction), record (one short transaction). Nothing here touches a
 * network and the locks live for milliseconds.
 *
 * ## What actually stops a double-send, measured rather than assumed
 *
 * **The unique index on `(schedule_id, scheduled_for)` does all of it.**
 * That was not the original claim in this comment, and the original claim
 * was wrong. Removing `SKIP LOCKED` left the smoke check green; removing
 * `FOR UPDATE` entirely left it green too; dropping the unique index turned
 * it red immediately. So the index is the guard, and the slot — not the row
 * — is the thing being made exclusive.
 *
 * `FOR UPDATE SKIP LOCKED` earns its place for a different reason:
 * **throughput**. Without `SKIP LOCKED` the second tick blocks on the first
 * tick's row locks for as long as the claim transaction runs, then
 * re-evaluates and finds nothing due. Correct, but it serialises every
 * overlapping tick behind the slowest one. With it, the second tick takes
 * the next batch instead of waiting.
 *
 * Both are kept. Neither is redundant, and neither does what the other does:
 * the index is correctness, the skip is liveness, and a row lock dies with
 * its connection where the index survives a deploy, another host and a cron
 * platform that fires the same minute twice.
 */
export async function claimDueSchedules(
  db: Db,
  opts: { now?: Date; limit?: number; ownerId?: string } = {},
): Promise<ClaimedSchedule[]> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? DEFAULT_CLAIM_LIMIT;

  return db.transaction(async (tx) => {
    const due = (await tx
      .select({
        id: searchSchedule.id,
        userId: searchSchedule.userId,
        email: user.email,
        name: searchSchedule.name,
        prompt: searchSchedule.prompt,
        query: searchSchedule.query,
        cadence: searchSchedule.cadence,
        sendAtMinute: searchSchedule.sendAtMinute,
        sendOnWeekday: searchSchedule.sendOnWeekday,
        intervalMinutes: searchSchedule.intervalMinutes,
        timezone: searchSchedule.timezone,
        nextRunAt: searchSchedule.nextRunAt,
        consecutiveFailures: searchSchedule.consecutiveFailures,
      })
      .from(searchSchedule)
      .innerJoin(user, eq(user.id, searchSchedule.userId))
      .where(
        and(
          eq(searchSchedule.status, 'active'),
          lte(searchSchedule.nextRunAt, now),
          ...(opts.ownerId ? [eq(searchSchedule.userId, opts.ownerId)] : []),
        ),
      )
      .orderBy(asc(searchSchedule.nextRunAt), asc(searchSchedule.id))
      .limit(limit)
      /**
       * `of` names which table to lock. Without it the joined `user` row is
       * locked too, and two schedules belonging to the same person would
       * serialise against each other for no reason.
       */
      .for('update', { of: searchSchedule, skipLocked: true })) as DueRow[];

    const claimed: ClaimedSchedule[] = [];

    for (const row of due) {
      /**
       * Anchored on the slot that was claimed, never on `now`.
       *
       * Using `now` would mean a tick that ran twelve hours late pushes the
       * next slot twelve hours late, and the schedule drifts permanently
       * away from the time the person chose. Anchoring on `next_run_at`
       * keeps 8 PM at 8 PM even after an outage.
       */
      const nextRunAt = nextRunFor({
        cadence: row.cadence,
        sendAtMinute: row.sendAtMinute,
        timezone: row.timezone,
        sendOnWeekday: row.sendOnWeekday ?? undefined,
        intervalMinutes: row.intervalMinutes ?? undefined,
        after: row.nextRunAt,
      });

      // The cursor moves whether or not the insert below wins. A schedule
      // that stayed on a slot it can never claim again would be stuck.
      await tx
        .update(searchSchedule)
        .set({ nextRunAt, lastRunAt: now, updatedAt: sql`now()` })
        .where(eq(searchSchedule.id, row.id));

      const parsed = savedSearchQuerySchema.safeParse(row.query);
      if (!parsed.success) {
        /**
         * A stored query this version cannot read is not something to guess
         * at. Skipping leaves the row visible as an active schedule whose
         * `last_run_at` advances and which never delivers, which is at least
         * findable — where running a partial query would email somebody
         * homes they did not ask for and look like it worked.
         */
        continue;
      }

      const [run] = await tx
        .insert(scheduleRun)
        .values({
          scheduleId: row.id,
          userId: row.userId,
          scheduledFor: row.nextRunAt,
          status: 'running',
          query: parsed.data,
        })
        .onConflictDoNothing({
          target: [scheduleRun.scheduleId, scheduleRun.scheduledFor],
        })
        .returning({ id: scheduleRun.id });

      // No row back means this slot already ran somewhere else. The cursor
      // has moved; there is nothing else to do.
      if (!run) continue;

      const [previous] = await tx
        .select({ listingIds: scheduleRun.listingIds })
        .from(scheduleRun)
        .where(and(eq(scheduleRun.scheduleId, row.id), eq(scheduleRun.status, 'delivered')))
        .orderBy(sql`${scheduleRun.scheduledFor} desc`)
        .limit(1);

      claimed.push({
        runId: run.id,
        scheduleId: row.id,
        userId: row.userId,
        email: row.email,
        name: row.name,
        prompt: row.prompt,
        query: parsed.data,
        scheduledFor: row.nextRunAt,
        previousListingIds: previous?.listingIds ?? [],
        consecutiveFailures: row.consecutiveFailures,
      });
    }

    return claimed;
  });
}
