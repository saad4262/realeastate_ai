import { getTableName, type Table } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { automationWords, bulkEmailSpecSchema } from './kinds';
import { createAutomation, setAutomationStatus, stopAutomationRun } from './manage';
import { claimDueAutomations, runAutomationNow, runAutomationTick } from './tick';

/** ADR 0089: the clock and the rules, against a scripted database and a fake runner. */

const runner = vi.hoisted(() => ({ people: vi.fn(), chunkSize: vi.fn(() => 2), send: vi.fn() }));
const activeMemberActor = vi.hoisted(() => vi.fn());
const isSkillOnForChat = vi.hoisted(() => vi.fn());
vi.mock('./runners', () => ({ AUTOMATION_RUNNERS: { bulk_email: runner, bulk_sms: runner } }));
vi.mock('../team/member-actor', () => ({ activeMemberActor }));
vi.mock('../skill-switches/switches', async (real) => ({ ...(await real<object>()), isSkillOnForChat }));

const A = '11111111-1111-1111-1111-111111111111';
const ID = '00000000-0000-4000-8000-000000000001';
const owner: Actor = { userId: 'boss', agencyId: A, membershipRole: 'owner' };
const agent: Actor = { userId: 'u1', agencyId: A, membershipRole: 'agent' };
const NOW = new Date('2026-11-09T22:00:00Z');
const spec = { templateId: ID, templateName: 'Spring', filterId: ID, listName: 'Buyers' };

/** Selects answer from per-table queues; every write is recorded. */
function script(answers: Record<string, unknown[][]>) {
  const updates: { table: string; set: Record<string, unknown> }[] = [];
  const inserts: { table: string; values: Record<string, unknown> }[] = [];
  const db = {
    select: () => {
      let rows: unknown[] = [];
      const chain: Record<string, unknown> = {
        from: (t: Table) => ((rows = answers[getTableName(t)]?.shift() ?? []), chain),
        then: (res: (v: unknown) => unknown) => Promise.resolve(rows).then(res),
      };
      for (const m of ['where', 'orderBy', 'limit', 'for', 'innerJoin', 'leftJoin']) chain[m] = () => chain;
      return chain;
    },
    update: (t: Table) => ({
      set: (set: Record<string, unknown>) => {
        updates.push({ table: getTableName(t), set });
        const done = Promise.resolve([{ id: 'x' }]);
        return { where: () => Object.assign(done, { returning: async () => [{ id: 'x' }] }) };
      },
    }),
    insert: (t: Table) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table: getTableName(t), values });
        const returning = async () => [{ id: 'new-run' }];
        return { returning, onConflictDoNothing: () => ({ returning }) };
      },
    }),
    transaction: async (fn: (t: unknown) => unknown) => fn(db),
  } as unknown as Db;
  return { db, updates, inserts };
}

const row = (over: object = {}) => ({ id: ID, agencyId: A, userId: 'u1', skillKey: 'bulk_email', kind: 'bulk_email', name: 'Monday', spec, status: 'active', cadence: 'daily', sendAtMinute: 540, sendOnWeekday: null, intervalMinutes: null, timezone: 'Australia/Sydney', nextRunAt: NOW, consecutiveFailures: 0, ...over });
const run = (over: object = {}) => ({ id: 'r1', automationId: ID, agencyId: A, userId: 'u1', status: 'running', contactIds: [], cursor: 0, sent: 0, failed: 0, skipped: 0, leaseUntil: null, ...over });
const deps = { templateSend: null, sms: null };
const runUpdates = (u: ReturnType<typeof script>['updates']) => u.filter((x) => x.table === 'automation_run').map((x) => x.set);

beforeEach(() => {
  vi.clearAllMocks();
  activeMemberActor.mockResolvedValue(agent);
  isSkillOnForChat.mockResolvedValue(true);
  runner.people.mockResolvedValue({ contactIds: ['c1', 'c2', 'c3'], skipped: 1 });
  runner.send.mockResolvedValue({ sent: 2, failed: 0, skipped: 0 });
});

describe('what it does, in words', () => {
  it('says the template and the list', () => {
    expect(automationWords('bulk_email', spec)).toBe('Sends “Spring” to everyone on “Buyers” who may receive it');
  });
  it('a spec it cannot read is refused, and holds nothing extra', () => {
    expect(bulkEmailSpecSchema.safeParse({ ...spec, extra: 1 }).success).toBe(false);
    expect(bulkEmailSpecSchema.safeParse({ templateId: 'nope' }).success).toBe(false);
  });
});

