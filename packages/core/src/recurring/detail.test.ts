import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { TemplateEmailError } from '../template-email/templates';
import { automationDetail, automationsOfChat, chatActionDetail } from './detail';
import { automationIcon, automationRowHref, filterAutomations } from './detail-types';

/** One automation in full, and the ones beside a chat (the user, 2026-11-10). */

const listEveryAutomation = vi.hoisted(() => vi.fn());
const listAutomationRuns = vi.hoisted(() => vi.fn());
const workflowRuns = vi.hoisted(() => vi.fn());
const listSkillRuns = vi.hoisted(() => vi.fn());
vi.mock('./list', () => ({ listEveryAutomation }));
vi.mock('./manage', async (real) => ({ ...(await real<object>()), listAutomationRuns }));
vi.mock('../workflows/manage', async (real) => ({ ...(await real<object>()), workflowRuns }));
vi.mock('../skills/skills', async (real) => ({ ...(await real<object>()), listSkillRuns }));
const getBatch = vi.hoisted(() => vi.fn());
vi.mock('../template-email/batches', async (real) => ({ ...(await real<object>()), getBatch }));

const ID = '00000000-0000-4000-8000-000000000001';
const ACTION = '00000000-0000-4000-8000-0000000000a1';
const BATCH = '00000000-0000-4000-8000-0000000000b1';
const agent: Actor = { userId: 'u1', agencyId: 'a1', membershipRole: 'agent' };
const row = (over: object = {}) => ({ key: `recurring:${ID}`, source: 'recurring', id: ID, name: 'Monday', what: 'Sends', skill: 'Email', skillKey: 'email', when: 'Every Monday', state: 'active', note: null, owner: null, mine: true, lastAt: null, nextAt: null, canToggle: true, canRun: true, conversationId: 'c1', ...over });
const run = (over: object = {}) => ({ id: 'r1', status: 'done', at: new Date('2026-11-09T22:00:00Z'), finishedAt: null, total: 100, sent: 100, failed: 0, skipped: 0, detail: null, trigger: 'schedule', ...over });

beforeEach(() => {
  vi.clearAllMocks();
  listEveryAutomation.mockResolvedValue([row()]);
  listAutomationRuns.mockResolvedValue([]);
});

describe('automationDetail', () => {
  it('nothing for a key that is not one, or one this person cannot see', async () => {
    expect(await automationDetail({} as Db, agent, 'nope')).toBeNull();
    expect(listEveryAutomation).not.toHaveBeenCalled();
    expect(await automationDetail({} as Db, agent, `recurring:${'1'.repeat(8)}-0000-4000-8000-000000000009`)).toBeNull();
  });

  it('the run going now, with how many are left, apart from the history', async () => {
    listAutomationRuns.mockResolvedValue([run({ id: 'r2', status: 'running', sent: 40, failed: 2 }), run({})]);
    const d = (await automationDetail({} as Db, agent, `recurring:${ID}`))!;
    expect(d.current).toMatchObject({ id: 'r2', sent: 40, failed: 2, remaining: 58, total: 100 });
    expect(d.runs.map((r) => r.id)).toEqual(['r1']);
    expect(d.canStop).toBe(true);
  });

  it('nothing to stop when nothing is running, or for someone who may not change it', async () => {
    listAutomationRuns.mockResolvedValue([run({})]);
    expect((await automationDetail({} as Db, agent, `recurring:${ID}`))!.canStop).toBe(false);
    listAutomationRuns.mockResolvedValue([run({ status: 'running' })]);
    listEveryAutomation.mockResolvedValue([row({ canToggle: false })]);
    expect((await automationDetail({} as Db, agent, `recurring:${ID}`))!.canStop).toBe(false);
  });

  it('a workflow’s runs count its steps', async () => {
    listEveryAutomation.mockResolvedValue([row({ key: `workflow:${ID}`, source: 'workflow' })]);
    workflowRuns.mockResolvedValue([{ id: 'w1', at: new Date(), status: 'started', error: null, decision: null, steps: [{ status: 'done' }, { status: 'scheduled' }, { status: 'failed' }] }]);
    const d = (await automationDetail({} as Db, agent, `workflow:${ID}`))!;
    expect(d.runs[0]).toMatchObject({ total: 3, sent: 1, failed: 1, remaining: 2 });
  });

  it('someone else’s AI skill shows, but not its runs', async () => {
    listEveryAutomation.mockResolvedValue([row({ key: `ai_skill:${ID}`, source: 'ai_skill', mine: false })]);
    const d = (await automationDetail({} as Db, agent, `ai_skill:${ID}`))!;
    expect(d.runs).toEqual([]);
    expect(listSkillRuns).not.toHaveBeenCalled();
  });
});

/** Answers each read in turn and records each WHERE as Postgres gets it: the person filter is the point of these reads. */
function fakeDb(reads: unknown[][]) {
  const wheres: { sql: string; params: unknown[] }[] = [];
  const dialect = new PgDialect();
  const db = {
    select: () => {
      const rows = reads.shift() ?? [];
      const chain: Record<string, unknown> = {};
      for (const m of ['from', 'orderBy', 'limit']) chain[m] = () => chain;
      chain.where = (clause: SQL) => {
        wheres.push(dialect.sqlToQuery(clause));
        return chain;
      };
      chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(rows).then(res, rej);
      return chain;
    },
  };
  return { db: db as unknown as Db, wheres };
}

