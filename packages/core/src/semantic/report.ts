import { sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '@repo/db';
import { can, type Action } from '../permissions';
import { bucketFor, previousWindow, rangeWindow, type WidgetRange } from '../widgets/ranges';
import { startOfDayIn } from '../time/local-input';
import type { DetailRow, WidgetDetail } from '../widgets/detail';
import { DATASETS, type DatasetDef } from './catalog';
import { baseColumns, specWhere, type SemanticRunContext } from './compile';
import { effectiveRange, isTimeUnit, type TileSpec } from './spec';

/**
 * The standard report (ADR 0036 Phase 4): the full page of a custom tile,
 * generated from its dataset's definition — the first measure against the
 * period before, the dataset's own figures, a zero-filled trend and its
 * breakdowns — in ONE more statement, run as the viewer through the same
 * scope and filters as the tile. A breakdown the viewer may not see (by agent,
 * for an agent) is left out, never shown empty. No `sql.raw`: every id is a
 * catalog key, every value a parameter.
 */

const BREAK_ALIAS = [sql.identifier('b0'), sql.identifier('b1'), sql.identifier('b2'), sql.identifier('b3')];
const iso = (d: Date) => d.toISOString();
const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const maybe = (v: unknown) => (v === null || v === undefined ? null : num(v));

async function firstJson(db: DbOrTx, query: SQL): Promise<Record<string, unknown>> {
  const res = (await db.execute(query)) as unknown;
  const first = (Array.isArray(res) ? res[0] : (res as { rows?: unknown[] })?.rows?.[0]) as Record<string, unknown> | undefined;
  const d = first?.detail;
  if (typeof d === 'string') return JSON.parse(d) as Record<string, unknown>;
  return (d && typeof d === 'object' ? d : {}) as Record<string, unknown>;
}

/** A ring has at most six slices: the rest fold into "Other". */
function fold(rows: DetailRow[]): DetailRow[] {
  if (rows.length <= 6) return rows;
  return [...rows.slice(0, 5), { label: 'Other', value: rows.slice(5).reduce((s, r) => s + r.value, 0) }];
}

export async function standardReport(ctx: SemanticRunContext, spec: TileSpec): Promise<WidgetDetail> {
  const ds: DatasetDef = DATASETS[spec.dataset];
  const tz = ctx.timeZone;
  const first = ds.measures[spec.measures[0]!]!;
  const range = effectiveRange(spec);
  const bounded = ds.kind === 'event' && range !== 'all_time';
  const cur = bounded ? rangeWindow(range as WidgetRange, ctx.now, tz) : null;
  const prev = bounded ? previousWindow(range as WidgetRange, ctx.now, tz) : null;

  // The dataset's figures (the spec's first measure is the headline already), and the breakdowns this viewer may see.
  const kpis = ds.report.kpis.filter((k) => k !== spec.measures[0] && ds.measures[k]).map((k) => ({ id: k, def: ds.measures[k]! }));
  const agencyId = ctx.actor.agencyId ?? '';
  const allowed = (a?: Action) => !a || can(ctx.actor, a, { type: a.split(':')[0]!, agencyId });
  const breakdowns = ds.report.breakdowns
    .filter((b) => ds.dimensions[b.dimension] && allowed(ds.dimensions[b.dimension]!.permission))
    // A breakdown by what the tile already filters to one value says nothing.
    .filter((b) => !spec.filters.some((f) => f.dimension === b.dimension && f.op === 'eq'))
    .slice(0, 4);

  const measureOf = (b: (typeof breakdowns)[number]) => (b.measure && ds.measures[b.measure]) || first;
  const extra: SQL[] = breakdowns.map((b, i) => sql`${ds.dimensions[b.dimension]!.expr} as ${BREAK_ALIAS[i]!}`);
  if (bounded) {
    extra.push(sql`${ds.time!} as t_`);
    extra.push(sql`(${ds.time!} >= ${iso(cur!.from)}::timestamptz) as is_cur`);
    extra.push(sql`(${ds.time!} >= ${iso(prev!.from)}::timestamptz and ${ds.time!} < ${iso(prev!.to)}::timestamptz) as is_prev`);
  } else {
    extra.push(sql`true as is_cur`, sql`false as is_prev`);
  }
  // The rows of both windows; the comparison window ends where "so far" ends, the current one is the tile's.
  const where = specWhere(ctx, spec, bounded ? { from: prev!.from, to: cur!.to } : null);
  const base = sql`select ${sql.join(extra, sql`, `)}, ${baseColumns(ds)} from ${ds.from} where ${where}`;

  let trend: SQL = sql`'[]'::json`;
  if (bounded) {
    const end = ds.future ? cur!.to : new Date(Math.max(cur!.from.getTime() + 1, Math.min(cur!.to.getTime(), startOfDayIn(ctx.now, tz, 1).getTime())));
    const { unit, format } = bucketFor(cur!.from, end);
    trend = sql`(select coalesce(json_agg(json_build_object('label', to_char(g.b, ${format}::text), 'value', ${first.zero ? sql`coalesce(x.v, 0)` : sql`x.v`}) order by g.b), '[]'::json)
      from generate_series(
        date_trunc(${unit}::text, ${iso(cur!.from)}::timestamptz at time zone ${tz}::text),
        date_trunc(${unit}::text, (${iso(end)}::timestamptz - interval '1 microsecond') at time zone ${tz}::text),
        ${`1 ${unit}`}::interval) as g(b)
      left join (select date_trunc(${unit}::text, t_ at time zone ${tz}::text) as k, ${first.expr} as v from cur group by 1) x on x.k = g.b)`;
  }

  const fields: SQL[] = [
    sql`'prev', ${bounded ? sql`(select ${first.expr} from base where is_prev)` : sql`null`}`,
    sql`'kpis', ${kpis.length ? sql`(select json_build_array(${sql.join(kpis.map((k) => k.def.expr), sql`, `)}) from cur)` : sql`'[]'::json`}`,
    sql`'trend', ${trend}`,
    ...breakdowns.map((b, i) => {
      const m = measureOf(b);
      return sql`${`b${i}`}::text, (select coalesce(json_agg(json_build_object('label', l, 'value', v) order by o), '[]'::json) from (
          select ${BREAK_ALIAS[i]!}::text as l, ${m.expr} as v, row_number() over (order by ${m.expr} desc nulls last, ${BREAK_ALIAS[i]!}) as o
          from cur group by ${BREAK_ALIAS[i]!}) x where o <= 20)`;
    }),
  ];

  const d = await firstJson(
    ctx.db,
    sql`with base as (${base}), cur as (select * from base where is_cur)
      select json_build_object(${sql.join(fields, sql`, `)}) as detail`,
  );

  const rows = (v: unknown, dimension?: string): DetailRow[] =>
    (Array.isArray(v) ? v : []).map((r: { label?: unknown; value?: unknown }) => {
      const raw = String(r?.label ?? '');
      const label = dimension && !isTimeUnit(dimension) ? (ds.dimensions[dimension]?.valueLabels?.[raw] ?? raw) : raw;
      return { label, value: num(r?.value) };
    });
  const kpiValues = Array.isArray(d.kpis) ? d.kpis : [];
  return {
    compare: bounded ? { label: prev!.label, previous: num(d.prev) } : null,
    kpis: kpis.map((k, i) => ({ label: k.def.label, value: k.def.zero ? num(kpiValues[i]) : maybe(kpiValues[i]), format: k.def.format })),
    trend: { title: `${first.label} over time`, format: first.format, rows: rows(d.trend) },
    breakdowns: breakdowns.map((b, i) => {
      const r = rows(d[`b${i}`], b.dimension);
      const m = measureOf(b);
      return { title: `${m.label} by ${ds.dimensions[b.dimension]!.label.toLowerCase()}`, format: m.format, chart: b.chart, rows: b.chart === 'donut' ? fold(r) : r };
    }),
  };
}
