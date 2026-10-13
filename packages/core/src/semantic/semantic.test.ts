import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { and, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { renderWidget } from '../widgets/registry';
import { runAssistantTool } from '../assistant/tools';
import { showWidgetInput } from '../assistant/schema';
import { DATASET_IDS, DATASETS, type DatasetDef } from './catalog';
import { compileTile, mayViewSpec, runTile } from './compile';
import { standardReport } from './report';
import { describeSpec, effectiveViz, SPEC_LIMITS, tileSpecSchema, type TileSpec } from './spec';

/**
 * The semantic layer's invariants (ADR 0036 §5). The compiler is the only lock
 * between a spec and every agency's rows, so each rule here was broken once
 * and seen red.
 */

const agencyId = '22222222-2222-2222-2222-222222222222';
const owner: Actor = { userId: 'aaaaaaaa-0000-0000-0000-000000000001', agencyId, membershipRole: 'owner' };
const agent: Actor = { userId: 'aaaaaaaa-0000-0000-0000-000000000002', agencyId, membershipRole: 'agent' };
const mockDb = drizzle.mock() as unknown as Db;
const dialect = new PgDialect();
const render = (q: SQL) => dialect.sqlToQuery(q);
/** Parameter numbers differ between a fragment and the whole statement: compare without them. */
const shape = (s: string) => s.replace(/\$\d+/g, '$?').replace(/\s+/g, ' ');
const now = new Date('2026-10-07T23:30:00Z');
const ctx = (actor: Actor, db: Db = mockDb) => ({ db, actor, now, timeZone: 'Australia/Sydney' });
const parse = (raw: unknown) => tileSpecSchema.parse(raw) as TileSpec;

/** Every dataset × measure × dimension (and a time step for event datasets): the catalog is small enough to enumerate. */
function everySpec(): TileSpec[] {
  const out: TileSpec[] = [];
  for (const id of DATASET_IDS) {
    const ds: DatasetDef = DATASETS[id];
    for (const m of Object.keys(ds.measures)) {
      out.push(parse({ dataset: id, measures: [m] }));
      for (const d of Object.keys(ds.dimensions)) out.push(parse({ dataset: id, measures: [m], groupBy: [d] }));
      if (ds.kind === 'event') out.push(parse({ dataset: id, measures: [m], groupBy: ['day'], range: '30d' }));
    }
  }
  return out;
}

describe('the tile spec (I7 bounded, §2 no scope field)', () => {
  const ok = { dataset: 'leads', measures: ['count'], groupBy: ['agent'], range: '30d' };
  it('takes a valid spec and fills the defaults', () => {
    expect(parse(ok)).toMatchObject({ dataset: 'leads', measures: ['count'], groupBy: ['agent'], filters: [], limit: 20, range: '30d' });
  });
  it('is bounded: ≤ 4 measures, ≤ 2 group-bys, ≤ 5 filters, ≤ 50 rows', () => {
    const bad = [
      { ...ok, measures: ['count', 'still_new', 'unassigned', 'properties', 'count'] },
      { ...ok, groupBy: ['agent', 'kind', 'status'] },
      { ...ok, filters: Array(6).fill({ dimension: 'kind', op: 'eq', values: ['enquiry'] }) },
      { ...ok, limit: 51 },
      { ...ok, filters: [{ dimension: 'suburb', op: 'in', values: Array(21).fill('x') }] },
    ];
    for (const b of bad) expect(tileSpecSchema.safeParse(b).success, JSON.stringify(b).slice(0, 80)).toBe(false);
    expect(SPEC_LIMITS).toMatchObject({ measures: 4, groupBy: 2, filters: 5, rows: 50 });
  });
  it('has no field that can name an agency, a user, a role or a scope — anything extra is refused', () => {
    for (const extra of [{ agencyId }, { userId: owner.userId }, { scope: 'all' }, { role: 'owner' }, { sql: 'select 1' }]) {
      expect(tileSpecSchema.safeParse({ ...ok, ...extra }).success, Object.keys(extra)[0]).toBe(false);
    }
    expect(tileSpecSchema.safeParse({ ...ok, filters: [{ dimension: 'kind', op: 'eq', values: ['enquiry'], agencyId }] }).success).toBe(false);
  });
  it('only knows the catalog: an unknown dataset, measure or dimension is refused, and the error lists the real ones', () => {
    expect(tileSpecSchema.safeParse({ ...ok, dataset: 'revenue' }).success).toBe(false);
    const m = tileSpecSchema.safeParse({ ...ok, measures: ['commission'] });
    expect(m.success).toBe(false);
    expect(m.error?.issues[0]?.message).toMatch(/Measures for leads: count, still_new/);
    expect(tileSpecSchema.safeParse({ ...ok, groupBy: ['sold_price'] }).success).toBe(false);
  });
  it('checks filter values against the dimension’s list; free-text dimensions keep the text', () => {
    expect(tileSpecSchema.safeParse({ ...ok, filters: [{ dimension: 'kind', op: 'in', values: ['offer'] }] }).success).toBe(false);
    expect(tileSpecSchema.safeParse({ ...ok, filters: [{ dimension: 'kind', op: 'eq', values: ['enquiry', 'appraisal'] }] }).success).toBe(false);
    expect(tileSpecSchema.safeParse({ ...ok, filters: [{ dimension: 'suburb', op: 'in', values: ['Carlton', 'Fitzroy'] }] }).success).toBe(true);
  });
  it('a snapshot has no range and no time steps; a time step must suit the range', () => {
    expect(tileSpecSchema.safeParse({ dataset: 'listings', measures: ['active'], range: '7d' }).success).toBe(false);
    expect(tileSpecSchema.safeParse({ dataset: 'listings', measures: ['active'], groupBy: ['day'] }).success).toBe(false);
    expect(tileSpecSchema.safeParse({ ...ok, groupBy: ['hour'], range: '30d' }).success).toBe(false);
    expect(tileSpecSchema.safeParse({ ...ok, groupBy: ['day'], range: 'this_year' }).success).toBe(false);
    expect(tileSpecSchema.safeParse({ ...ok, groupBy: ['month'], range: 'this_year' }).success).toBe(true);
    expect(tileSpecSchema.safeParse({ ...ok, groupBy: ['day', 'week'] }).success).toBe(false);
    expect(tileSpecSchema.safeParse({ ...ok, groupBy: ['day'], range: 'all_time' }).success).toBe(false);
  });
  it('describes itself in plain words, and picks a sensible way to draw', () => {
    const s = parse({ dataset: 'sales', measures: ['sold_value'], groupBy: ['agent'], filters: [{ dimension: 'suburb', op: 'in', values: ['Carlton'] }], range: 'last_month' });
    expect(describeSpec(s)).toBe('Sales — Sold value by agent (Suburb Carlton) — last month');
    expect(describeSpec(parse({ dataset: 'listings', measures: ['active'] }))).toBe('Listings — Active listings — now');
    expect(effectiveViz(s)).toBe('bar');
    expect(effectiveViz(parse({ dataset: 'leads', measures: ['count'], groupBy: ['day'] }))).toBe('line');
    expect(effectiveViz(parse({ dataset: 'leads', measures: ['count'] }))).toBe('number');
    expect(effectiveViz(parse({ dataset: 'leads', measures: ['count', 'still_new'], groupBy: ['agent'] }))).toBe('table');
  });
});

describe('the compiler', () => {
  it('I1 — scope always: every combination, as an agent and as an admin, carries its dataset’s scope first, with the agency as a parameter', () => {
    const specs = everySpec();
    expect(specs.length).toBeGreaterThan(80);
    for (const actor of [agent, owner]) {
      for (const spec of specs) {
        const ds: DatasetDef = DATASETS[spec.dataset];
        const q = render(compileTile(ctx(actor), spec));
        // The scope, rendered alone, opens the statement's WHERE: "where (<scope> and <the rest>)".
        const scope = shape(render(and(...ds.scope({ db: mockDb, actor }))!).sql).replace(/^\((.*)\)$/, '$1');
        const full = shape(q.sql);
        expect(full.includes(` where (${scope}`) || full.includes(` where ${scope})`), `${actor.membershipRole} ${JSON.stringify(spec)}`).toBe(true);
        expect(q.sql, 'the agency id is never written into the SQL').not.toContain(agencyId);
        expect(q.params, 'the agency id is a bound parameter').toContain(agencyId);
      }
    }
  });

  it('I1 — an agent’s statement is narrower than an admin’s (their own rows), for every dataset', () => {
    for (const id of DATASET_IDS) {
      const spec = parse({ dataset: id, measures: [Object.keys(DATASETS[id].measures)[0]] });
      const a = render(compileTile(ctx(agent), spec));
      const o = render(compileTile(ctx(owner), spec));
      expect(a.params, id).toContain(agent.userId);
      expect(o.params, id).not.toContain(owner.userId);
    }
  });

  it('I2 — a filter value is only ever a bound parameter', () => {
    const evil = "x'); drop table lead; --";
    const q = render(compileTile(ctx(owner), parse({ dataset: 'leads', measures: ['count'], filters: [{ dimension: 'suburb', op: 'eq', values: [evil] }] })));
    expect(q.sql).not.toContain('drop table');
    expect(q.params).toContain(evil);
  });

  it('I2 — nothing in the semantic folder uses sql.raw', () => {
    const dir = __dirname;
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
      expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(/sql\.raw\s*\(/);
    }
  });

  it('I3 — permission per dataset, measure and dimension, as the viewer: one refusal and the tile is "no access", with no query', async () => {
    const noDb = new Proxy({}, { get: () => { throw new Error('the database was reached'); } }) as unknown as Db;
    expect(mayViewSpec(agent, parse({ dataset: 'leads', measures: ['count'] }))).toBe(true);
    expect(mayViewSpec(agent, parse({ dataset: 'leads', measures: ['count'], groupBy: ['agent'] }))).toBe(false);
    expect(mayViewSpec(agent, parse({ dataset: 'leads', measures: ['count'], filters: [{ dimension: 'agent', op: 'eq', values: ['Ava'] }] }))).toBe(false);
    expect(mayViewSpec(agent, parse({ dataset: 'sales', measures: ['count'] }))).toBe(false);
    expect(mayViewSpec(owner, parse({ dataset: 'sales', measures: ['sold_value'], groupBy: ['agent'] }))).toBe(true);
    expect(mayViewSpec({ ...owner, agencyId: undefined } as Actor, parse({ dataset: 'leads', measures: ['count'] }))).toBe(false);
    const tile = await renderWidget({ ...ctx(agent), db: noDb }, { widget: 'custom', params: { dataset: 'leads', measures: ['count'], groupBy: ['agent'] } });
    expect(tile.state).toBe('no_access');
  });

  it('a stored spec is re-parsed on every read: a bad one is "unavailable", never a query', async () => {
    const noDb = new Proxy({}, { get: () => { throw new Error('the database was reached'); } }) as unknown as Db;
    for (const params of [{ dataset: 'leads', measures: ['drop'] }, { dataset: 'leads', measures: ['count'], agencyId: 'x' }, {}]) {
      expect((await renderWidget({ ...ctx(owner), db: noDb }, { widget: 'custom', params })).state).toBe('unavailable');
    }
  });

  it('I6 — one statement per tile, figures are numbers, "nothing to work it out from" stays null', async () => {
    let statements = 0;
    const data = {
      rows: [{ l: ['Ava', null], v: ['3', null] }, { l: ['No agent', null], v: ['1', '650000.00'] }],
      groups: '2',
      total: ['4', '725000'],
      notes: ['1'],
    };
    const db = {
      execute: (q: SQL) => {
        if (!render(q).sql.includes('statement_timeout')) statements += 1;
        return Promise.resolve([{ data }]);
      },
      transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    } as unknown as Db;
    const spec = { dataset: 'sales', measures: ['count', 'median_price'], groupBy: ['agent'] };
    const tile = await renderWidget({ ...ctx(owner), db }, { widget: 'custom', params: spec });
    expect(statements).toBe(1);
    if (tile.state !== 'ok' || tile.data.kind !== 'custom') throw new Error(`expected a custom tile, got ${tile.state}`);
    expect(tile.data.total).toEqual([4, 725000]);
    expect(tile.data.rows).toEqual([
      { labels: ['Ava'], values: [3, null] },
      { labels: ['No agent'], values: [1, 650000] },
    ]);
    expect(tile.data.groups).toBe(2);
    expect(tile.description).toBe('Sales — Sales and Median sold price by agent — the last 30 days');
  });

  it('a measure carries its rule: Sold value always comes with the sales that have no disclosed price, never added as $0', async () => {
    const db = { execute: () => Promise.resolve([{ data: { rows: [], groups: 0, total: ['1450000'], notes: ['2'] } }]) } as unknown as Db;
    const d = await runTile(ctx(owner, db), parse({ dataset: 'sales', measures: ['sold_value'] }));
    expect(d.notes).toEqual([{ label: 'Sold without a disclosed price (not counted as $0)', value: 2 }]);
    expect(shape(render(compileTile(ctx(owner), parse({ dataset: 'sales', measures: ['sold_value'] }))).sql)).toContain('count(*) - count(price)');
  });

  it('a trend has every step (a quiet day is 0) and stops at today unless rows can be in the future', () => {
    const lead = shape(render(compileTile(ctx(owner), parse({ dataset: 'leads', measures: ['count'], groupBy: ['day'], range: 'this_month' }))).sql);
    expect(lead).toContain('generate_series');
    expect(lead).toContain('coalesce(x."m0", 0)');
    const q = render(compileTile(ctx(owner), parse({ dataset: 'appointments', measures: ['active'], groupBy: ['day'], range: 'this_month' })));
    // Appointments run to the end of the month; leads stop at the end of today.
    expect(q.params).toContain('2026-10-31T13:00:00.000Z');
    expect(render(compileTile(ctx(owner), parse({ dataset: 'leads', measures: ['count'], groupBy: ['day'], range: 'this_month' }))).params).toContain('2026-10-08T13:00:00.000Z');
  });
});

describe('the assistant and custom tiles (ADR 0036 Phase 3)', () => {
  const data = { rows: [{ l: ['Carlton', null], v: ['987654', '41'] }], groups: '1', total: ['987654', '41'], notes: ['29'] };
  const fakeDb = (seen: unknown[] = []) =>
    ({
      execute: (q: SQL) => Promise.resolve(render(q).sql.includes('agency') && !render(q).sql.includes('json_build_object') ? [{ tz: 'Australia/Sydney' }] : [{ data, tz: 'Australia/Sydney' }]),
      transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(fakeDb(seen)),
      select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ tz: 'Australia/Sydney' }]) }) }) }),
      insert: () => ({ values: (v: unknown) => (seen.push(v), Promise.resolve()) }),
    }) as unknown as Db;
  const tool = (actor: Actor, name: string, input: unknown, db = fakeDb()) =>
    runAssistantTool({ db, actor, timeZone: 'UTC', handles: {}, now } as never, name, input);

  it('I8 — show_widget with a custom spec hands the model no figure, only that it was shown', async () => {
    const out = await tool(owner, 'show_widget', { widget: 'custom', spec: { dataset: 'sales', measures: ['sold_value', 'count'], groupBy: ['suburb'], range: 'last_month' } });
    expect(out.isError).toBeFalsy();
    expect((out.frame as { kind: string }).kind).toBe('widget');
    const forModel = JSON.stringify(out.result);
    for (const n of ['987654', '987,654', '41', '29', 'Carlton']) expect(forModel).not.toContain(n);
    expect(forModel).toContain('Sales — Sold value and Sales by suburb — last month');
  });

  it('a wrong spec is refused with the catalog’s own words, so the model can correct it', async () => {
    const out = await tool(owner, 'show_widget', { widget: 'custom', spec: { dataset: 'leads', measures: ['revenue'] } });
    expect(out.isError).toBe(true);
    expect((out.result as { error: string }).error).toMatch(/Unknown measure "revenue". Measures for leads: count, still_new, unassigned, properties/);
    expect(showWidgetInput.safeParse({ widget: 'custom' }).success).toBe(false);
    expect(showWidgetInput.safeParse({ widget: 'new_leads', spec: { dataset: 'leads', measures: ['count'] } }).success).toBe(false);
  });

  it('an agent asking for a by-agent tile is told it is not available to them — never a figure', async () => {
    const out = await tool(agent, 'show_widget', { widget: 'custom', spec: { dataset: 'leads', measures: ['count'], groupBy: ['agent'] } });
    expect((out.frame as { tile: { state: string } }).tile.state).toBe('no_access');
  });

  it('report_missing_data writes one gap-log row in the person’s own agency and estimates nothing', async () => {
    const seen: unknown[] = [];
    const out = await tool(agent, 'report_missing_data', { request: 'commission per agent this quarter', nearest_dataset: 'sales', wanted: 'commission per agent' }, fakeDb(seen));
    expect(seen).toEqual([{ agencyId, userId: agent.userId, request: 'commission per agent this quarter', nearestDataset: 'sales', wanted: 'commission per agent' }]);
    expect(out.result).toMatchObject({ noted: true });
    expect((await tool(agent, 'report_missing_data', { request: 'x', wanted: 'y', agencyId: 'other' })).isError).toBe(true);
  });
});

