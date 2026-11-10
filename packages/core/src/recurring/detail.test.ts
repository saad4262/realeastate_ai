import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { automationDetail, automationsOfChat } from './detail';
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

const ID = '00000000-0000-4000-8000-000000000001';
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

describe('automationsOfChat', () => {
  it('only this person’s, made in that chat', async () => {
    listEveryAutomation.mockResolvedValue([row(), row({ key: 'recurring:x', conversationId: 'c2' }), row({ key: 'recurring:y', mine: false })]);
    expect((await automationsOfChat({} as Db, agent, '00000000-0000-4000-8000-0000000000c1'.replace('c1', '01'))).length).toBe(0);
    listEveryAutomation.mockResolvedValue([row({ conversationId: ID }), row({ key: 'recurring:y', mine: false, conversationId: ID })]);
    expect(await automationsOfChat({} as Db, agent, ID)).toEqual([{ key: `recurring:${ID}`, name: 'Monday', state: 'active' }]);
  });
  it('nothing for an id that is not one', async () => {
    expect(await automationsOfChat({} as Db, agent, 'nope')).toEqual([]);
    expect(listEveryAutomation).not.toHaveBeenCalled();
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
    const check = route.indexOf("if (!AUTOMATION_KEY.test(detail)) return NextResponse.json({ error: 'Not found' }, { status: 404 });");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(route.indexOf('automationDetail(db, actor, detail)'));
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
