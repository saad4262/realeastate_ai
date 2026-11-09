import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { automationHref, automationStatus, runningAutomationCount, skillsPanel, switchedOnHref, type AutomationItem, type AutomationPaths } from './index';

const listSkillSwitches = vi.hoisted(() => vi.fn());
const listEveryAutomation = vi.hoisted(() => vi.fn());
const listAssistantConversations = vi.hoisted(() => vi.fn());
vi.mock('../skill-switches/switches', async (real) => ({ ...(await real<object>()), listSkillSwitches }));
vi.mock('../recurring/list', () => ({ listEveryAutomation }));
vi.mock('../assistant/conversations', async (real) => ({ ...(await real<object>()), listAssistantConversations }));
beforeEach(() => {
  listSkillSwitches.mockReset();
  listSkillSwitches.mockResolvedValue({ holder: 'agency', skills: [] });
  listEveryAutomation.mockReset();
  listEveryAutomation.mockResolvedValue([]);
  listAssistantConversations.mockReset();
  listAssistantConversations.mockResolvedValue([]);
});

/** ADR 0088: who sees what in the top bar, and that its numbers come from the rows. */

const A = '11111111-1111-1111-1111-111111111111';
const AGENT = '22222222-2222-2222-2222-222222222222';
const OWNER = '33333333-3333-3333-3333-333333333333';
const agent: Actor = { userId: AGENT, agencyId: A, membershipRole: 'agent' };
const owner: Actor = { userId: OWNER, agencyId: A, membershipRole: 'owner' };

const dialect = new PgDialect();
function fakeDb(answers: Record<string, unknown>[][] = []) {
  const seen: { sql: string; params: unknown[] }[] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'leftJoin', 'where', 'limit']) chain[m] = () => chain;
  chain.then = (res: (v: unknown) => unknown) => Promise.resolve([]).then(res);
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

describe('who may see it', () => {
  it('nothing for someone with no agency, an outsider, or an admin viewing an agency, and no statement runs', async () => {
    const { db, seen } = fakeDb();
    for (const a of [{ userId: 'x' }, { userId: 'x', agencyId: A }, { userId: 'x', agencyId: A, membershipRole: 'owner', via: 'platform' }] as Actor[]) {
      expect(await automationStatus(db, a)).toBeNull();
      expect(await runningAutomationCount(db, a)).toBeNull();
    }
    expect(seen).toHaveLength(0);
  });

  it('an agent’s every statement is narrowed to them', async () => {
    const { db, seen } = fakeDb();
    await automationStatus(db, agent);
    await runningAutomationCount(db, agent);
    expect(seen).toHaveLength(5);
    for (const q of seen) {
      expect(q.params).toContain(A);
      expect(q.params, q.sql).toContain(AGENT);
    }
  });

  it('the agent’s count is narrowed in all four of its parts', async () => {
    const { db, seen } = fakeDb();
    await runningAutomationCount(db, agent);
    expect(seen[0]!.params.filter((p) => p === AGENT)).toHaveLength(4);
    expect(seen[0]!.params.filter((p) => p === A)).toHaveLength(4);
  });

  it('an owner reads the agency, never only their own, and always only this agency', async () => {
    const { db, seen } = fakeDb();
    await automationStatus(db, owner);
    expect(seen).toHaveLength(4);
    for (const q of seen) {
      expect(q.params).toContain(A);
      expect(q.params).not.toContain(OWNER);
    }
  });
});

