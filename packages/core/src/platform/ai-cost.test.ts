import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import { aiBudgetCaps } from '../assistant/budget';
import { aiCostDays, aiCostForAgency, aiCostOverview, aiFeatureGroup, capState, chatLines, foldAiCost, parseAiCostPeriod, type AiCostRow } from './ai-cost';

/** ADR 0086: the admin's AI cost page. Admins only, a fixed number of statements, and totals that agree. */

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const admin: Actor = { userId: '99999999-9999-9999-9999-999999999999', platformAdmin: true };
const owner: Actor = { userId: '33333333-3333-3333-3333-333333333333', agencyId: A, membershipRole: 'owner' };
const CAPS = { platform: 20, person: 1, agency: 10 };
const NOW = new Date('2026-11-07T02:00:00Z');

const row = (over: Partial<AiCostRow>): AiCostRow => ({ agency_id: A, agency_name: 'Harbour', feature: 'assistant', model: 'claude-sonnet-5-5', spend: '1', calls: 1, day_spend: '0', unpriced: 0, ...over });

const dialect = new PgDialect();
function fakeDb(answers: Record<string, unknown>[][] = []) {
  const seen: { sql: string; params: unknown[] }[] = [];
  const db = {
    execute: async (q: Parameters<typeof dialect.sqlToQuery>[0]) => {
      const r = dialect.sqlToQuery(q);
      seen.push({ sql: r.sql, params: r.params });
      return answers[seen.length - 1] ?? [];
    },
  } as unknown as Db;
  return { db, seen };
}

