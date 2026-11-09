import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { automationHref, automationStatus, runningAutomationCount, type AutomationItem, type AutomationPaths } from './index';

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
    expect(seen).toHaveLength(6);
    for (const q of seen) {
      expect(q.params).toContain(A);
      expect(q.params, q.sql).toContain(AGENT);
    }
  });

  it('the agent’s count is narrowed in all three of its parts', async () => {
    const { db, seen } = fakeDb();
    await runningAutomationCount(db, agent);
    expect(seen[0]!.params.filter((p) => p === AGENT)).toHaveLength(3);
    expect(seen[0]!.params.filter((p) => p === A)).toHaveLength(3);
  });

  it('an owner reads the agency, never only their own, and always only this agency', async () => {
    const { db, seen } = fakeDb();
    await automationStatus(db, owner);
    expect(seen).toHaveLength(5);
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

  it('adds up what is active from the window count, not the rows sent', async () => {
    const { db } = fakeDb([[], [], [], [{ id: 'w1', name: 'New enquiry', owner_id: AGENT, owner: 'Sam', last_at: null, total: 8 }], [{ id: 's1', name: 'Brief', user_id: AGENT, owner: 'Sam', next_at: '2026-11-10T07:00:00Z', total: 3 }]]);
    const s = await automationStatus(db, agent);
    expect(s!.activeTotal).toBe(11);
    expect(s!.active.map((a) => a.kind)).toEqual(['workflow', 'skill']);
    expect(s!.active[1]!.nextAt).toBe('2026-11-10T07:00:00.000Z');
  });

  it('carries the usage line', async () => {
    const { db } = fakeDb();
    expect((await automationStatus(db, agent))!.usage).toMatchObject({ email: { person: { used: 0 } }, sms: null });
  });
});

describe('automationHref', () => {
  const paths: AutomationPaths = { home: '/assistant', email: '/my-bulk-email', sms: '/my-bulk-sms', skills: '/my-skills' };
  const item = (over: Partial<AutomationItem>): AutomationItem => ({ key: 'k', kind: 'batch', channel: 'email', state: 'running', title: 't', subtitle: null, done: 0, total: 0, failed: 0, nextAt: null, error: null, owner: null, mine: true, targetId: 'x', conversationId: null, ...over });

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
  it('a workflow goes to Automations', () => {
    expect(automationHref({ key: 'k', kind: 'workflow', title: 't', owner: null, mine: true, targetId: 'w', nextAt: null, lastAt: null }, paths)).toBe('/my-skills?tab=automations');
  });
});

describe('the route and the panel, read from source', () => {
  const ROOT = join(__dirname, '..', '..', '..', '..', 'apps', 'console');
  const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

  it('asks who is signed in before anything else, and takes no id from the browser', () => {
    const route = read('app', 'api', 'automations', 'route.ts');
    expect(route.indexOf('actionUserId()')).toBeLessThan(route.indexOf('loadActor(userId)'));
    expect(route).toMatch(/if \(!userId\) return NextResponse\.json\(\{ error: 'Not signed in' \}, \{ status: 401 \}\)/);
    expect(route).not.toMatch(/searchParams\.get\('(?!count)/);
    expect(route).not.toMatch(/role\s*===/);
  });

  it('the client never imports the database side', () => {
    const panel = read('components', 'automations', 'automation-status.tsx');
    expect(panel).toContain("from '@repo/core/automation-status/links'");
    expect(panel).not.toContain("from '@repo/core/automation-status'");
  });

  it('asks for the list only while the panel is open', () => {
    const panel = read('components', 'automations', 'automation-status.tsx');
    const openEffect = panel.slice(panel.indexOf('if (!open) return;'));
    expect(openEffect).toContain('void loadStatus();');
    expect(panel.slice(0, panel.indexOf('if (!open) return;')).match(/void loadStatus\(\)/g)).toBeNull();
  });
});