describe('what it reports', () => {
  const batch = (over: object) => ({ id: 'b1', channel: 'email', status: 'approved_sending', user_id: AGENT, owner: 'Sam', template: 'Spring', list: 'Buyers', sent: '12', total: '20', failed: '0', ...over });
  const answers = (batches: object[]) => [batches, [], [], [], []] as Record<string, unknown>[][];

  it('reads a sending batch’s progress from its rows, numbers from strings', async () => {
    const { db } = fakeDb(answers([batch({})]));
    const s = await automationStatus(db, agent);
    expect(s!.running).toHaveLength(1);
    expect(s!.running[0]).toMatchObject({ kind: 'batch', channel: 'email', state: 'running', title: 'Spring', subtitle: 'Buyers', done: 12, total: 20, mine: true, owner: null });
  });

  it('names someone else’s, and only someone else’s', async () => {
    const { db } = fakeDb(answers([batch({})]));
    expect((await automationStatus(db, owner))!.running[0]).toMatchObject({ mine: false, owner: 'Sam' });
  });

  it('a finished batch with failures needs a look; an SMS batch says so', async () => {
    const { db } = fakeDb(answers([batch({ status: 'sent', failed: '2' }), batch({ id: 'b2', channel: 'sms' })]));
    const s = await automationStatus(db, agent);
    expect(s!.failed.map((i) => i.key)).toEqual(['batch:b1']);
    expect(s!.running[0]).toMatchObject({ channel: 'sms' });
  });

  it('only counts batches that are sending, tasks that are not a workflow’s, and runs that are alive', async () => {
    const { db, seen } = fakeDb([[{ total: 4 }]]);
    expect(await runningAutomationCount(db, owner)).toBe(4);
    expect(seen[0]!.sql).toContain(`b.status = 'approved_sending'`);
    expect(seen[0]!.sql).toContain(`p.origin = 'workflow'`);
    expect(seen[0]!.sql).toContain(`r.status = 'running'`);
    expect(seen[0]!.sql).toContain('r.started_at > now()');
  });

  it('a skill run’s error text, written for the log, never reaches the panel', async () => {
    const { db, seen } = fakeDb([[], [], [{ id: 'r1', agent_skill_id: 's1', status: 'failed', user_id: AGENT, owner: 'Sam', name: 'Brief', error: 'column x does not exist' }], [], []]);
    const s = await automationStatus(db, agent);
    expect(s!.failed[0]).toMatchObject({ title: 'Brief', error: null, targetId: 's1' });
    expect(seen[2]!.sql).not.toContain('r.error');
  });

  it('carries the usage line', async () => {
    const { db } = fakeDb();
    expect((await automationStatus(db, agent))!.usage).toMatchObject({ email: { person: { used: 0 } }, sms: null });
  });
});

describe('the Skills panel', () => {
  const skill = (key: string, on: boolean, over: object = {}) => ({ key, name: key, icon: 'bolt', on, ...over });

  it('lists what is on, with its chat when it has one', async () => {
    listSkillSwitches.mockResolvedValue({ holder: 'agency', skills: [skill('dashboards', true), skill('buyer_matching', true), skill('cold_contacts', false)] });
    const p = await skillsPanel({} as Db, owner);
    expect(p!.skills).toEqual([
      { key: 'dashboards', name: 'dashboards', icon: 'bolt', chat: 'dashboards', automations: [], chats: [] },
      { key: 'buyer_matching', name: 'buyer_matching', icon: 'bolt', chat: null, automations: [], chats: [] },
    ]);
  });

  it('opens each skill to what was made with it and its chats', async () => {
    listSkillSwitches.mockResolvedValue({ holder: 'agency', skills: [skill('dashboards', true)] });
    listEveryAutomation.mockResolvedValue([
      { key: 'recurring:1', name: 'Monday', skillKey: 'dashboards', state: 'active', conversationId: 'c1' },
      { key: 'recurring:2', name: 'Other skill', skillKey: 'sms', state: 'active', conversationId: 'c9' },
    ]);
    listAssistantConversations.mockResolvedValue([{ id: 'c1', title: 'Send every Monday', chatScope: 'dashboards' }, { id: 'c2', title: 'SMS', chatScope: 'sms' }]);
    const p = await skillsPanel({} as Db, owner);
    expect(p!.skills[0]!.automations).toEqual([{ key: 'recurring:1', name: 'Monday', state: 'active', conversationId: 'c1' }]);
    expect(p!.skills[0]!.chats).toEqual([{ id: 'c1', title: 'Send every Monday' }]);
  });

  it('asks for the person’s own switches', async () => {
    await skillsPanel({} as Db, agent);
    expect(listSkillSwitches.mock.calls[0]![1]).toBe(agent);
  });

  it('an agent’s two-switch skill counts only when the agency has it on too', async () => {
    listSkillSwitches.mockResolvedValue({ holder: 'personal', skills: [skill('missed_call_text', true, { pair: true, agencyOn: false }), skill('ai_callback', true, { pair: true, agencyOn: true })] });
    expect((await skillsPanel({} as Db, agent))!.skills.map((x) => x.key)).toEqual(['ai_callback']);
  });

  it('may flip them only if this person may manage the switches', async () => {
    expect((await skillsPanel({} as Db, owner))!.mayManage).toBe(true);
    listSkillSwitches.mockResolvedValue({ holder: 'personal', skills: [] });
    expect((await skillsPanel({} as Db, agent))!.mayManage).toBe(true);
    expect((await skillsPanel({} as Db, { userId: 'v', agencyId: A, membershipRole: 'read_only' }))!.mayManage).toBe(false);
  });

  it('nothing for someone with no agency, or an admin viewing one', async () => {
    expect(await skillsPanel({} as Db, { userId: 'x' })).toBeNull();
    expect(await skillsPanel({} as Db, { userId: 'x', agencyId: A, membershipRole: 'owner', via: 'platform' })).toBeNull();
    expect(listSkillSwitches).not.toHaveBeenCalled();
  });

  it('goes to the skill’s chat, or to the switched-on skills when it has none', () => {
    const paths: AutomationPaths = { home: '/assistant', email: '/e', sms: '/s', skills: '/my-skills' };
    expect(switchedOnHref({ key: 'email', name: 'x', icon: 'y', chat: 'email', automations: [], chats: [] }, paths)).toBe('/assistant?chat=email');
    expect(switchedOnHref({ key: 'buyer_matching', name: 'x', icon: 'y', chat: null, automations: [], chats: [] }, paths)).toBe('/my-skills?show=on');
  });
});

