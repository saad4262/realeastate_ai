import { describe, expect, it } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Db } from '@repo/db';
import { previousWindow, rangeWindow, renderWidget, withReadTimeout, WIDGET_IDS, WIDGETS } from './registry';
import { createDashboard, createDashboardSchema } from '../dashboards';
import { runAssistantTool } from '../assistant/tools';
import type { Actor } from '../permissions';

/**
 * The fixed widget library (ADR 0027): every entry is complete, each is one
 * statement, figures are numbers from SQL, an undisclosed sale is never $0,
 * and the model is never handed a figure.
 */

const agencyId = '11111111-1111-1111-1111-111111111111';
const owner: Actor = { userId: 'u-owner', agencyId, membershipRole: 'owner' };
const agent: Actor = { userId: 'u-agent', agencyId, membershipRole: 'agent' };

const dialect = new PgDialect();
const text = (q: unknown) => (q && typeof q === 'object' && 'queryChunks' in q ? dialect.sqlToQuery(q as SQL).sql : '');
/** The read guard's own statement (ADR 0036 P6), told apart from a widget's. */
const isGuard = (q: unknown) => text(q).includes('statement_timeout');

/**
 * A db that answers every statement with `rows` and counts statements. The
 * read guard is counted apart (`guards`), so `count` stays the widget's own;
 * a transaction hands over the same db (a Proxy around it included).
 */
function countingDb(rows: Record<string, unknown>[]) {
  let queries = 0;
  let guards = 0;
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'groupBy', 'limit', 'offset']) chain[m] = () => chain;
  const terminal = (q?: unknown) => {
    if (isGuard(q)) guards += 1;
    else queries += 1;
    return Promise.resolve(rows);
  };
  chain.execute = terminal;
  chain.then = (res: (v: unknown) => unknown) => terminal().then(res);
  chain.transaction = function (this: unknown, fn: (tx: unknown) => Promise<unknown>) {
    return fn(this);
  };
  return { db: chain as unknown as Db, count: () => queries, guards: () => guards };
}

const noDb = new Proxy({}, { get: () => { throw new Error('the database was reached'); } }) as unknown as Db;
/** The fixed widgets; `custom` takes a spec (semantic.test.ts) and `open` a query (open-query/*.test.ts) — each has its own tests. */
const FIXED = WIDGET_IDS.filter((id) => id !== 'custom' && id !== 'open');
const ctx = (db: Db, actor: Actor = owner) => ({ db, actor, now: new Date('2026-10-07T23:30:00Z'), timeZone: 'Australia/Sydney' });