describe('automationsOfChat', () => {
  it('only this person’s, made in that chat', async () => {
    listEveryAutomation.mockResolvedValue([row(), row({ key: 'recurring:x', conversationId: 'c2' }), row({ key: 'recurring:y', mine: false })]);
    expect((await automationsOfChat(fakeDb([]).db, agent, '00000000-0000-4000-8000-0000000000c1'.replace('c1', '01'))).length).toBe(0);
    listEveryAutomation.mockResolvedValue([row({ conversationId: ID }), row({ key: 'recurring:y', mine: false, conversationId: ID })]);
    expect(await automationsOfChat(fakeDb([]).db, agent, ID)).toEqual([{ key: `recurring:${ID}`, name: 'Monday', state: 'active' }]);
  });
  it('nothing for an id that is not one', async () => {
    expect(await automationsOfChat({} as Db, agent, 'nope')).toEqual([]);
    expect(listEveryAutomation).not.toHaveBeenCalled();
  });
  it('what was approved once comes after its automations, read only from this person’s cards in this agency', async () => {
    listEveryAutomation.mockResolvedValue([row({ conversationId: ID })]);
    const { db, wheres } = fakeDb([[{ id: ACTION, card: { title: 'Send “Welcome” to 6 people' }, status: 'done' }, { id: ID, card: { title: 'Book a meeting' }, status: 'scheduled' }]]);
    expect(await automationsOfChat(db, agent, ID)).toEqual([
      { key: `recurring:${ID}`, name: 'Monday', state: 'active' },
      { key: `action:${ACTION}`, name: 'Send “Welcome” to 6 people', state: 'finished' },
      { key: `action:${ID}`, name: 'Book a meeting', state: 'active' },
    ]);
    const w = wheres[0]!;
    expect(w.sql).toContain('"proposed_action"."user_id" = $');
    expect(w.sql).toContain('"proposed_action"."agency_id" = $');
    expect(w.sql).toContain('"proposed_action"."task_id" is null');
    expect(w.params).toEqual(expect.arrayContaining([ID, 'u1', 'a1', 'done', 'failed', 'plan_task']));
    expect(w.params).not.toContain('proposed');
  });
});

describe('chatActionDetail', () => {
  const card = { title: 'Send “Welcome” to 3 people', contact: { id: 'c', name: 'x' }, lines: [{ label: 'Template', value: 'Welcome' }], notes: [] };
  const action = (over: object = {}) => ({ id: ACTION, agencyId: 'a1', userId: 'u1', status: 'done', card, args: { tool: 'send_template_email', batchId: BATCH }, decidedAt: new Date('2026-11-23T01:00:00Z'), runAt: null, finishedAt: null, error: null, ...over });
  const batch = {
    id: BATCH,
    counts: { total: 3, toSend: 1, sending: 0, sent: 1, failed: 0, skipped: 1 },
    recipients: [
      { name: 'Emma', email: 'e@x.test', phone: null, status: 'sent', skipReason: null, error: null, sentAt: new Date('2026-11-23T01:01:00Z') },
      { name: 'Arham', email: 'a@x.test', phone: null, status: 'queued', skipReason: null, error: null, sentAt: null },
      { name: 'Saad', email: null, phone: null, status: 'skipped', skipReason: 'no_email', error: null, sentAt: null },
    ],
  };

  it('nothing for a key that is not one, without reading', async () => {
    expect(await chatActionDetail({} as Db, agent, 'nope')).toBeNull();
    expect(await chatActionDetail({} as Db, agent, `recurring:${ID}`)).toBeNull();
  });

  it('nothing for another agent’s card: can() decides, and the read is held to this agency', async () => {
    const { db, wheres } = fakeDb([[action({ userId: 'someone-else' })]]);
    expect(await chatActionDetail(db, agent, `action:${ACTION}`)).toBeNull();
    expect(wheres[0]!.params).toEqual([ACTION, 'a1']);
    expect(getBatch).not.toHaveBeenCalled();
  });

  it('a send: how far it has got, and every person with what happened and why', async () => {
    getBatch.mockResolvedValue(batch);
    const d = (await chatActionDetail(fakeDb([[action()]]).db, agent, `action:${ACTION}`))!;
    expect(d).toMatchObject({ name: card.title, status: 'done', lines: card.lines, decidedAt: '2026-11-23T01:00:00.000Z' });
    expect(d.send).toMatchObject({ channel: 'email', batchId: BATCH, total: 3, sent: 1, skipped: 1, failed: 0, left: 1 });
    expect(d.send!.people).toEqual([
      { name: 'Emma', to: 'e@x.test', status: 'sent', why: null, at: '2026-11-23T01:01:00.000Z' },
      { name: 'Arham', to: 'a@x.test', status: 'queued', why: null, at: null },
      { name: 'Saad', to: null, status: 'skipped', why: 'No email address', at: null },
    ]);
    expect(getBatch.mock.calls[0]![4]).toEqual({ channel: 'email' });
  });

  it('a text reads its SMS batch, shows the mobile, and a failure says why', async () => {
    getBatch.mockResolvedValue({ ...batch, recipients: [{ name: 'Emma', email: null, phone: '+61400000000', status: 'failed', skipReason: null, error: 'Carrier rejected', sentAt: null }] });
    const d = (await chatActionDetail(fakeDb([[action({ args: { tool: 'send_template_sms', batchId: BATCH } })]]).db, agent, `action:${ACTION}`))!;
    expect(getBatch.mock.calls[0]![4]).toEqual({ channel: 'sms' });
    expect(d.send!.people[0]).toMatchObject({ to: '+61400000000', why: 'Carrier rejected' });
  });

  it('not a send, or a batch this person may not read: the card alone', async () => {
    expect((await chatActionDetail(fakeDb([[action({ args: { tool: 'add_note' } })]]).db, agent, `action:${ACTION}`))!.send).toBeNull();
    getBatch.mockRejectedValue(new TemplateEmailError('not_found', 'That batch was not found'));
    expect((await chatActionDetail(fakeDb([[action()]]).db, agent, `action:${ACTION}`))!.send).toBeNull();
  });
});

