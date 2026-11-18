import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import { jobFailure, runJobs, type JobRow } from './index';

/** PLATFORM-PLAN 3.1: the runner's outcomes. The claim itself (fair share, lease, dedupe) is proven on the dev database. */
const NOW = new Date('2026-11-19T00:00:00Z');
const row = (over: Partial<JobRow> = {}): JobRow =>
  ({ id: 'j1', agencyId: 'a1', kind: 'test.ok', lane: 'send', payload: {}, dedupeKey: null, status: 'running', attempts: 1, maxAttempts: 5, runAt: NOW, claimedAt: NOW, finishedAt: null, lastError: null, createdAt: NOW, ...over }) as JobRow;

/** A fake database: `execute` (the claim) returns the given rows; updates are recorded. */
function fakeDb(claimed: JobRow[]) {
  const updates: Record<string, unknown>[] = [];
  let claims = 0;
  const db = {
    execute: async () => (claims++, claimed),
    update: () => ({ set: (s: Record<string, unknown>) => ({ where: async () => void updates.push(s) }) }),
  };
  return { db: db as unknown as Db, updates, claims: () => claims };
}

describe('jobFailure', () => {
  it('retries after 1, 5, 15, then 60 minutes', () => {
    const waits = [1, 2, 3, 4].map((attempts) => ((jobFailure({ attempts, maxAttempts: 5 }, 'x', NOW).runAt as Date).getTime() - NOW.getTime()) / 60_000);
    expect(waits).toEqual([1, 5, 15, 60]);
  });
  it('the last attempt is dead, with its error', () => {
    expect(jobFailure({ attempts: 5, maxAttempts: 5 }, 'gone', NOW)).toMatchObject({ status: 'dead', finishedAt: NOW, lastError: 'gone' });
  });
});

describe('runJobs', () => {
  const opts = { lane: 'send' as const, now: () => NOW, env: {} as NodeJS.ProcessEnv };

  it('a job that succeeds is done', async () => {
    const { db, updates } = fakeDb([row()]);
    const r = await runJobs(db, { 'test.ok': async () => {} }, opts);
    expect(r).toMatchObject({ claimed: 1, done: 1, retried: 0, dead: 0 });
    expect(updates[0]).toMatchObject({ status: 'done', finishedAt: NOW });
  });

  it('a job that throws is queued again with its error; on its last attempt it is dead', async () => {
    const boom = { 'test.ok': async () => { throw new Error('vendor 503'); } };
    const first = fakeDb([row({ attempts: 1 })]);
    expect(await runJobs(first.db, boom, opts)).toMatchObject({ retried: 1, dead: 0 });
    expect(first.updates[0]).toMatchObject({ status: 'queued', lastError: 'vendor 503', claimedAt: null });
    const last = fakeDb([row({ attempts: 5 })]);
    expect(await runJobs(last.db, boom, opts)).toMatchObject({ retried: 0, dead: 1 });
    expect(last.updates[0]).toMatchObject({ status: 'dead', lastError: 'vendor 503' });
  });

  it('a kind with no handler is dead at once, not retried for an hour', async () => {
    const { db, updates } = fakeDb([row({ kind: 'test.unknown' })]);
    expect(await runJobs(db, {}, opts)).toMatchObject({ dead: 1 });
    expect(updates[0]).toMatchObject({ status: 'dead', lastError: 'No handler for job kind test.unknown' });
  });

  it('one failing job does not stop the next one', async () => {
    const { db } = fakeDb([row({ id: 'j1', kind: 'test.bad' }), row({ id: 'j2' })]);
    const r = await runJobs(db, { 'test.bad': async () => { throw new Error('x'); }, 'test.ok': async () => {} }, opts);
    expect(r).toMatchObject({ claimed: 2, done: 1, retried: 1 });
  });

  it('SENDS_PAUSED=1 stops the send lane without claiming; other lanes run', async () => {
    const paused = fakeDb([row()]);
    expect(await runJobs(paused.db, { 'test.ok': async () => {} }, { ...opts, env: { SENDS_PAUSED: '1' } as unknown as NodeJS.ProcessEnv })).toMatchObject({ paused: true, claimed: 0 });
    expect(paused.claims()).toBe(0);
    const bulk = fakeDb([row({ lane: 'bulk' })]);
    expect(await runJobs(bulk.db, { 'test.ok': async () => {} }, { ...opts, lane: 'bulk', env: { SENDS_PAUSED: '1' } as unknown as NodeJS.ProcessEnv })).toMatchObject({ done: 1 });
  });

  it('says there is more when the batch came back full', async () => {
    const { db } = fakeDb([row({ id: 'a' }), row({ id: 'b' })]);
    expect((await runJobs(db, { 'test.ok': async () => {} }, { ...opts, limit: 2 })).more).toBe(true);
  });
});

describe('dead jobs: who may see and replay them', () => {
  const admin = { userId: '99999999-9999-9999-9999-999999999999', platformAdmin: true } as const;
  const owner = { userId: '33333333-3333-3333-3333-333333333333', agencyId: '11111111-1111-1111-1111-111111111111', membershipRole: 'owner' } as const;
  const ID = '22222222-2222-2222-2222-222222222222';

  it('an agency owner may neither list nor replay', async () => {
    const { listDeadJobs, replayJob } = await import('../platform/manage');
    await expect(listDeadJobs({} as unknown as Db, owner)).rejects.toThrow(/platform admin/);
    await expect(replayJob({} as unknown as Db, owner, ID)).rejects.toThrow(/platform admin/);
  });

  it('a platform admin replays a dead job: queued now, attempts reset, recorded; a live job is refused', async () => {
    const { replayJob } = await import('../platform/manage');
    const sets: unknown[] = [];
    const inserts: unknown[] = [];
    const tx = (found: boolean) => ({
      update: () => ({ set: (s: unknown) => (sets.push(s), { where: () => ({ returning: async () => (found ? [{ agencyId: 'a1', kind: 'sms.reconcile', lastError: 'x' }] : []) }) }) }),
      insert: () => ({ values: async (v: unknown) => void inserts.push(v) }),
    });
    const db = (found: boolean) => ({ transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx(found)) }) as unknown as Db;
    await replayJob(db(true), admin, ID, NOW);
    expect(sets[0]).toEqual({ status: 'queued', attempts: 0, runAt: NOW, claimedAt: null, finishedAt: null });
    expect(inserts).toEqual([expect.objectContaining({ action: 'job_replayed', detail: expect.objectContaining({ jobId: ID }) })]);
    await expect(replayJob(db(false), admin, ID, NOW)).rejects.toThrow(/not a dead one/);
    expect(inserts).toHaveLength(1);
  });
});