describe('making and changing one', () => {
  const draft = { kind: 'bulk_email' as const, name: 'Monday', spec, cadence: 'daily' as const, sendAtMinute: 540, sendOnWeekday: null, intervalMinutes: null, timezone: 'Australia/Sydney', conversationId: 'c1' };

  it('a member makes one, with its skill and next run', async () => {
    const { db, inserts } = script({});
    const made = await createAutomation(db, agent, draft, NOW);
    expect(inserts[0]!.values).toMatchObject({ skillKey: 'bulk_email', userId: 'u1', conversationId: 'c1' });
    expect(made.nextRunAt.getTime()).toBeGreaterThan(NOW.getTime());
  });
  it('a read-only member cannot', async () => {
    await expect(createAutomation(script({}).db, { ...agent, membershipRole: 'read_only' }, draft, NOW)).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('a bad spec is refused, whatever the card said', async () => {
    await expect(createAutomation(script({}).db, agent, { ...draft, spec: { templateId: 'x' } }, NOW)).rejects.toMatchObject({ code: 'invalid' });
  });
  it('turning it off clears its next run; turning it on brings one back and clears its failures', async () => {
    const off = script({ automation: [[row()]] });
    await setAutomationStatus(off.db, agent, ID, 'paused', NOW);
    expect(off.updates[0]!.set).toMatchObject({ status: 'paused', nextRunAt: null });
    const on = script({ automation: [[row({ status: 'paused', consecutiveFailures: 3 })]] });
    await setAutomationStatus(on.db, agent, ID, 'active', NOW);
    expect(on.updates[0]!.set).toMatchObject({ status: 'active', consecutiveFailures: 0 });
    expect(on.updates[0]!.set.nextRunAt).toBeInstanceOf(Date);
  });
  it('another agent’s is not found; an owner may change it; a read-only owner of it may not', async () => {
    await expect(setAutomationStatus(script({ automation: [[row({ userId: 'someone' })]] }).db, agent, ID, 'paused', NOW)).rejects.toMatchObject({ code: 'not_found' });
    await expect(setAutomationStatus(script({ automation: [[row()]] }).db, owner, ID, 'paused', NOW)).resolves.toBeUndefined();
    await expect(setAutomationStatus(script({ automation: [[row()]] }).db, { ...agent, membershipRole: 'read_only' }, ID, 'paused', NOW)).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('a removed one cannot be switched back on', async () => {
    await expect(setAutomationStatus(script({ automation: [[row({ status: 'archived' })]] }).db, agent, ID, 'active', NOW)).rejects.toMatchObject({ code: 'conflict' });
  });
  it('another agency’s run cannot be stopped', async () => {
    await expect(stopAutomationRun(script({ automation_run: [[run({ agencyId: 'other' })]] }).db, owner, ID)).rejects.toMatchObject({ code: 'not_found' });
  });
  it('Run now refuses while one is going, and for someone else’s', async () => {
    await expect(runAutomationNow(script({ automation: [[row()]], automation_run: [[{ id: 'busy' }]] }).db, agent, ID, NOW)).rejects.toMatchObject({ code: 'conflict' });
    await expect(runAutomationNow(script({ automation: [[row({ userId: 'someone' })]] }).db, agent, ID, NOW)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('the clock', () => {
  it('makes a run for its slot, and moves the next run on from the slot, never from now', async () => {
    // Late by more than a whole day: from now would skip tomorrow's slot.
    const late = new Date(NOW.getTime() + 30 * 3_600_000);
    const { db, updates, inserts } = script({ automation: [[row()]], automation_run: [[]] });
    expect(await claimDueAutomations(db, late)).toBe(1);
    expect(inserts[0]!.values).toMatchObject({ automationId: ID, scheduledFor: NOW });
    const next = updates[0]!.set.nextRunAt as Date;
    expect(next.getTime()).toBe(NOW.getTime() + 24 * 3_600_000);
  });
  it('skips a slot while the run before it is still going', async () => {
    const { db, inserts } = script({ automation: [[row()]], automation_run: [[{ id: 'busy' }]] });
    await claimDueAutomations(db, NOW);
    expect(inserts[0]!.values).toMatchObject({ status: 'skipped' });
  });
  it('claims with SKIP LOCKED, and never a suspended agency', () => {
    const src = readFileSync(join(__dirname, 'tick.ts'), 'utf8');
    expect(src).toContain("for('update', { of: automation, skipLocked: true })");
    expect(src).toContain('not in ${SUSPENDED_AGENCY_IDS}');
  });
});

describe('a run', () => {
  const tick = (rows: Record<string, unknown[][]>, slices = 1) => {
    const s = script(rows);
    return runAutomationTick(s.db, deps, NOW, slices).then(() => s);
  };
  const due = (r = run()) => ({ automation: [[], [row()]], automation_run: [[r]] });

  it('freezes who it is for, then sends the first slice and lets go of its lease', async () => {
    const { updates } = await tick(due());
    expect(runUpdates(updates).some((u) => JSON.stringify(u.contactIds) === '["c1","c2","c3"]')).toBe(true);
    expect(runner.send.mock.calls[0]![3]).toEqual(['c1', 'c2']);
    expect(runUpdates(updates).at(-1)).toMatchObject({ cursor: 2, sent: 2, skipped: 1, leaseUntil: null });
  });
  it('carries on from where it was, and finishes', async () => {
    const { updates } = await tick(due(run({ contactIds: ['c1', 'c2', 'c3'], cursor: 2, sent: 2 })));
    expect(runner.people).not.toHaveBeenCalled();
    expect(runner.send.mock.calls[0]![3]).toEqual(['c3']);
    expect(runUpdates(updates).at(-1)).toMatchObject({ status: 'done', cursor: 3, sent: 4 });
    expect(updates.find((u) => u.table === 'automation')!.set).toMatchObject({ consecutiveFailures: 0 });
  });
  it('sends nothing when its skill is off, and says why', async () => {
    isSkillOnForChat.mockResolvedValue(false);
    const { updates } = await tick(due());
    expect(runner.send).not.toHaveBeenCalled();
    expect(runUpdates(updates).at(-1)).toMatchObject({ status: 'skipped' });
    expect(String(runUpdates(updates).at(-1)!.detail)).toContain('switched off');
  });
  it('pauses itself when its owner has left', async () => {
    activeMemberActor.mockResolvedValue(null);
    const { updates } = await tick(due());
    expect(runner.send).not.toHaveBeenCalled();
    expect(updates.filter((u) => u.table === 'automation').at(-1)!.set).toMatchObject({ status: 'paused', nextRunAt: null });
  });
  it('stops at a limit and says so, keeping what has gone', async () => {
    runner.send.mockResolvedValue({ sent: 0, failed: 0, skipped: 0, stop: 'Stopped at today’s email limit.' });
    const { updates } = await tick(due(run({ contactIds: ['c1', 'c2', 'c3'], cursor: 2, sent: 2 })));
    expect(runUpdates(updates).at(-1)).toMatchObject({ status: 'stopped', sent: 2, detail: 'Stopped at today’s email limit.' });
  });
  it('a slice that must wait makes no progress and comes back at its time', async () => {
    const at = new Date(NOW.getTime() + 3_600_000);
    runner.send.mockResolvedValue({ sent: 0, failed: 0, skipped: 0, retryAt: at });
    const { updates } = await tick(due(run({ contactIds: ['c1', 'c2'], cursor: 0 })));
    expect(runUpdates(updates).at(-1)).toMatchObject({ leaseUntil: at });
    expect(runUpdates(updates).at(-1)).not.toHaveProperty('cursor');
  });
  it('nobody could receive it: done, nothing sent', async () => {
    runner.people.mockResolvedValue({ contactIds: [], skipped: 4 });
    const { updates } = await tick(due());
    expect(runner.send).not.toHaveBeenCalled();
    expect(runUpdates(updates).at(-1)).toMatchObject({ status: 'done', skipped: 4 });
  });
  it('a failure is counted, and the third in a row pauses it', async () => {
    runner.send.mockRejectedValue(new Error('boom'));
    const { updates } = await tick(due(run({ contactIds: ['c1'], cursor: 0 })));
    expect(runUpdates(updates).at(-1)).toMatchObject({ status: 'failed' });
    const a = updates.filter((u) => u.table === 'automation');
    expect(a.some((u) => 'consecutiveFailures' in u.set)).toBe(true);
    expect(a.at(-1)!.set).toMatchObject({ status: 'paused' });
  });
  it('stops after its slices, and when nothing is running', async () => {
    const s = await tick({ automation: [[]], automation_run: [] }, 3);
    expect(s.updates).toEqual([]);
    expect(runner.send).not.toHaveBeenCalled();
  });
});

describe('from the chat', () => {
  const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');
  it('a card makes it, with no second tool that could', () => {
    const actions = read('assistant', 'actions.ts');
    expect(actions).toContain("if ('automation' in args) {");
    expect(actions).toContain('createAutomation(tx, actor, args.automation, now)');
  });
  it('the Automations tab starts empty and is fed only by what exists', () => {
    const tab = readFileSync(join(__dirname, '..', '..', '..', '..', 'apps', 'console', 'components', 'automations', 'automations-tab.tsx'), 'utf8');
    expect(tab).toContain('No automations yet');
    expect(tab).not.toContain('Library');
  });
});