describe('on screen, read from source', () => {
  const ROOT = join(__dirname, '..', '..', '..', '..', 'apps', 'console');
  const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
  it('a card opens its own chat only for its owner; anyone else gets the drawer', () => {
    const row = { key: 'recurring:k', mine: true, conversationId: 'c1' };
    expect(automationRowHref(row, '/h', '/sk?tab=automations')).toBe('/h?c=c1&automation=recurring:k');
    expect(automationRowHref({ ...row, mine: false }, '/h', '/sk?tab=automations')).toBe('/sk?tab=automations&open=recurring:k');
    expect(automationRowHref({ ...row, conversationId: null }, '/h', '/sk?tab=automations')).toBe('/sk?tab=automations&open=recurring:k');
  });
  it('the chat shows its automations beside it', () => {
    expect(read('components', 'assistant', 'assistant-home.tsx')).toContain('<ChatAutomations');
  });
  it('the route checks a key before reading anything', () => {
    const route = read('app', 'api', 'automations', 'route.ts');
    const check = route.indexOf("if (!isAction && !AUTOMATION_KEY.test(detail)) return apiError(404, 'Not found');");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(route.indexOf('automationDetail(db, actor, detail)'));
    expect(check).toBeLessThan(route.indexOf('chatActionDetail(db, actor, detail)'));
  });
  it('the chat panel shows a one-off card in its own panel', () => {
    expect(read('components', 'automations', 'chat-automations.tsx')).toContain("current.startsWith('action:') ? <ChatActionPanel");
  });
  it('the panel refreshes faster while something runs, and only while visible', () => {
    const panel = read('components', 'automations', 'automation-detail.tsx');
    expect(panel).toContain("running ? 5_000 : 20_000");
    expect(panel).toContain("document.visibilityState === 'visible'");
  });
});

describe('the Automations tab’s search and filter', () => {
  const r = (over: object) => ({ name: 'Monday buyers', what: 'Sends “Spring” to everyone on “Buyers”', skill: 'Email', when: 'Every Monday at 9:00 am', owner: null, state: 'active' as const, ...over });
  const rows = [r({}), r({ name: 'New enquiry', what: 'Remind you', skill: 'SMS', state: 'off' }), r({ name: 'Old task', skill: 'Overview', state: 'finished', owner: 'Sam' })];
  it('finds by any word in its name, what it does, skill, when or whose, every word', () => {
    expect(filterAutomations(rows, 'buyers', 'all').map((x) => x.name)).toEqual(['Monday buyers', 'Old task']);
    expect(filterAutomations(rows, 'sms', 'all').map((x) => x.name)).toEqual(['New enquiry']);
    expect(filterAutomations(rows, 'sam', 'all').map((x) => x.name)).toEqual(['Old task']);
    expect(filterAutomations(rows, 'monday spring', 'all').map((x) => x.name)).toEqual(['Monday buyers', 'Old task']);
    expect(filterAutomations(rows, 'monday nothing', 'all')).toEqual([]);
  });
  it('narrows by state, and an empty search finds everything', () => {
    expect(filterAutomations(rows, '', 'off').map((x) => x.name)).toEqual(['New enquiry']);
    expect(filterAutomations(rows, '  ', 'all')).toHaveLength(3);
  });
  it('shows each one in its skill’s icon', () => {
    expect(automationIcon({ source: 'recurring', skillKey: 'email' })).toBe('mail');
    expect(automationIcon({ source: 'workflow', skillKey: 'sms' })).toBe('sms');
    expect(automationIcon({ source: 'task', skillKey: null })).toBe('task_alt');
  });
  it('the board searches with this, not a copy of its own', () => {
    expect(readFileSync(join(__dirname, '..', '..', '..', '..', 'apps', 'console', 'components', 'automations', 'automations-board.tsx'), 'utf8')).toContain('filterAutomations(rows, query, filter)');
  });
});