describe('the widget registry', () => {
  it('every widget is complete: params schema, permission, refresh 30–60 s, a description', () => {
    expect([...WIDGET_IDS].sort()).toEqual(['agent_activity', 'custom', 'email_replies', 'listings_by_status', 'new_leads', 'open', 'sold_count', 'sold_value', 'upcoming_appointments']);
    for (const id of FIXED) {
      const w = WIDGETS[id];
      expect(w.refreshSeconds, id).toBeGreaterThanOrEqual(30);
      expect(w.refreshSeconds, id).toBeLessThanOrEqual(60);
      expect(w.permission, id).toMatch(/^[a-z_]+:[a-z_]+$/);
      expect(w.describe(w.params.parse({}) as never), id).toMatch(/\S/);
    }
  });

  it('money and sales figures are owner/admin only: an agent gets "no access" and nothing is queried', async () => {
    for (const id of ['sold_value', 'sold_count', 'agent_activity'] as const) {
      const tile = await renderWidget(ctx(noDb, agent), { widget: id, params: {} });
      expect(tile.state, id).toBe('no_access');
    }
  });

  it('an unknown widget or bad settings is "unavailable", never a crash or a query', async () => {
    expect((await renderWidget(ctx(noDb), { widget: 'revenue_forecast', params: {} })).state).toBe('unavailable');
    expect((await renderWidget(ctx(noDb), { widget: 'sold_value', params: { range: 'forever' } })).state).toBe('unavailable');
    expect((await renderWidget(ctx(noDb), { widget: 'sold_value', params: { range: '7d', sql: 'drop table' } })).state).toBe('unavailable');
  });

  it('each widget is one statement, and every figure is a number (Postgres sends strings)', async () => {
    const row = { total: '2450000.00', count: '3', undisclosed: '1', label: 'A', value: '2', type: 'appraisal', live: '4', underOffer: '1', first: 'x' };
    for (const id of FIXED) {
      const { db, count } = countingDb([row]);
      const tile = await renderWidget(ctx(db), { widget: id, params: {} });
      expect(tile.state, id).toBe('ok');
      expect(count(), id).toBe(1);
      const data = (tile as { data: Record<string, unknown> }).data;
      for (const [k, v] of Object.entries(data)) if (k !== 'kind' && k !== 'rows') expect(typeof v, `${id}.${k}`).toBe('number');
    }
  });

  it('Sold value keeps undisclosed sales apart — counted, never added as $0', async () => {
    // A preset now (ADR 0036 Phase 2): the compiled tile's json — the total, the priced count, the companion.
    const { db } = countingDb([{ data: { rows: [], groups: 0, total: ['2450000.00', '3'], notes: ['2'] } }]);
    const tile = await renderWidget(ctx(db), { widget: 'sold_value', params: { range: '30d' } });
    expect(tile).toMatchObject({ state: 'ok', data: { kind: 'money', total: 2450000, count: 3, undisclosed: 2 } });
  });

  it('the full-page report is ONE more statement per widget, and only when asked for', async () => {
    const detail = {
      prev: '3', priced: '2', avg: '725000.00', median: null, trend: [{ label: 'Mon 05 Oct', value: '2' }],
      agents: [{ label: 'A', value: '1450000.00' }], types: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ label: `T${n}`, value: String(n) })),
    };
    const row = { total: '1', count: '1', undisclosed: '0', label: 'A', value: '1', type: 'appraisal', live: '1', underOffer: '0', detail };
    for (const id of FIXED) {
      const plain = countingDb([row]);
      expect((await renderWidget(ctx(plain.db), { widget: id, params: {} })).state, id).toBe('ok');
      expect(plain.count(), `${id} without detail`).toBe(1);
      const full = countingDb([row]);
      const tile = (await renderWidget(ctx(full.db), { widget: id, params: {} }, { detail: true })) as { detail?: Record<string, unknown> };
      expect(full.count(), `${id} with detail`).toBe(2);
      const d = tile.detail as { kpis: { value: unknown }[]; trend: { rows: { value: unknown }[] }; breakdowns: { chart: string; rows: { value: unknown }[] }[] };
      expect(d, id).toBeDefined();
      for (const k of d.kpis) expect(k.value === null || typeof k.value === 'number', id).toBe(true);
      for (const r of [...d.trend.rows, ...d.breakdowns.flatMap((b) => b.rows)]) expect(typeof r.value, id).toBe('number');
      // A ring never has more than six slices.
      for (const b of d.breakdowns) if (b.chart === 'donut') expect(b.rows.length, id).toBeLessThanOrEqual(6);
    }
  });

  it('a median of nothing is "no figure", never 0', async () => {
    const { db } = countingDb([{ total: '0', count: '0', undisclosed: '0', detail: { median: null, dom: null } }]);
    const tile = (await renderWidget(ctx(db), { widget: 'sold_value', params: {} }, { detail: true })) as { detail: { kpis: { label: string; value: unknown }[] } };
    expect(tile.detail.kpis.find((k) => k.label === 'Median sold price')?.value).toBeNull();
  });

  it('a report that fails still leaves the headline', async () => {
    let n = 0;
    const { db } = countingDb([{ data: { rows: [], groups: 0, total: ['5', '5'], notes: ['0'] } }]);
    const execute = (db as unknown as { execute: (q: unknown) => Promise<unknown> }).execute;
    // Only the report's statement fails; the headline's (and the guard's) answer.
    const failing = new Proxy(db as object, {
      get: (t, k) => (k === 'execute' ? (q: unknown) => (!text(q).includes('as detail') ? execute(q) : (++n, Promise.reject(new Error('boom')))) : (t as Record<PropertyKey, unknown>)[k]),
    }) as Db;
    const tile = await renderWidget(ctx(failing), { widget: 'sold_value', params: {} }, { detail: true });
    expect(tile).toMatchObject({ state: 'ok', data: { total: 5 } });
    expect((tile as { detail?: unknown }).detail).toBeUndefined();
    expect(n).toBe(1);
  });

  it('every widget reads inside the read guard: a statement timeout and read-only, first (ADR 0036 P6)', async () => {
    const row = { total: '1', count: '1', undisclosed: '0', label: 'A', value: '1', type: 'appraisal', live: '1', underOffer: '0' };
    for (const id of FIXED) {
      const { db, count, guards } = countingDb([row]);
      expect((await renderWidget(ctx(db), { widget: id, params: {} })).state, id).toBe('ok');
      expect(guards(), id).toBe(1);
      expect(count(), id).toBe(1);
    }
  });

  it('a statement cancelled by the timeout is a "too slow" tile, not a crash', async () => {
    const { db } = countingDb([]);
    const execute = (db as unknown as { execute: (q: unknown) => Promise<unknown> }).execute;
    const slow = new Proxy(db as object, {
      get: (t, k) =>
        k === 'execute'
          ? (q: unknown) => (isGuard(q) ? execute(q) : Promise.reject(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })))
          : (t as Record<PropertyKey, unknown>)[k],
    }) as Db;
    expect((await renderWidget(ctx(slow), { widget: 'agent_activity', params: {} })).state).toBe('too_slow');
    const broken = new Proxy(db as object, {
      get: (t, k) => (k === 'execute' ? (q: unknown) => (isGuard(q) ? execute(q) : Promise.reject(new Error('boom'))) : (t as Record<PropertyKey, unknown>)[k]),
    }) as Db;
    expect((await renderWidget(ctx(broken), { widget: 'agent_activity', params: {} })).state).toBe('error');
  });

  it('the read guard sets a 3 s timeout and read-only with SET LOCAL, returns the value, and never commits', async () => {
    const seen: string[] = [];
    let rolledBack = false;
    const tx = { execute: (q: unknown) => (seen.push(text(q)), Promise.resolve([])) };
    const db = {
      transaction: async (fn: (t: unknown) => Promise<unknown>) => {
        try {
          return await fn(tx);
        } catch (err) {
          rolledBack = true;
          throw err;
        }
      },
    } as unknown as Db;
    const value = await withReadTimeout(db, async (t) => {
      await t.execute(sql`select 1`);
      return 42;
    });
    expect(value).toBe(42);
    expect(rolledBack).toBe(true);
    expect(seen[0]).toMatch(/set_config\('statement_timeout', \$1, true\), set_config\('transaction_read_only', 'on', true\)/);
    expect(seen).toHaveLength(2);
    // A real error inside still comes out as itself.
    await expect(withReadTimeout(db, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  });

  it('a period still under way is compared with the same point in the one before', () => {
    const now = new Date('2026-10-07T23:30:00Z'); // Thu 8 Oct, 10:30 Sydney
    const tz = 'Australia/Sydney';
    expect(previousWindow('7d', now, tz)).toMatchObject({ from: new Date('2026-09-24T14:00:00Z'), to: new Date('2026-10-01T14:00:00Z') });
    const m = previousWindow('this_month', now, tz);
    expect(m.from).toEqual(new Date('2026-08-31T14:00:00Z'));
    expect(m.to.getTime() - m.from.getTime()).toBe(now.getTime() - rangeWindow('this_month', now, tz).from.getTime());
    expect(previousWindow('last_month', now, tz)).toMatchObject({ from: new Date('2026-07-31T14:00:00Z'), to: new Date('2026-08-31T14:00:00Z') });
    expect(previousWindow('this_year', now, tz).from).toEqual(new Date('2024-12-31T13:00:00Z'));
    for (const r of ['today', '7d', '30d', '90d', 'this_week', 'this_month', 'last_month', 'this_year'] as const) {
      const p = previousWindow(r, now, tz);
      expect(p.to.getTime(), r).toBeLessThanOrEqual(rangeWindow(r, now, tz).from.getTime());
    }
  });

  it('ranges are on the agency clock', () => {
    const now = new Date('2026-10-07T23:30:00Z'); // Thu 8 Oct, 10:30 Sydney
    expect(rangeWindow('today', now, 'Australia/Sydney')).toEqual({ from: new Date('2026-10-07T13:00:00Z'), to: new Date('2026-10-08T13:00:00Z') });
    expect(rangeWindow('this_week', now, 'Australia/Sydney').from).toEqual(new Date('2026-10-04T13:00:00Z'));
    expect(rangeWindow('last_month', now, 'Australia/Sydney')).toEqual({ from: new Date('2026-08-31T14:00:00Z'), to: new Date('2026-09-30T14:00:00Z') });
  });
});

