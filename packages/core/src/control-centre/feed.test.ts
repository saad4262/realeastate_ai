import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { CC_PAGE_SIZE, controlCentreActivity, controlCentreQuerySchema, type ControlCentreQuery } from './index';

/** ADR 0091 part A: who sees which rows, that the figures come from SQL, and a fixed two statements. */

const A = '11111111-1111-1111-1111-111111111111';
const AGENT = '22222222-2222-2222-2222-222222222222';
const OWNER = '33333333-3333-3333-3333-333333333333';
const OTHER = '44444444-4444-4444-4444-444444444444';
const agent: Actor = { userId: AGENT, agencyId: A, membershipRole: 'agent' };
const owner: Actor = { userId: OWNER, agencyId: A, membershipRole: 'owner' };
const q = (over: Partial<ControlCentreQuery> = {}): ControlCentreQuery => ({ ...controlCentreQuerySchema.parse({}), ...over });

const dialect = new PgDialect();
function fakeDb(answers: Record<string, unknown>[][] = []) {
  const seen: { sql: string; params: unknown[] }[] = [];
  const db = {
    execute: async (s: Parameters<typeof dialect.sqlToQuery>[0]) => {
      const r = dialect.sqlToQuery(s);
      seen.push({ sql: r.sql, params: r.params });
      return answers[seen.length - 1] ?? [];
    },
  } as unknown as Db;
  return { db, seen };
}
const count = (params: unknown[], v: string) => params.filter((p) => p === v).length;

describe('who may see it', () => {
  it('nothing for someone with no agency, an outsider, or an admin viewing an agency, and no statement runs', async () => {
    const { db, seen } = fakeDb();
    for (const a of [{ userId: 'x' }, { userId: 'x', agencyId: A }, { userId: 'x', agencyId: A, membershipRole: 'owner', via: 'platform' }] as Actor[]) {
      expect(await controlCentreActivity(db, a, q())).toBeNull();
    }
    expect(seen).toHaveLength(0);
  });

  it('an agent’s five sources are each narrowed to them, in both statements, and their waiting cards too', async () => {
    const { db, seen } = fakeDb();
    await controlCentreActivity(db, agent, q());
    expect(seen).toHaveLength(2);
    expect(count(seen[0]!.params, AGENT)).toBe(5);
    expect(count(seen[1]!.params, AGENT)).toBe(6);
    for (const s of seen) expect(s.params).toContain(A);
  });

  it('an agent cannot widen or move their view with `who`', async () => {
    const { db, seen } = fakeDb();
    const out = await controlCentreActivity(db, agent, q({ who: OTHER }));
    for (const s of seen) expect(s.params).not.toContain(OTHER);
    expect(out?.people).toBeNull();
  });

  it('an owner sees the agency, and `who` narrows it to one person', async () => {
    const all = fakeDb();
    await controlCentreActivity(all.db, owner, q());
    for (const s of all.seen) {
      expect(s.params).toContain(A);
      expect(s.params).not.toContain(OWNER);
    }
    const one = fakeDb();
    await controlCentreActivity(one.db, owner, q({ who: AGENT }));
    expect(count(one.seen[0]!.params, AGENT)).toBe(1);
    // Five tiles and the waiting count; the people list stays everyone's.
    expect(count(one.seen[1]!.params, AGENT)).toBe(6);
  });
});

describe('the figures and rows', () => {
  it('counts arrive as strings and leave as numbers; rows are worded from codes, never free text', async () => {
    const { db } = fakeDb([
      [
        { source: 'phone', id: 'p1', at: '2026-11-14T00:00:00Z', owner_id: AGENT, owner: 'Sarah', what: 'Missed call', sub: '+61412555019', level: 'auto', result: 'ok', note: 'texted', ai_status: 'done', ai: true, total: '2' },
        { source: 'opportunity', id: 'o1', at: '2026-11-13T00:00:00Z', owner_id: OWNER, owner: 'Hannah', what: 'sale_anniversary', sub: 'Mark Ellis', level: 'auto', result: 'ok', note: null, ai_status: null, ai: false, total: '2' },
      ],
      [{ ran: '3', tasks: '2', sent: '11', opportunities: '1', failed: '0', waiting: '4', people: [{ id: AGENT, name: 'Sarah' }] }],
    ]);
    const out = await controlCentreActivity(db, owner, q());
    expect(out?.tiles).toEqual({ ran: 3, tasks: 2, sent: 11, opportunities: 1, waiting: 4, failed: 0 });
    expect(out?.total).toBe(2);
    expect(out?.rows[0]).toMatchObject({ key: 'phone:p1', note: 'Texted from the agent’s number · AI called back', owner: 'Sarah', mine: false });
    expect(out?.rows[1]).toMatchObject({ what: 'Sale anniversary', owner: null, mine: true });
    expect(out?.people).toEqual([{ id: AGENT, name: 'Sarah' }]);
  });

  it('pages by the URL, ordered with a unique tiebreaker', async () => {
    const { db, seen } = fakeDb();
    await controlCentreActivity(db, owner, q({ page: 3 }));
    expect(seen[0]!.params).toContain(2 * CC_PAGE_SIZE);
    expect(seen[0]!.sql).toMatch(/order by f\.at desc, f\.source, f\.id desc/);
  });

  it('a bad URL falls back instead of failing', () => {
    expect(controlCentreQuerySchema.parse({ range: '1y', source: 'x', result: 'nope', who: 'not-a-uuid', page: '2.5' })).toEqual({
      range: '24h', source: 'all', result: 'all', who: undefined, page: 1,
    });
  });
});
