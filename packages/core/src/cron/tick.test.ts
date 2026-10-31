import { describe, expect, it } from 'vitest';
import { MIN_ROUND_MS, runTick, type TickJob } from './tick';
import { MINUTE_BATCH, minuteJobs } from './minute-jobs';
import type { Db } from '@repo/db';

/** A fake clock that moves only when a job "works". */
function clockOf() {
  let t = 0;
  return { now: () => t, spend: (ms: number) => (t += ms) };
}

/** A drain job with `queue` items, `batch` per round, each round costing `ms`. */
function queueJob(name: string, c: ReturnType<typeof clockOf>, queue: number, batch: number, ms: number, extra: Partial<TickJob> = {}): TickJob & { left: () => number } {
  let left = queue;
  return {
    name,
    mode: 'drain',
    left: () => left,
    run: async () => {
      c.spend(ms);
      const took = Math.min(batch, left);
      left -= took;
      return { result: { done: took }, more: took === batch };
    },
    ...extra,
  };
}

describe('the tick runner (ADR 0073)', () => {
  it('gives every job one round before draining any queue, so a busy job never starves the rest', async () => {
    const c = clockOf();
    const order: string[] = [];
    const busy: TickJob = { name: 'busy', mode: 'drain', run: async () => (order.push('busy'), c.spend(1_000), { result: { n: 1 }, more: true }) };
    const quiet: TickJob = { name: 'quiet', mode: 'once', run: async () => (order.push('quiet'), c.spend(100), { result: { n: 1 }, more: false }) };
    await runTick([busy, quiet], { budgetMs: 10_000, clock: c.now, minute: 0 });
    expect(order.slice(0, 2)).toEqual(['busy', 'quiet']);
    expect(order.filter((x) => x === 'quiet')).toHaveLength(1);
  });

  it('drains a full queue in rounds until it is empty', async () => {
    const c = clockOf();
    const job = queueJob('emails', c, 250, 100, 500);
    const r = await runTick([job], { budgetMs: 30_000, clock: c.now, minute: 0 });
    expect(job.left()).toBe(0);
    expect(r.jobs.emails!.rounds).toBe(3);
    expect(r.jobs.emails!.result.done).toBe(250);
    expect(r.jobs.emails!.more).toBe(false);
  });

  it('starts no round that would likely run past the deadline, and says there is more', async () => {
    const c = clockOf();
    const job = queueJob('slow', c, 1_000, 10, 4_000);
    const r = await runTick([job], { budgetMs: 10_000, clock: c.now, minute: 0 });
    // 0 → 4 s → 8 s; a third round (4 s, its slowest) would end at 12 s > 10 s.
    expect(r.jobs.slow!.rounds).toBe(2);
    expect(r.jobs.slow!.more).toBe(true);
    expect(c.now()).toBeLessThanOrEqual(10_000);
  });

  it('skips a job when even one round no longer fits', async () => {
    const c = clockOf();
    const hog: TickJob = { name: 'hog', mode: 'once', run: async () => (c.spend(10_000 - MIN_ROUND_MS + 1), { result: {}, more: false }) };
    const late: TickJob = { name: 'late', mode: 'once', run: async () => ({ result: {}, more: false }) };
    const r = await runTick([hog, late], { budgetMs: 10_000, clock: c.now, minute: 0 });
    expect(r.jobs.late!.skipped).toBe('out_of_time');
  });

  it('keeps a failing job to itself: the others still run', async () => {
    const c = clockOf();
    const bad: TickJob = { name: 'bad', mode: 'drain', run: async () => { throw new Error('db down'); } };
    const ok = queueJob('ok', c, 5, 10, 100);
    const r = await runTick([bad, ok], { budgetMs: 10_000, clock: c.now, minute: 0 });
    expect(r.jobs.bad!.error).toBe('db down');
    expect(r.jobs.bad!.rounds).toBe(1);
    expect(r.jobs.ok!.result.done).toBe(5);
  });

  it('runs an every-five-minutes job only on those minutes', async () => {
    const c = clockOf();
    let runs = 0;
    const kyc: TickJob = { name: 'kyc', mode: 'once', everyMinutes: 5, run: async () => (runs++, { result: {}, more: false }) };
    expect((await runTick([kyc], { budgetMs: 10_000, clock: c.now, minute: 7 })).jobs.kyc!.skipped).toBe('not_this_minute');
    await runTick([kyc], { budgetMs: 10_000, clock: c.now, minute: 10 });
    expect(runs).toBe(1);
  });

  it('runs a drain job’s workers in parallel and sums what they did', async () => {
    const c = clockOf();
    let inFlight = 0;
    let most = 0;
    let left = 30;
    const job: TickJob = {
      name: 'scheduled',
      mode: 'drain',
      concurrency: 2,
      run: async () => {
        inFlight++;
        most = Math.max(most, inFlight);
        await Promise.resolve();
        inFlight--;
        c.spend(100);
        const took = Math.min(10, left);
        left -= took;
        return { result: { ran: took }, more: took === 10 };
      },
    };
    const r = await runTick([job], { budgetMs: 10_000, clock: c.now, minute: 0 });
    expect(most).toBe(2);
    expect(r.jobs.scheduled!.result.ran).toBe(30);
  });
});

describe('the minute jobs', () => {
  const noDb = new Proxy({}, { get: () => { throw new Error('the database was reached'); } }) as unknown as Db;
  it('puts the time-critical jobs first and builds without touching the database', () => {
    const jobs = minuteJobs(noDb, { decider: null, understander: null, scheduled: {}, reminders: {}, zoomAlerts: {}, platformMail: null, phone: { keys: null, client: () => { throw new Error('x'); }, webhookBase: null }, voice: null });
    expect(jobs.map((j) => j.name)).toEqual(['understandLeads', 'workflows', 'scheduled', 'reminders', 'aiCalls', 'platformEmails', 'zoomAlerts', 'deals', 'phoneKyc']);
    expect(jobs.find((j) => j.name === 'scheduled')!.concurrency).toBe(2);
    expect(jobs.find((j) => j.name === 'phoneKyc')!.everyMinutes).toBe(5);
    expect(MINUTE_BATCH.scheduledActions).toBeGreaterThan(0);
  });
});
