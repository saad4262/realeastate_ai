import { and, eq, lt, sql } from 'drizzle-orm';
import { scheduleRun, type Db } from '@repo/db';

/**
 * How long a run may sit in `running` before it is presumed dead.
 *
 * Generous on purpose. A real run is SQL, one model call and one HTTP send —
 * seconds, not minutes — but the tick runs on a platform that can be slow to
 * schedule and a 30-minute window means this can only ever reach a run that
 * genuinely is not coming back. The cost of being wrong in the other
 * direction is marking a run failed while it is still working, which would
 * then finish and write over its own obituary.
 */
export const ABANDONED_RUN_MINUTES = 30;

/**
 * Close out runs that were claimed and never finished.
 *
 * ## Why these exist at all
 *
 * `claimDueSchedules` writes a `running` row inside the claim transaction,
 * and the work happens after it commits — deliberately, because the work
 * makes two network calls and ARCHITECTURE § 8 keeps those outside a
 * transaction. The consequence is honest and unavoidable: if the process
 * dies between the claim and the finish, the row stays `running` for ever.
 *
 * Nothing breaks. The schedule's cursor has already moved, each run is keyed
 * on its own slot, and the next tick proceeds normally — which is exactly
 * why it went unnoticed: four of these were found sitting on a live saved
 * search, written by a test suite that claimed rows it did not own.
 *
 * ## Marked, not deleted
 *
 * A stuck row is evidence that a run started and died, and the failure of a
 * scheduled email is precisely the thing this system must not hide — the
 * failure policy here is the opposite of `revalidate-web.ts`'s deliberate
 * best-effort. Deleting would make a lost alert indistinguishable from one
 * that never happened. `/alerts` reads `delivered` runs only, so a failed
 * row is invisible to the person and findable by whoever is looking.
 *
 * `consecutiveFailures` is deliberately NOT incremented: the schedule did
 * nothing wrong, the process died, and three crashed deploys should not
 * silently switch somebody's alerts off.
 */
export async function sweepAbandonedRuns(
  db: Db,
  opts: { now?: Date; olderThanMinutes?: number } = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  const minutes = opts.olderThanMinutes ?? ABANDONED_RUN_MINUTES;
  const cutoff = new Date(now.getTime() - minutes * 60_000);

  const swept = await db
    .update(scheduleRun)
    .set({
      status: 'failed',
      error: `Abandoned: still running ${minutes} minutes after it was claimed.`,
      emailStatus: 'skipped',
      finishedAt: now,
      updatedAt: sql`now()`,
    })
    .where(and(eq(scheduleRun.status, 'running'), lt(scheduleRun.createdAt, cutoff)))
    .returning({ id: scheduleRun.id });

  return swept.length;
}
