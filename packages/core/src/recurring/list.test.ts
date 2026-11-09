import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { listEveryAutomation } from './list';

/** ADR 0089: one list of everything a person set up, whatever it is underneath. */

const listWorkflows = vi.hoisted(() => vi.fn());
vi.mock('../workflows/manage', async (real) => ({ ...(await real<object>()), listWorkflows }));

const A = '11111111-1111-1111-1111-111111111111';
const agent: Actor = { userId: '22222222-2222-2222-2222-222222222222', agencyId: A, membershipRole: 'agent' };
const owner: Actor = { userId: '33333333-3333-3333-3333-333333333333', agencyId: A, membershipRole: 'owner' };
const dialect = new PgDialect();

function fake(recurring: unknown[], tasks: unknown[], skills: unknown[], chats: unknown[] = []) {
  const seen: { sql: string; params: unknown[] }[] = [];
  const answers = [tasks, skills, chats];
  const chain: Record<string, unknown> = { then: (r: (v: unknown) => unknown) => Promise.resolve(recurring).then(r) };
  for (const m of ['from', 'innerJoin', 'where', 'orderBy', 'limit']) chain[m] = () => chain;
  const db = {
    select: () => chain,
    execute: async (q: Parameters<typeof dialect.sqlToQuery>[0]) => {
      const r = dialect.sqlToQuery(q);
      seen.push({ sql: r.sql, params: r.params });
      return answers[seen.length - 1] ?? [];
    },
  } as unknown as Db;
  return { db, seen };
}

const auto = (over: object = {}) => ({ a: { id: 'a1', userId: agent.userId, kind: 'bulk_email', skillKey: 'bulk_email', name: 'Monday', spec: { templateId: A, templateName: 'Spring', filterId: A, listName: 'Buyers' }, status: 'active', pausedReason: null, cadence: 'daily', sendAtMinute: 540, sendOnWeekday: null, intervalMinutes: null, timezone: 'UTC', lastRunAt: null, nextRunAt: new Date('2026-11-10T09:00:00Z'), conversationId: 'c1', ...over }, ownerName: 'Sam', ownerEmail: 's@x' });
const flow = (over: object = {}) => ({ id: 'w1', name: 'New enquiry', status: 'active', pausedReason: null, ownerName: 'Sam', mine: true, words: { when: 'A new enquiry', then: ['Send the welcome', 'Add a note'] }, runsToday: 2, mayManage: true, stepTypes: ['send_template_email'], ...over });

beforeEach(() => listWorkflows.mockResolvedValue([]));

describe('listEveryAutomation', () => {
  it('nothing for someone with no agency', async () => {
    expect(await listEveryAutomation(fake([], [], []).db, { userId: 'x' })).toEqual([]);
  });

  it('starts empty', async () => {
    expect(await listEveryAutomation(fake([], [], []).db, agent)).toEqual([]);
  });

  it('a repeating one says what it does, which skill, when, and its chat', async () => {
    const [r] = await listEveryAutomation(fake([auto()], [], []).db, agent);
    expect(r).toMatchObject({ source: 'recurring', name: 'Monday', skill: 'Email', skillKey: 'email', state: 'active', canToggle: true, canRun: true, conversationId: 'c1', mine: true });
    expect(r!.what).toContain('Spring');
    expect(r!.when).toContain('9:00');
  });

  it('off is off, and cannot be run by hand until it is on', async () => {
    const [r] = await listEveryAutomation(fake([auto({ status: 'paused', pausedReason: 'Its owner left' })], [], []).db, agent);
    expect(r).toMatchObject({ state: 'off', note: 'Its owner left', canRun: false, canToggle: true });
  });

  it('a workflow keeps showing, under the skill its sends belong to, with the chat it was made in', async () => {
    listWorkflows.mockResolvedValue([flow()]);
    const rows = await listEveryAutomation(fake([], [], [], [{ workflow_id: 'w1', conversation_id: 'c9' }]).db, agent);
    expect(rows[0]).toMatchObject({ source: 'workflow', skill: 'Email', skillKey: 'email', when: 'A new enquiry', state: 'active', note: '2 today', conversationId: 'c9' });
    expect(rows[0]!.what).toBe('Send the welcome, then Add a note');
  });

  it('a workflow sending both kinds belongs to neither skill; an archived one does not show', async () => {
    listWorkflows.mockResolvedValue([flow({ stepTypes: ['send_template_email', 'send_template_sms'] }), flow({ id: 'w2', status: 'archived' })]);
    const rows = await listEveryAutomation(fake([], [], []).db, agent);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ skill: 'Workflows', skillKey: null });
  });

  it('one-off tasks and scheduled AI skills are in the same list, with what can be switched', async () => {
    const task = { id: 't1', title: 'Send in parts', status: 'done', user_id: agent.userId, owner: 'Sam', conversation_id: 'c2', chat_scope: 'bulk_email', created_at: '2026-11-08T00:00:00Z', finished_at: '2026-11-09T00:00:00Z' };
    const skill = { id: 's1', name: 'Morning Brief', enabled: true, user_id: agent.userId, owner: 'Sam', cadence: 'daily', send_at_minute: 420, send_on_weekday: null, interval_minutes: null, timezone: 'UTC', next_at: null, last_at: null };
    const rows = await listEveryAutomation(fake([], [task], [skill]).db, agent);
    expect(rows.map((r) => r.source)).toEqual(['ai_skill', 'task']);
    expect(rows[0]).toMatchObject({ skill: 'AI skills', state: 'active', canToggle: true });
    expect(rows[1]).toMatchObject({ when: 'Once', state: 'finished', canToggle: false, skill: 'Email', skillKey: 'email' });
  });

  it('an owner cannot switch off someone else’s AI skill; an agent’s reads are narrowed to them', async () => {
    const skill = { id: 's1', name: 'Brief', enabled: true, user_id: agent.userId, owner: 'Sam', cadence: 'daily', send_at_minute: 420, send_on_weekday: null, interval_minutes: null, timezone: 'UTC', next_at: null, last_at: null };
    expect((await listEveryAutomation(fake([], [], [skill]).db, owner))[0]).toMatchObject({ canToggle: false, mine: false, owner: 'Sam' });
    const { db, seen } = fake([], [], []);
    await listEveryAutomation(db, agent);
    for (const q of seen) expect(q.params).toContain(agent.userId);
    const asOwner = fake([], [], []);
    await listEveryAutomation(asOwner.db, owner);
    for (const q of asOwner.seen) expect(q.params).not.toContain(owner.userId);
  });

  it('leaves out a workflow’s own tasks', async () => {
    const { db, seen } = fake([], [], []);
    await listEveryAutomation(db, agent);
    expect(seen[0]!.sql).toContain("p.origin = 'workflow'");
  });
});
