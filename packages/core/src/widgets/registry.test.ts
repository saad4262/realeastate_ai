import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import { previousWindow, rangeWindow, renderWidget, WIDGET_IDS, WIDGETS } from './registry';
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

/** A db that answers every statement with `rows` and counts statements. */
function countingDb(rows: Record<string, unknown>[]) {
  let queries = 0;
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'groupBy', 'limit', 'offset']) chain[m] = () => chain;
  const terminal = () => {
    queries += 1;
    return Promise.resolve(rows);
  };
  chain.execute = terminal;
  chain.then = (res: (v: unknown) => unknown) => terminal().then(res);
  return { db: chain as unknown as Db, count: () => queries };
}

const noDb = new Proxy({}, { get: () => { throw new Error('the database was reached'); } }) as unknown as Db;
const ctx = (db: Db, actor: Actor = owner) => ({ db, actor, now: new Date('2026-10-07T23:30:00Z'), timeZone: 'Australia/Sydney' });

describe('the widget registry', () => {
  it('every widget is complete: params schema, permission, refresh 30–60 s, a description', () => {
    expect(WIDGET_IDS.sort()).toEqual(['email_replies', 'listings_by_status', 'new_leads', 'sold_count', 'sold_value', 'upcoming_appointments']);
    for (const id of WIDGET_IDS) {
      const w = WIDGETS[id];
      expect(w.refreshSeconds, id).toBeGreaterThanOrEqual(30);
      expect(w.refreshSeconds, id).toBeLessThanOrEqual(60);
      expect(w.permission, id).toMatch(/^[a-z_]+:[a-z_]+$/);
      expect(w.describe(w.params.parse({}) as never), id).toMatch(/\S/);
    }
  });

  it('money and sales figures are owner/admin only: an agent gets "no access" and nothing is queried', async () => {
    for (const id of ['sold_value', 'sold_count'] as const) {
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
    for (const id of WIDGET_IDS) {
      const { db, count } = countingDb([row]);
      const tile = await renderWidget(ctx(db), { widget: id, params: {} });
      expect(tile.state, id).toBe('ok');
      expect(count(), id).toBe(1);
      const data = (tile as { data: Record<string, unknown> }).data;
      for (const [k, v] of Object.entries(data)) if (k !== 'kind' && k !== 'rows') expect(typeof v, `${id}.${k}`).toBe('number');
    }
  });

  it('Sold value keeps undisclosed sales apart — counted, never added as $0', async () => {
    const { db } = countingDb([{ total: '2450000.00', count: '3', undisclosed: '2' }]);
    const tile = await renderWidget(ctx(db), { widget: 'sold_value', params: { range: '30d' } });
    expect(tile).toMatchObject({ state: 'ok', data: { kind: 'money', total: 2450000, count: 3, undisclosed: 2 } });
  });

  it('the full-page report is ONE more statement per widget, and only when asked for', async () => {
    const detail = {
      prev: '3', priced: '2', avg: '725000.00', median: null, trend: [{ label: 'Mon 05 Oct', value: '2' }],
      agents: [{ label: 'A', value: '1450000.00' }], types: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ label: `T${n}`, value: String(n) })),
    };
    const row = { total: '1', count: '1', undisclosed: '0', label: 'A', value: '1', type: 'appraisal', live: '1', underOffer: '0', detail };
    for (const id of WIDGET_IDS) {
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
    const { db } = countingDb([{ total: '5', count: '5', undisclosed: '0' }]);
    const failing = new Proxy(db as object, { get: (t, k) => (k === 'execute' ? () => (++n, Promise.reject(new Error('boom'))) : (t as Record<PropertyKey, unknown>)[k]) }) as Db;
    const tile = await renderWidget(ctx(failing), { widget: 'sold_value', params: {} }, { detail: true });
    expect(tile).toMatchObject({ state: 'ok', data: { total: 5 } });
    expect((tile as { detail?: unknown }).detail).toBeUndefined();
    expect(n).toBe(1);
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
    const out = await runAssistantTool({ db, actor: owner, timeZone: 'UTC', handles: {}, now: new Date() }, 'show_widget', { widget: 'sold_value', range: '7d' });
    expect((out.frame as { kind: string }).kind).toBe('widget');
    const forModel = JSON.stringify(out.result);
    for (const n of ['987654', '987,654', '41', '29']) expect(forModel).not.toContain(n);
  });
  it('an agent cannot propose saving a dashboard', async () => {
    const out = await runAssistantTool({ db: noDb, actor: agent, timeZone: 'UTC', handles: {}, now: new Date() }, 'create_dashboard', { title: 'x', widgets: [{ widget: 'new_leads' }] });
    expect(out.isError).toBe(true);
  });
});