describe('the standard report (ADR 0036 Phase 4)', () => {
  const answer = (detail: unknown) => {
    const seen: string[] = [];
    // The query builder is drizzle's own (an agent's scope builds a sub-select); only execute is faked.
    const execute = (q: SQL) => (seen.push(render(q).sql), Promise.resolve([{ detail }]));
    const db = new Proxy(mockDb as object, { get: (t, k) => (k === 'execute' ? execute : (t as Record<PropertyKey, unknown>)[k]) }) as Db;
    return { db, seen };
  };

  it('is ONE statement with the tile’s own scope and filters, and the comparison is the same point in the period before', async () => {
    const { db, seen } = answer({ prev: '3', kpis: ['2', '1', '4'], trend: [{ label: 'Mon 05 Oct', value: '1' }], b0: [{ label: 'enquiry', value: '5' }], b1: [], b2: [], b3: [] });
    const spec = parse({ dataset: 'leads', measures: ['count'], filters: [{ dimension: 'suburb', op: 'eq', values: ['Pakenham'] }], range: 'this_month' });
    const r = await standardReport(ctx(owner, db), spec);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('"lead"."agency_id"');
    expect(render(compileTile(ctx(owner), spec)).params).toContain('Pakenham');
    expect(r.compare).toEqual({ label: 'vs the same point last month', previous: 3 });
    expect(r.kpis.map((k) => [k.label, k.value])).toEqual([['Still new', 2], ['Not assigned', 1], ['Properties enquired about', 4]]);
    expect(r.breakdowns[0]).toMatchObject({ title: 'Leads by type of enquiry', chart: 'donut', rows: [{ label: 'Enquiry', value: 5 }] });
  });

  it('leaves out a breakdown the viewer may not see (by agent, for an agent), never shows it empty', async () => {
    const owners = await standardReport(ctx(owner, answer({}).db), parse({ dataset: 'leads', measures: ['count'] }));
    const agents = await standardReport(ctx(agent, answer({}).db), parse({ dataset: 'leads', measures: ['count'] }));
    expect(owners.breakdowns.map((b) => b.title)).toContain('Leads by agent');
    expect(agents.breakdowns.map((b) => b.title)).not.toContain('Leads by agent');
  });

  it('a snapshot has no comparison and no trend; a median of nothing stays "—"', async () => {
    const r = await standardReport(ctx(owner, answer({ kpis: ['0', null, null, '3', '0'] }).db), parse({ dataset: 'listings', measures: ['active'] }));
    expect(r.compare).toBeNull();
    expect(r.trend.rows).toEqual([]);
    expect(r.kpis.find((k) => k.label === 'Median days listed')?.value).toBeNull();
  });

  it('a custom tile on the dashboard page gets the standard report; the inline tile does not', async () => {
    let statements = 0;
    const db = {
      execute: (q: SQL) => {
        if (!render(q).sql.includes('statement_timeout')) statements += 1;
        return Promise.resolve([{ data: { rows: [], groups: 0, total: ['1'], notes: [] }, detail: { prev: '0', kpis: [], trend: [] } }]);
      },
      transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    } as unknown as Db;
    const inline = await renderWidget({ ...ctx(owner), db }, { widget: 'custom', params: { dataset: 'emails', measures: ['received'] } });
    expect(statements).toBe(1);
    const page = await renderWidget({ ...ctx(owner), db }, { widget: 'custom', params: { dataset: 'emails', measures: ['received'] } }, { detail: true });
    expect(statements).toBe(3);
    expect((inline as { detail?: unknown }).detail).toBeUndefined();
    expect((page as { detail?: { breakdowns: { title: string }[] } }).detail?.breakdowns[0]?.title).toBe('Emails by direction');
  });
});