describe('who may read it', () => {
  it('an agency owner is refused and nothing is asked of the database', async () => {
    const { db, seen } = fakeDb();
    await expect(aiCostOverview(db, owner, { period: 30 })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(aiCostForAgency(db, owner, A, { period: 30 })).rejects.toMatchObject({ code: 'forbidden' });
    expect(seen).toHaveLength(0);
    expect(can(owner, 'platform:read', { type: 'platform' })).toBe(false);
  });
  it('a read-only view of an agency is refused too: it is not the admin', async () => {
    const { db } = fakeDb();
    const view: Actor = { userId: admin.userId, agencyId: A, membershipRole: 'owner', via: 'platform' };
    await expect(aiCostOverview(db, view, { period: 30 })).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('an agency id that is not one is not found, before any query', async () => {
    const { db, seen } = fakeDb();
    await expect(aiCostForAgency(db, admin, 'nope', { period: 30 })).rejects.toMatchObject({ code: 'not_found' });
    expect(seen).toHaveLength(0);
  });
});

describe('the assistant by kind of chat (ADR 0088)', () => {
  const r = (feature: string, chat_scope: string | null, spend: string, calls: number) => ({ feature, chat_scope, spend, calls });
  it('adds up one line per chat, dearest first, and leaves every other feature out', () => {
    const lines = chatLines([r('assistant', 'bulk_email', '1.5', 3), r('assistant', 'bulk_email', '0.5', 1), r('assistant', null, '3', 2), r('assistant', 'daily_work', '1', 4), r('skill:morning_brief', null, '9', 9)]);
    expect(lines).toEqual([
      { key: 'none', label: 'Older chats', spend: 3, calls: 2 },
      { key: 'bulk_email', label: 'Bulk email', spend: 2, calls: 4 },
      { key: 'daily_work', label: 'Daily work', spend: 1, calls: 4 },
    ]);
  });
  it('shows a scope this code does not know under its own name', () => {
    expect(chatLines([r('assistant', 'something_new', '1', 1)])[0]!.label).toBe('something_new');
  });
  it('splitting by chat does not change the person’s total, nor the statement count', async () => {
    const row = (chat_scope: string | null, spend: string, day: string) => ({ user_id: owner.userId, name: 'Sam', role: 'owner', feature: 'assistant', chat_scope, model: 'm', spend, calls: 1, day_spend: day });
    const { db, seen } = fakeDb([[row(null, '1', '0.5'), row('bulk_email', '2', '1')], [{ total: '10' }]]);
    const c = await aiCostForAgency(db, admin, A, { period: 7 });
    expect(seen).toHaveLength(2);
    expect(c.people).toHaveLength(1);
    expect(c.people[0]).toMatchObject({ spend: 3, calls: 2, assistantDay: 1.5 });
    expect(c.chats.map((l) => l.spend)).toEqual([2, 1]);
  });
});

describe('the period', () => {
  it('takes 1, 7 or 30, and anything else is 30', () => {
    expect([parseAiCostPeriod('1'), parseAiCostPeriod('7'), parseAiCostPeriod('30')]).toEqual([1, 7, 30]);
    expect([parseAiCostPeriod('90'), parseAiCostPeriod(undefined), parseAiCostPeriod(['7', '1']), parseAiCostPeriod('x')]).toEqual([30, 30, 7, 30]);
  });
});

describe('capState', () => {
  it('is near from 80%, over at exactly the limit, as the budget check says', () => {
    expect([capState(15.99, 20), capState(16, 20), capState(19.99, 20), capState(20, 20)]).toEqual(['ok', 'near', 'near', 'over']);
    expect(capState(0, 0)).toBe('over');
  });
});

describe('who a call with no agency was for', () => {
  it('buyers’ features are the public site; floorplans, photos and unknown ones are not', () => {
    for (const f of ['property-chat', 'alert-summary', 'consumer:research', 'consumer:due_diligence', 'consumer:task_summary']) expect(aiFeatureGroup(f).public).toBe(true);
    for (const f of ['skill:morning_brief', 'consumer:floorplan_rooms', 'consumer:visual_embed', 'something-new']) expect(aiFeatureGroup(f).public).toBe(false);
    expect(aiFeatureGroup('something-new').label).toBe('something-new');
  });
});

describe('foldAiCost', () => {
  const rows = [
    row({ spend: '3', calls: 30, day_spend: '1.5' }),
    row({ feature: 'inbox:draft', spend: '1', calls: 10, day_spend: '0.5' }),
    row({ feature: 'inbox:summary', spend: '1.5', calls: 5 }),
    row({ agency_id: B, agency_name: 'Parkside', spend: '2', calls: 20, day_spend: '0.25' }),
    row({ agency_id: null, agency_name: null, feature: 'property-chat', spend: '4', calls: 40, day_spend: '1' }),
    row({ agency_id: null, agency_name: null, feature: 'skill:morning_brief', model: 'claude-haiku-4-5', spend: '0.5', calls: 5 }),
  ];
  const out = foldAiCost(rows, CAPS);
  it('the two tables add up to the same total', () => {
    expect(out.spend).toBe(12);
    expect(out.calls).toBe(110);
    expect(out.who.reduce((s, w) => s + w.spend, 0)).toBe(12);
    expect(out.features.reduce((s, f) => s + f.spend, 0)).toBe(12);
    expect(out.features.reduce((s, f) => s + f.calls, 0)).toBe(110);
  });
  it('places each call: agency, public site, or not tied, dearest first', () => {
    expect(out.who.map((w) => [w.kind, w.name, w.spend])).toEqual([
      ['agency', 'Harbour', 5.5],
      ['public', 'Public site (buyers)', 4],
      ['agency', 'Parkside', 2],
      ['unattributed', 'Not tied to an agency', 0.5],
    ]);
    expect(out.agencies).toBe(2);
    expect(out.publicSpend).toBe(4);
  });
  it('an agency’s assistant line is the assistant’s last 24 hours only, and a line with no agency has none', () => {
    expect(out.who[0]!.assistantDay).toBe(1.5);
    expect(out.who[1]!.assistantDay).toBeNull();
    expect(out.who[0]!.topFeature).toBe('Console assistant');
    expect(out.who[1]!.topFeature).toBeNull();
  });
  it('the 24 hours count every feature, as the limit does', () => {
    expect(out.daySpend).toBe(3.25);
  });
  it('folds a group’s features into one line with its dearest model', () => {
    const inbox = out.features.find((f) => f.label === 'Inbox summaries and replies')!;
    expect(inbox).toMatchObject({ features: ['inbox:draft', 'inbox:summary'], spend: 2.5, calls: 15, model: 'Sonnet 5.5' });
    expect(out.features.find((f) => f.features.includes('skill:morning_brief'))!.model).toBe('Haiku 4.5');
  });
  it('says nothing needs a look while nothing does', () => {
    expect(out.attention).toEqual([]);
  });
  it('flags the platform at 80%, an agency’s assistant at 80%, and calls with no price', () => {
    const near = foldAiCost([row({ spend: '17', day_spend: '16', unpriced: 3 })], CAPS);
    expect(near.attention).toEqual([
      { kind: 'platform', spent: 16, cap: 20 },
      { kind: 'agency', agencyId: A, name: 'Harbour', spent: 16, cap: 10 },
      { kind: 'unpriced', calls: 3 },
    ]);
  });
  it('an empty period is zeros, not a crash', () => {
    expect(foldAiCost([], CAPS)).toMatchObject({ spend: 0, calls: 0, agencies: 0, who: [], features: [], attention: [] });
  });
});

describe('aiCostDays', () => {
  it('is 30 Sydney days ending today, with a quiet day at zero', () => {
    // 02:00 UTC is 1 pm on the 7th in Sydney; 20:00 UTC on the 6th is already the 7th there too.
    const days = aiCostDays([{ day: '2026-11-07', spend: '2.5' }, { day: '2026-10-09', spend: '1' }, { day: '2026-10-08', spend: '9' }], NOW);
    expect(days).toHaveLength(30);
    expect(days[0]).toEqual({ day: '2026-10-09', spend: 1 });
    expect(days[29]).toEqual({ day: '2026-11-07', spend: 2.5 });
    expect(days[15]!.spend).toBe(0);
    expect(aiCostDays([], new Date('2026-11-06T20:00:00Z'))[29]!.day).toBe('2026-11-07');
  });
});

describe('the reads', () => {
  it('the overview is two statements for any number of agencies, and reads the period and the same 24 hours', async () => {
    const { db, seen } = fakeDb([[row({ day_spend: '2' }) as unknown as Record<string, unknown>, row({ agency_id: B }) as unknown as Record<string, unknown>], [{ day: '2026-11-07', spend: '2' }]]);
    const out = await aiCostOverview(db, admin, { period: 7, now: NOW, env: { AI_DAILY_BUDGET_USD: '20' } as NodeJS.ProcessEnv });
    expect(seen).toHaveLength(2);
    expect(seen[0]!.params).toEqual(expect.arrayContaining(['2026-10-31T02:00:00.000Z', '2026-11-06T02:00:00.000Z']));
    expect(seen[0]!.sql).toContain('group by r.agency_id');
    expect(seen[1]!.sql).toContain("at time zone 'Australia/Sydney'");
    expect(out).toMatchObject({ period: 7, spend: 2, daySpend: 2, caps: { platform: 20 } });
    expect(out.days[29]).toEqual({ day: '2026-11-07', spend: 2 });
  });
  it('the unpriced count leaves out Voyage, whose small queries can round to nothing', async () => {
    const { db, seen } = fakeDb();
    await aiCostOverview(db, admin, { period: 30, now: NOW });
    expect(seen[0]!.sql).toContain("r.model not like 'voyage%'");
  });
  it('an agency’s page is two statements, only its own rows, and adds up by person and by feature', async () => {
    const { db, seen } = fakeDb([
      [
        { user_id: 'u1', name: 'Priya', role: 'owner', feature: 'assistant', model: 'claude-sonnet-5-5', spend: '3', calls: 30, day_spend: '0.75' },
        { user_id: 'u1', name: 'Priya', role: 'owner', feature: 'inbox:draft', model: 'claude-sonnet-5-5', spend: '1', calls: 10, day_spend: '0.5' },
        { user_id: 'u2', name: 'Sam', role: 'agent', feature: 'assistant', model: 'claude-sonnet-5-5', spend: '2', calls: 20, day_spend: '0.25' },
        { user_id: null, name: null, role: null, feature: 'workflow:draft_email', model: 'claude-haiku-4-5', spend: '1', calls: 5, day_spend: '0' },
      ],
      [{ total: '14' }],
    ]);
    const out = await aiCostForAgency(db, admin, A, { period: 30, now: NOW, env: {} as NodeJS.ProcessEnv });
    expect(seen).toHaveLength(2);
    expect(seen[0]!.sql).toContain('r.agency_id = $');
    expect(seen[0]!.params).toContain(A);
    expect(out.spend).toBe(7);
    expect(out.shareOfPlatform).toBe(0.5);
    expect(out.assistantDay).toBe(1);
    expect(out.people.map((p) => [p.name, p.spend, p.assistantDay])).toEqual([['Priya', 4, 0.75], ['Sam', 2, 0.25], ['Background work', 1, null]]);
    expect(out.features.reduce((s, f) => s + f.spend, 0)).toBe(7);
    expect(out.caps).toEqual({ person: 1, agency: 10 });
  });
});

describe('the limits on the page are the ones the checks read', () => {
  it('reads the same variables with the same defaults', () => {
    expect(aiBudgetCaps({} as NodeJS.ProcessEnv)).toEqual({ platform: 5, person: 1, agency: 10 });
    expect(aiBudgetCaps({ AI_DAILY_BUDGET_USD: '20', ASSISTANT_DAILY_BUDGET_USD_PER_USER: '2', ASSISTANT_DAILY_BUDGET_USD_PER_AGENCY: '15' } as NodeJS.ProcessEnv)).toEqual({ platform: 20, person: 2, agency: 15 });
  });
});
