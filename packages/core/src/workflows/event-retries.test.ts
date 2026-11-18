import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import { EVENT_MAX_ATTEMPTS, failureUpdate, runWorkflowTick } from './engine';

/**
 * PLATFORM-PLAN 3.1: a workflow event that throws is retried with backoff and, after the last attempt,
 * dead-lettered where it can be seen — never marked processed as if it had run. Before this, the catch
 * logged to the console and the event was spent.
 */
const NOW = new Date('2026-11-19T00:00:00Z');
const event = (attempts = 0) => ({ id: 'ev-1', agencyId: 'ag-1', kind: 'lead.created', origin: 'website', attempts, occurredAt: NOW, claimedAt: NOW, processedAt: null });

describe('failureUpdate', () => {
  it('first failures: back to the queue, after 1, 5, 15 then 60 minutes, claim released, error kept', () => {
    const minutes = [1, 5, 15, 60].map((m, i) => {
      const u = failureUpdate(event(i), 'boom', NOW);
      expect(u).toMatchObject({ attempts: i + 1, lastError: 'boom', claimedAt: null });
      expect(u).not.toHaveProperty('processedAt');
      return ((u.retryAt as Date).getTime() - NOW.getTime()) / 60_000;
    });
    expect(minutes).toEqual([1, 5, 15, 60]);
  });

  it('the last attempt: dead-lettered — processed and failed, with the error', () => {
    const u = failureUpdate(event(EVENT_MAX_ATTEMPTS - 1), 'still broken', NOW);
    expect(u).toMatchObject({ attempts: EVENT_MAX_ATTEMPTS, processedAt: NOW, failedAt: NOW, lastError: 'still broken' });
  });

  it('keeps at most 500 characters of the error', () => {
    expect((failureUpdate(event(), 'x'.repeat(2_000), NOW).lastError as string).length).toBe(500);
  });
});

/** A fake database: one event is claimed, then loading its workflows throws. Records every update. */
function failingDb() {
  const updates: unknown[] = [];
  const claims: string[] = [];
  const chain = (terminal: () => unknown) => {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'orderBy', 'limit', 'for']) c[m] = () => c;
    c.where = (w: SQL) => {
      claims.push(new PgDialect().sqlToQuery(w).sql);
      return c;
    };
    c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve().then(terminal).then(res, rej);
    return c;
  };
  const tx = {
    select: () => chain(() => [{ id: 'ev-1' }]),
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [event(0)] }) }) }),
  };
  const db = {
    transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    select: () => chain(() => {
      throw new Error('workflows could not be read');
    }),
    update: () => ({ set: (s: unknown) => ({ where: async () => void updates.push(s) }) }),
  };
  return { db: db as unknown as Db, updates, claims };
}

describe('runWorkflowTick when an event throws', () => {
  it('records the failure for a retry, and does not mark the event processed', async () => {
    const { db, updates } = failingDb();
    const report = await runWorkflowTick(db, NOW, 10, { scans: false });
    expect(report.events).toBe(1);
    expect(report.failed).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ attempts: 1, lastError: 'workflows could not be read', claimedAt: null });
    expect(updates[0]).not.toHaveProperty('processedAt');
  });

  it('claims only events whose retry time has come', async () => {
    const { db, claims } = failingDb();
    await runWorkflowTick(db, NOW, 10, { scans: false });
    expect(claims[0]).toMatch(/"retry_at" is null or "workflow_event"."retry_at" <=/);
  });
});

describe('dead letters: who may see and replay them', () => {
  const admin = { userId: '99999999-9999-9999-9999-999999999999', platformAdmin: true } as const;
  const owner = { userId: '33333333-3333-3333-3333-333333333333', agencyId: '11111111-1111-1111-1111-111111111111', membershipRole: 'owner' } as const;
  const ID = '22222222-2222-2222-2222-222222222222';

  it('an agency owner may neither list nor replay', async () => {
    const { listFailedWorkflowEvents, replayWorkflowEvent } = await import('../platform/manage');
    const none = {} as unknown as Db;
    await expect(listFailedWorkflowEvents(none, owner)).rejects.toThrow(/platform admin/);
    await expect(replayWorkflowEvent(none, owner, ID)).rejects.toThrow(/platform admin/);
  });

  it('a platform admin replays a failed event: back in the queue, attempts reset, recorded', async () => {
    const { replayWorkflowEvent } = await import('../platform/manage');
    const sets: unknown[] = [];
    const inserts: unknown[] = [];
    const tx = {
      update: () => ({ set: (s: unknown) => (sets.push(s), { where: () => ({ returning: async () => [{ agencyId: 'ag-1', kind: 'lead.created', lastError: 'boom' }] }) }) }),
      insert: () => ({ values: async (v: unknown) => void inserts.push(v) }),
    };
    const db = { transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as unknown as Db;
    await replayWorkflowEvent(db, admin, ID);
    expect(sets).toEqual([{ attempts: 0, retryAt: null, failedAt: null, processedAt: null, claimedAt: null }]);
    expect(inserts).toEqual([expect.objectContaining({ action: 'event_replayed', agencyId: 'ag-1', detail: expect.objectContaining({ eventId: ID }) })]);
  });

  it('replaying an event that is not failed says so and records nothing', async () => {
    const { replayWorkflowEvent } = await import('../platform/manage');
    const inserts: unknown[] = [];
    const tx = { update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }), insert: () => ({ values: async (v: unknown) => void inserts.push(v) }) };
    const db = { transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as unknown as Db;
    await expect(replayWorkflowEvent(db, admin, ID)).rejects.toThrow(/not a failed one/);
    expect(inserts).toEqual([]);
  });
});