describe('a long send and a task', () => {
  const task = (over: object) => ({ id: 't1', conversation_id: 'c1', status: 'active', user_id: AGENT, owner: 'Sam', title: 'Spring to Buyers', error: null, done: 2, total: 5, next_at: '2026-11-10T03:00:00Z', send_parts: 0, people: 0, sent: 0, failed: 0, list: null, ...over });
  const withTasks = (rows: object[]) => [[], rows, [], [], []] as Record<string, unknown>[][];

  it('counts a long send in people, from the parts already sent, with its parts and its next time', async () => {
    const { db } = fakeDb(withTasks([task({ send_parts: 5, people: 100, sent: 40, failed: 1, list: 'Buyers' })]));
    expect((await automationStatus(db, agent))!.running[0]).toMatchObject({ kind: 'send_plan', done: 40, total: 100, failed: 1, subtitle: 'Buyers', parts: { done: 2, total: 5 }, nextAt: '2026-11-10T03:00:00.000Z' });
  });

  it('a task of other steps still counts steps', async () => {
    const { db } = fakeDb(withTasks([task({})]));
    expect((await automationStatus(db, agent))!.running[0]).toMatchObject({ kind: 'task', done: 2, total: 5, parts: null });
  });

  it('reads the people from each part’s own list and the sends from its batch', async () => {
    const { db, seen } = fakeDb();
    await automationStatus(db, owner);
    expect(seen[1]!.sql).toContain("jsonb_array_length(p.args->'contactIds')");
    expect(seen[1]!.sql).toContain("(p.result->>'batchId')::uuid");
  });

  it('whoever started it, or an owner or admin, may stop it; a read-only member may not', async () => {
    const stop = async (a: Actor, by: string) => {
      const { db } = fakeDb(withTasks([task({ user_id: by })]));
      return (await automationStatus(db, a))!.running[0]!.canStop;
    };
    expect(await stop(agent, AGENT)).toBe(true);
    expect(await stop(owner, AGENT)).toBe(true);
    expect(await stop({ userId: AGENT, agencyId: A, membershipRole: 'read_only' }, AGENT)).toBe(false);
  });

  it('a batch, gone in seconds, has nothing to stop', async () => {
    const { db } = fakeDb([[{ id: 'b1', channel: 'email', status: 'approved_sending', user_id: AGENT, owner: 'Sam', template: 'x', list: 'y', sent: '1', total: '2', failed: '0' }], [], [], [], []]);
    expect((await automationStatus(db, agent))!.running[0]).toMatchObject({ canStop: false, parts: null });
  });
});

describe('a run of a repeating automation', () => {
  const run = (over: object) => ({ id: 'r1', automation_id: 'a1', status: 'running', user_id: AGENT, owner: 'Sam', name: 'Monday buyers', conversation_id: 'c1', next_at: '2026-11-10T03:00:00Z', total: 100, sent: 50, failed: 0, detail: null, ...over });
  const withRuns = (rows: object[]) => [[], [], [], rows] as Record<string, unknown>[][];

  it('shows how far a running one has got, and can be stopped', async () => {
    const { db } = fakeDb(withRuns([run({})]));
    expect((await automationStatus(db, agent))!.running[0]).toMatchObject({ kind: 'automation_run', title: 'Monday buyers', done: 50, total: 100, canStop: true });
  });
  it('a finished one says when it goes next, under Done', async () => {
    const { db } = fakeDb(withRuns([run({ status: 'done', sent: 100 })]));
    const s = await automationStatus(db, agent);
    expect(s!.running).toEqual([]);
    expect(s!.finished[0]).toMatchObject({ state: 'done', done: 100, nextAt: '2026-11-10T03:00:00.000Z', canStop: false });
  });
  it('one that stopped, failed or was skipped needs a look, with its reason', async () => {
    for (const status of ['stopped', 'failed', 'skipped']) {
      const { db } = fakeDb(withRuns([run({ status, detail: 'Why' })]));
      expect((await automationStatus(db, agent))!.failed[0]).toMatchObject({ state: 'failed', error: 'Why' });
    }
  });
  it('a read-only member cannot stop one', async () => {
    const { db } = fakeDb(withRuns([run({})]));
    expect((await automationStatus(db, { userId: AGENT, agencyId: A, membershipRole: 'read_only' }))!.running[0]!.canStop).toBe(false);
  });
  it('a run with a chat goes to it, for its owner only', () => {
    const paths: AutomationPaths = { home: '/h', email: '/e', sms: '/s', skills: '/sk' };
    const i = { key: 'k', kind: 'automation_run', channel: null, state: 'running', title: 't', subtitle: null, done: 0, total: 0, failed: 0, parts: null, canStop: false, nextAt: null, error: null, owner: null, mine: true, targetId: 'r', conversationId: 'c1' } as AutomationItem;
    expect(automationHref(i, paths)).toBe('/h?c=c1');
    expect(automationHref({ ...i, mine: false }, paths)).toBe('/sk?tab=automations');
  });
});

