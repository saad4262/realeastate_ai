import { and, eq, sql } from 'drizzle-orm';
import { job, type Db, type DbOrTx } from '@repo/db';
import { BILLING_HELD } from '../platform/access';

/**
 * The job queue (PLATFORM-PLAN 3.1). Background work goes in with `enqueueJob` and is run by `runJobs` from the
 * minute tick: a fair share per agency per claim, so one agency's thousands of jobs never hold up another's one;
 * retries with backoff; a dead letter after the last attempt, never silent loss; a claim that outlives its lease
 * (a crashed run) is taken again. Handlers must be idempotent: a job can run twice if a run dies after its work
 * and before it is marked done.
 */
export type JobLane = 'urgent' | 'send' | 'bulk';
export type JobRow = typeof job.$inferSelect;
export type JobHandler = (db: Db, j: JobRow) => Promise<void>;

export const JOB_LEASE_MS = 5 * 60_000;
const RETRY_MINUTES = [1, 5, 15, 60];

export type EnqueueInput = {
  kind: string;
  lane?: JobLane;
  agencyId?: string | null;
  payload?: Record<string, unknown>;
  /** The same (kind, key) is enqueued once; a second enqueue is a no-op. */
  dedupeKey?: string | null;
  runAt?: Date;
  maxAttempts?: number;
};

/** Enqueue, inside the caller's transaction when it has one. Returns null when the dedupe key already exists. */
export async function enqueueJob(db: DbOrTx, j: EnqueueInput): Promise<string | null> {
  const [row] = await db
    .insert(job)
    .values({
      kind: j.kind,
      lane: j.lane ?? 'send',
      agencyId: j.agencyId ?? null,
      payload: j.payload ?? {},
      dedupeKey: j.dedupeKey ?? null,
      ...(j.runAt ? { runAt: j.runAt } : {}),
      ...(j.maxAttempts ? { maxAttempts: j.maxAttempts } : {}),
    })
    .onConflictDoNothing({ target: [job.kind, job.dedupeKey], where: sql`dedupe_key is not null` })
    .returning({ id: job.id });
  return row?.id ?? null;
}

/**
 * Claim up to `limit` jobs of one lane: ready ones (queued, due) and abandoned ones (running past the lease),
 * at most `perAgency` per agency in this claim, oldest first within an agency, and agencies taken in turn.
 * A suspended agency's jobs wait. One statement; `SKIP LOCKED` keeps two ticks off the same row.
 * shortcut: the window ranks every ready row of the lane; at V2 volumes switch to a LATERAL top-N per agency.
 */
export async function claimJobs(db: DbOrTx, opts: { lane: JobLane; limit: number; perAgency: number; now: Date }): Promise<JobRow[]> {
  const stale = new Date(opts.now.getTime() - JOB_LEASE_MS).toISOString();
  const now = opts.now.toISOString();
  const rows = await db.execute<Record<string, unknown>>(sql`
    with ready as (
      select j.id, j.run_at,
             row_number() over (partition by coalesce(j.agency_id::text, '') order by j.run_at, j.id) as rn
      from job j
      where j.lane = ${opts.lane}
        and ((j.status = 'queued' and j.run_at <= ${now}::timestamptz) or (j.status = 'running' and j.claimed_at < ${stale}::timestamptz))
        and (j.agency_id is null or j.agency_id not in (select a.id from agency a where a.status = 'suspended'
          or (${opts.lane} = 'send' and (a.sends_paused_at is not null or ${BILLING_HELD('a')}))))
    ), picked as (
      select j.id from job j join ready r on r.id = j.id
      where r.rn <= ${opts.perAgency}
      order by r.rn, r.run_at
      limit ${opts.limit}
      for update of j skip locked
    )
    update job set status = 'running', claimed_at = ${now}::timestamptz, attempts = job.attempts + 1
    where job.id in (select id from picked)
    returning job.id, job.agency_id as "agencyId", job.kind, job.lane, job.payload, job.dedupe_key as "dedupeKey",
      job.status, job.attempts, job.max_attempts as "maxAttempts", job.run_at as "runAt", job.claimed_at as "claimedAt",
      job.finished_at as "finishedAt", job.last_error as "lastError", job.created_at as "createdAt"`);
  return rows as unknown as JobRow[];
}

/** What a failed job becomes: queued again after a wait, or dead after its last attempt. `attempts` already counts this run. */
export function jobFailure(j: Pick<JobRow, 'attempts' | 'maxAttempts'>, message: string, now: Date): Partial<typeof job.$inferInsert> {
  const lastError = message.slice(0, 500);
  if (j.attempts >= j.maxAttempts) return { status: 'dead', finishedAt: now, lastError, claimedAt: null };
  const wait = RETRY_MINUTES[Math.min(j.attempts - 1, RETRY_MINUTES.length - 1)]!;
  return { status: 'queued', runAt: new Date(now.getTime() + wait * 60_000), claimedAt: null, lastError };
}

export type JobRunReport = { claimed: number; done: number; retried: number; dead: number; paused: boolean; more: boolean };

/**
 * Claim one batch of a lane and run each job through its kind's handler. A kind with no handler is dead at once
 * (a deploy that dropped it must be seen, not retried for an hour). `SENDS_PAUSED=1` stops the send lane
 * platform-wide (PLATFORM-PLAN 3.7): its jobs stay queued.
 */
export async function runJobs(
  db: Db,
  handlers: Record<string, JobHandler>,
  opts: { lane: JobLane; limit?: number; perAgency?: number; now?: () => Date; env?: NodeJS.ProcessEnv },
): Promise<JobRunReport> {
  const report: JobRunReport = { claimed: 0, done: 0, retried: 0, dead: 0, paused: false, more: false };
  const env = opts.env ?? process.env;
  if (opts.lane === 'send' && env.SENDS_PAUSED?.trim() === '1') return { ...report, paused: true };
  const clock = opts.now ?? (() => new Date());
  const limit = opts.limit ?? 20;
  const claimed = await claimJobs(db, { lane: opts.lane, limit, perAgency: opts.perAgency ?? 2, now: clock() });
  report.claimed = claimed.length;
  report.more = claimed.length === limit;
  for (const j of claimed) {
    const handler = handlers[j.kind];
    try {
      if (!handler) throw new Error(`No handler for job kind ${j.kind}`);
      await handler(db, j);
      await db.update(job).set({ status: 'done', finishedAt: clock(), claimedAt: null, lastError: null }).where(and(eq(job.id, j.id), eq(job.status, 'running')));
      report.done += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const next = handler ? jobFailure(j, message, clock()) : { status: 'dead', finishedAt: clock(), lastError: message, claimedAt: null };
      await db.update(job).set(next).where(eq(job.id, j.id));
      if (next.status === 'dead') report.dead += 1;
      else report.retried += 1;
      console.error(`[jobs] ${j.kind} ${j.id} attempt ${j.attempts} failed:`, message);
    }
  }
  return report;
}