describe('the Agents widget (ADR 0034)', () => {
  const data = {
    received: '5', sent: '3', failed: '1', people: '2',
    rows: [
      { user_id: 'u-a', name: 'Ava Agent', email: 'ava@x.au', phone: '0400 000 000', role: 'agent', current: true, received: '3', sent: '2', failed: '1',
        awaiting_reply: '2', new_leads: '4', appointments: '1', active_listings: '6', contacts: '9', last_email_at: '2026-10-07T22:00:00+00:00' },
      { user_id: 'u-owner', name: 'Olly Owner', email: 'o@x.au', phone: null, role: 'owner', current: true, received: '0', sent: '1', failed: '0',
        awaiting_reply: '0', new_leads: '0', appointments: '0', active_listings: '0', contacts: '0', last_email_at: null },
      { user_id: null, name: 'No agent', email: null, phone: null, role: null, current: true, received: '2', sent: '0', failed: '0',
        awaiting_reply: '1', new_leads: '1', appointments: '0', active_listings: '0', contacts: '0', last_email_at: '2026-10-07T21:00:00+00:00' },
    ],
  };

  it('is one statement, every person a row with numbers, a quiet person kept with 0s, and the rows add up to the totals', async () => {
    const { db, count } = countingDb([{ data }]);
    const tile = await renderWidget(ctx(db), { widget: 'agent_activity', params: { range: 'today' } });
    expect(count()).toBe(1);
    if (tile.state !== 'ok' || tile.data.kind !== 'agents') throw new Error('expected the agents data');
    expect(tile.data).toMatchObject({ received: 5, sent: 3, failed: 1, people: 2 });
    expect(tile.data.rows[0]).toEqual({
      userId: 'u-a', name: 'Ava Agent', email: 'ava@x.au', phone: '0400 000 000', role: 'agent', current: true, received: 3, sent: 2, failed: 1,
      awaitingReply: 2, newLeads: 4, appointments: 1, activeListings: 6, contacts: 9, lastEmailAt: '2026-10-07T22:00:00+00:00',
    });
    expect(tile.data.rows[1]).toMatchObject({ name: 'Olly Owner', received: 0, sent: 1, lastEmailAt: null });
    expect(tile.data.rows[2]).toMatchObject({ userId: null, name: 'No agent', received: 2 });
    expect(tile.data.rows.reduce((s, r) => s + r.received, 0)).toBe(tile.data.received);
    expect(tile.data.rows.reduce((s, r) => s + r.sent, 0)).toBe(tile.data.sent);
  });

  it('defaults to today, and the description says so', () => {
    expect(WIDGETS.agent_activity.params.parse({})).toEqual({ range: 'today' });
    expect(WIDGETS.agent_activity.describe({ range: 'today' })).toBe('Agents and their emails — today');
  });

  it('the full page lists each person’s emails as text, in one more statement', async () => {
    const detail = {
      prev: '1', received: '2', sent: '1', failed: '0', threads: '2', agents_n: '1', per_day: '2',
      trend: [{ label: '09:00', value: '2' }], in_by_agent: [{ label: 'Ava Agent', value: '2' }], out_by_agent: [], kinds: [], weekdays: [],
      people: [
        { user_id: 'u-a', total: '40', messages: [
          { id: 'm1', thread_id: 't1', dir: 'in', status: 'received', at: '2026-10-07T22:00:00+00:00', subject: 'Re: 4 Smith St', other: 'Bea Buyer', snippet: 'Is it still available?', kind: 'enquiry' },
          { id: 'm2', thread_id: 't1', dir: 'out', status: 'failed', at: '2026-10-07T21:00:00+00:00', subject: 'Re: 4 Smith St', other: 'Bea Buyer', snippet: 'Yes', kind: 'enquiry' },
        ] },
        { user_id: null, total: '1', messages: [] },
      ],
    };
    const { db, count } = countingDb([{ data, detail }]);
    const tile = await renderWidget(ctx(db), { widget: 'agent_activity', params: { range: 'today' } }, { detail: true });
    expect(count()).toBe(2);
    if (tile.state !== 'ok') throw new Error('expected ok');
    const people = tile.detail?.people ?? [];
    expect(people[0]).toMatchObject({ userId: 'u-a', total: 40 });
    expect(people[0]!.messages.map((m) => [m.direction, m.status, m.threadId])).toEqual([['in', 'received', 't1'], ['out', 'failed', 't1']]);
    expect(people[1]).toEqual({ userId: null, total: 1, messages: [] });
    expect(tile.detail?.breakdowns.find((b) => b.chart === 'donut')?.rows).toEqual([{ label: 'Received', value: 2 }, { label: 'Sent', value: 1 }]);
  });

  it('show_widget hands the model no name, email, subject or figure', async () => {
    const { db } = countingDb([{ tz: 'Australia/Sydney', data }]);
    const out = await runAssistantTool({ db, actor: owner, skillsOff: async () => new Set(), timeZone: 'UTC', handles: {}, now: new Date() }, 'show_widget', { widget: 'agent_activity', range: 'today' });
    expect((out.frame as { kind: string }).kind).toBe('widget');
    const forModel = JSON.stringify(out.result);
    for (const s of ['Ava', 'ava@x.au', '0400', 'Olly', '"5"', ':5', ':3']) expect(forModel).not.toContain(s);
  });
});