describe('automationHref', () => {
  const paths: AutomationPaths = { home: '/assistant', email: '/my-bulk-email', sms: '/my-bulk-sms', skills: '/my-skills' };
  const item = (over: Partial<AutomationItem>): AutomationItem => ({ key: 'k', kind: 'batch', channel: 'email', state: 'running', title: 't', subtitle: null, done: 0, total: 0, failed: 0, parts: null, canStop: false, nextAt: null, error: null, owner: null, mine: true, targetId: 'x', conversationId: null, ...over });

  it('a batch goes to its channel’s page, even someone else’s, which an admin may open', () => {
    expect(automationHref(item({}), paths)).toBe('/my-bulk-email/x');
    expect(automationHref(item({ channel: 'sms', mine: false }), paths)).toBe('/my-bulk-sms/x');
  });
  it('a task goes to its chat, only for its author; a chat is nobody else’s to open', () => {
    expect(automationHref(item({ kind: 'task', channel: null, conversationId: 'c1' }), paths)).toBe('/assistant?c=c1');
    expect(automationHref(item({ kind: 'task', channel: null, conversationId: 'c1', mine: false }), paths)).toBeNull();
    expect(automationHref(item({ kind: 'task', channel: null }), paths)).toBeNull();
  });
  it('a skill goes to its page, only for its owner', () => {
    expect(automationHref(item({ kind: 'skill_run', channel: null }), paths)).toBe('/my-skills/x');
    expect(automationHref(item({ kind: 'skill_run', channel: null, mine: false }), paths)).toBeNull();
  });
});

describe('the route and the panel, read from source', () => {
  const ROOT = join(__dirname, '..', '..', '..', '..', 'apps', 'console');
  const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

  it('asks who is signed in before anything else, and takes no id from the browser', () => {
    const route = read('app', 'api', 'automations', 'route.ts');
    expect(route.indexOf('actionUserId()')).toBeLessThan(route.indexOf('loadActor(userId)'));
    expect(route).toMatch(/if \(!userId\) return NextResponse\.json\(\{ error: 'Not signed in' \}, \{ status: 401 \}\)/);
    expect(route).not.toMatch(/searchParams\.get\('(?!count|view)/);
    expect(route).not.toMatch(/role\s*===/);
  });

  it('the client never imports the database side', () => {
    const panel = read('components', 'automations', 'automation-status.tsx');
    expect(panel).toContain("from '@repo/core/automation-status/links'");
    expect(panel).not.toContain("from '@repo/core/automation-status'");
  });

  it('the two panels are two buttons in the top bar, with their names, and the dead Filters icon is gone', () => {
    const shell = read('components', 'shell', 'console-shell.tsx');
    expect(shell).toContain('<SkillsStatusButton');
    expect(shell).toContain('<AutomationStatusButton');
    expect(shell).not.toContain('aria-label="Filters"');
    expect(read('components', 'automations', 'skills-status.tsx')).toContain('>Skills<');
    expect(read('components', 'automations', 'automation-status.tsx')).toContain('>Automations<');
  });

  it('the panel’s controls are the screens’ own actions, and stopping asks first', () => {
    const panel = read('components', 'automations', 'automation-status.tsx');
    for (const a of ['stopTaskAction', 'stopAutomationRunAction']) expect(panel, a).toContain(a);
    expect(panel).not.toContain('setWorkflowStatusAction');
    expect(panel).toContain('Stop the rest?');
  });

  it('the route reads the switched-on skills from core, and takes no id', () => {
    const route = read('app', 'api', 'automations', 'route.ts');
    expect(route).toContain("searchParams.get('view') === 'skills'");
    expect(route).toContain('skillsPanel(db, actor)');
  });

  it('asks for the list only while the panel is open', () => {
    const panel = read('components', 'automations', 'automation-status.tsx');
    const openEffect = panel.slice(panel.indexOf('if (!open) return;'));
    expect(openEffect).toContain('void loadStatus();');
    expect(panel.slice(0, panel.indexOf('if (!open) return;')).match(/void loadStatus\(\)/g)).toBeNull();
  });
});