describe('saving a dashboard', () => {
  const ok = { title: 'Sales this week', widgets: [{ widget: 'sold_value' as const, params: { range: 'this_week' } }], audience: 'admins' as const };
  it('takes only registry widgets with valid settings, at most 12, and nothing else', () => {
    expect(createDashboardSchema.safeParse(ok).success).toBe(true);
    expect(createDashboardSchema.safeParse({ ...ok, widgets: [{ widget: 'custom_sql', params: {} }] }).success).toBe(false);
    expect(createDashboardSchema.safeParse({ ...ok, widgets: [{ widget: 'sold_value', params: { range: 'forever' } }] }).success).toBe(false);
    expect(createDashboardSchema.safeParse({ ...ok, widgets: Array(13).fill(ok.widgets[0]) }).success).toBe(false);
    expect(createDashboardSchema.safeParse({ ...ok, share: 'public' }).success).toBe(false);
    expect(createDashboardSchema.safeParse({ ...ok, audience: 'public' }).success).toBe(false);
  });
  it('an agent cannot save one (refused before the database)', async () => {
    await expect(createDashboard(noDb, agent, ok)).rejects.toThrow(/owner or admin/);
  });
});

describe('the assistant and widgets', () => {
  it('show_widget hands the model no figure — only that it was shown', async () => {
    const { db } = countingDb([{ tz: 'Australia/Sydney', total: '987654.00', count: '41', undisclosed: '29' }]);
    const out = await runAssistantTool({ db, actor: owner, skillsOff: async () => new Set(), timeZone: 'UTC', handles: {}, now: new Date() }, 'show_widget', { widget: 'sold_value', range: '7d' });
    expect((out.frame as { kind: string }).kind).toBe('widget');
    const forModel = JSON.stringify(out.result);
    for (const n of ['987654', '987,654', '41', '29']) expect(forModel).not.toContain(n);
  });
  it('an agent cannot propose saving a dashboard', async () => {
    const out = await runAssistantTool({ db: noDb, actor: agent, skillsOff: async () => new Set(), timeZone: 'UTC', handles: {}, now: new Date() }, 'create_dashboard', { title: 'x', widgets: [{ widget: 'new_leads' }] });
    expect(out.isError).toBe(true);
  });
});
