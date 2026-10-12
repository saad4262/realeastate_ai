import { and, sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '@repo/db';
import { can, type Action, type Actor } from '../permissions';
import { rangeWindow, type WidgetRange } from '../widgets/ranges';
import { startOfDayIn } from '../time/local-input';
import type { WidgetFormat } from '../widgets/detail';
import { DATASETS, TIME_FORMATS, type DatasetDef, type DatasetId, type MeasureDef, type TimeUnit } from './catalog';
import { effectiveRange, effectiveViz, isTimeUnit, type TileSpec, type Viz } from './spec';

/**
 * The compiler (ADR 0036 §1–§2): a parsed tile spec → ONE SQL statement, run as
 * the viewer. It is the only lock between a spec and every agency's rows (the
 * server bypasses RLS), so:
 *
 * - every id is a key lookup in the catalog; the SQL it returns is written in
 *   code — no `sql.raw` anywhere in this folder (I2);
 * - the dataset's scope predicates are ANDed FIRST, unconditionally (I1);
 * - every spec value (filter values) and every clock value is a bound parameter;
 * - the caller runs it read-only with a statement timeout (`withReadTimeout`, I5).
 *
 * Shape: `base` (the scoped rows, the group keys and the measure columns), then
 * the groups (zero-filled when the only group is a time step), the total over
 * all rows (not just the shown groups), and each measure's companion figures.
 */

export type SemanticRunContext = { db: DbOrTx; actor: Actor; now: Date; timeZone: string };

/** What a custom tile shows. Every number came from SQL; nothing here is computed by a model (#4). */
export type CustomTileData = {
  kind: 'custom';
  dataset: DatasetId;
  viz: Viz;
  measures: { id: string; label: string; format: WidgetFormat }[];
  dimensions: { id: string; label: string }[];
  /** Each measure over ALL the rows in scope (not only the groups shown). Null: nothing to work it out from. */
  total: (number | null)[];
  /** One per group, in order: newest step last for time, largest first otherwise. At most `limit`. */
  rows: { labels: string[]; values: (number | null)[] }[];
  /** Figures that always come with a measure ("3 sold without a disclosed price"). */
  notes: { label: string; value: number }[];
  /** How many groups there are in all (`rows` shows up to the spec's limit). */
  groups: number;
};

const DIM_ALIAS = [sql.identifier('d0'), sql.identifier('d1')];
const LABEL_ALIAS = [sql.identifier('l0'), sql.identifier('l1')];
const MEASURE_ALIAS = [sql.identifier('m0'), sql.identifier('m1'), sql.identifier('m2'), sql.identifier('m3')];

const iso = (d: Date) => d.toISOString();
const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const maybe = (v: unknown) => (v === null || v === undefined ? null : num(v));

const resourceFor = (action: Action, agencyId: string) => ({ type: action.split(':')[0]!, agencyId });

/** Every permission the spec needs: the dataset, each measure, each dimension it groups or filters by. */
export function specPermissions(spec: TileSpec): Action[] {
  const ds: DatasetDef = DATASETS[spec.dataset];
  const out = new Set<Action>([ds.permission]);
  for (const m of spec.measures) if (ds.measures[m]?.permission) out.add(ds.measures[m]!.permission!);
  for (const d of [...spec.groupBy, ...spec.filters.map((f) => f.dimension)]) {
    if (!isTimeUnit(d) && ds.dimensions[d]?.permission) out.add(ds.dimensions[d]!.permission!);
  }
  return [...out];
}

/** I3: asked of the VIEWER on every render. One refusal → the whole tile is "no access", never a tile with a figure missing. */
export function mayViewSpec(actor: Actor, spec: TileSpec): boolean {
  const agencyId = actor.agencyId;
  if (!agencyId) return false;
  return specPermissions(spec).every((a) => can(actor, a, resourceFor(a, agencyId)));
}

/** The window a spec covers, on the agency clock; null for "all time" and snapshots. */
export function specWindow(spec: TileSpec, now: Date, timeZone: string): { from: Date; to: Date } | null {
  const range = effectiveRange(spec);
  return range === 'all_time' ? null : rangeWindow(range as WidgetRange, now, timeZone);
}

/** The scoped WHERE of a spec's rows: scope first (I1), then the dataset's rule, the window and the filters. */
export function specWhere(ctx: SemanticRunContext, spec: TileSpec, window: { from: Date; to: Date } | null): SQL {
  const ds: DatasetDef = DATASETS[spec.dataset];
  const parts: SQL[] = [...ds.scope({ db: ctx.db, actor: ctx.actor }), ...ds.always];
  if (window && ds.time) parts.push(sql`(${ds.time} >= ${iso(window.from)}::timestamptz and ${ds.time} < ${iso(window.to)}::timestamptz)`);
  for (const f of spec.filters) {
    const dim = ds.dimensions[f.dimension]!;
    // A listed value is matched exactly; free text (a suburb, a name) ignores case — "Carlton" is "carlton".
    const exact = !!dim.values;
    const list = sql.join(
      f.values.map((v) => (exact ? sql`${v}` : sql`lower(${v})`)),
      sql`, `,
    );
    const value = exact ? sql`(${dim.expr})` : sql`lower(${dim.expr})`;
    parts.push(f.op === 'not_in' ? sql`${value} not in (${list})` : sql`${value} in (${list})`);
  }
  return and(...parts)!;
}

/** The dataset's columns that measures read, as `expr as name`. */
export function baseColumns(ds: DatasetDef): SQL {
  return sql.join(
    Object.entries(ds.columns).map(([name, expr]) => sql`${expr} as ${sql.identifier(name)}`),
    sql`, `,
  );
}

function measureList(defs: MeasureDef[], wrap: (d: MeasureDef, i: number) => SQL = (d) => d.expr): SQL {
  return sql.join(
    defs.map((d, i) => sql`${wrap(d, i)} as ${MEASURE_ALIAS[i]!}`),
    sql`, `,
  );
}

/** Steps of a trend: from the window's first step to its last — or to today's, when rows cannot be in the future. */
function stepsEnd(ds: DatasetDef, window: { from: Date; to: Date }, now: Date, tz: string): Date {
  if (ds.future) return window.to;
  return new Date(Math.max(window.from.getTime() + 1, Math.min(window.to.getTime(), startOfDayIn(now, tz, 1).getTime())));
}

/** ONE statement for a tile. The returned row has one column, `data` (json). */
export function compileTile(ctx: SemanticRunContext, spec: TileSpec): SQL {
  const ds: DatasetDef = DATASETS[spec.dataset];
  const tz = ctx.timeZone;
  const window = specWindow(spec, ctx.now, tz);
  const measures = spec.measures.map((m) => ds.measures[m]!);
  const companions = measures.flatMap((m) => m.companions ?? []);

  const dims = spec.groupBy.map((g, i) => {
    const unit = isTimeUnit(g) ? g : null;
    const expr = unit ? sql`date_trunc(${unit}::text, ${ds.time!} at time zone ${tz}::text)` : ds.dimensions[g]!.expr;
    return { id: g, unit, expr, alias: DIM_ALIAS[i]!, label: LABEL_ALIAS[i]! };
  });

  const base = sql`select ${dims.length ? sql`${sql.join(dims.map((d) => sql`${d.expr} as ${d.alias}`), sql`, `)}, ` : sql``}${baseColumns(ds)}
    from ${ds.from}
    where ${specWhere(ctx, spec, window)}`;

  const labelOf = (d: (typeof dims)[number]) => (d.unit ? sql`to_char(${d.alias}, ${TIME_FORMATS[d.unit]}::text)` : sql`${d.alias}::text`);
  const measureValues = sql.join(
    measures.map((_, i) => MEASURE_ALIAS[i]!),
    sql`, `,
  );

  let groups: SQL;
  const onlyTime = dims.length === 1 && dims[0]!.unit && window;
  if (!dims.length) {
    // No groups: an empty set with the same columns (an aggregate without GROUP BY would still give one row).
    groups = sql`select null::text as l0, null::text as l1, ${sql.join(
      measures.map((_, i) => sql`null::numeric as ${MEASURE_ALIAS[i]!}`),
      sql`, `,
    )}, 1 as rn, 0 as n where false`;
  } else if (onlyTime) {
    // A trend: every step present — a quiet day is 0 (or "—" for a median), never a gap.
    const d = dims[0]!;
    const unit = d.unit as TimeUnit;
    const end = stepsEnd(ds, window!, ctx.now, tz);
    groups = sql`select to_char(s.b, ${TIME_FORMATS[unit]}::text) as l0, null::text as l1,
        ${measureList(measures, (m, i) => (m.zero ? sql`coalesce(x.${MEASURE_ALIAS[i]!}, 0)` : sql`x.${MEASURE_ALIAS[i]!}`))},
        row_number() over (order by s.b) as rn, count(*) over () as n
      from generate_series(
        date_trunc(${unit}::text, ${iso(window!.from)}::timestamptz at time zone ${tz}::text),
        date_trunc(${unit}::text, (${iso(end)}::timestamptz - interval '1 microsecond') at time zone ${tz}::text),
        ${`1 ${unit}`}::interval) as s(b)
      left join (select d0, ${measureList(measures)} from base group by d0) x on x.d0 = s.b`;
  } else {
    const time = dims.find((d) => d.unit);
    const first = measures[0]!.expr;
    const order = [
      ...(time ? [sql`${time.alias}`] : []),
      sql`${first} desc nulls last`,
      ...dims.filter((d) => !d.unit).map((d) => sql`${d.alias}`),
    ];
    groups = sql`select * from (
        select ${labelOf(dims[0]!)} as l0, ${dims[1] ? labelOf(dims[1]) : sql`null::text`} as l1, ${measureList(measures)},
               row_number() over (order by ${sql.join(order, sql`, `)}) as rn, count(*) over () as n
        from base group by ${sql.join(
          dims.map((d) => d.alias),
          sql`, `,
        )}
      ) x where rn <= ${spec.limit}`;
  }

  const notes = companions.length
    ? sql`(select json_build_array(${sql.join(
        companions.map((c) => c.expr),
        sql`, `,
      )}) from base)`
    : sql`'[]'::json`;

  return sql`with base as (${base}),
    g as (${groups})
    select json_build_object(
      'rows', (select coalesce(json_agg(json_build_object('l', json_build_array(l0, l1), 'v', json_build_array(${measureValues})) order by rn), '[]'::json) from g),
      'groups', (select coalesce(max(n), 0) from g),
      'total', (select json_build_array(${measureValues}) from (select ${measureList(measures)} from base) t),
      'notes', ${notes}
    ) as data`;
}

/** postgres-js hands json back parsed; a string is parsed here so the shape never depends on the driver. */
async function firstJson(db: DbOrTx, query: SQL): Promise<Record<string, unknown>> {
  const res = (await db.execute(query)) as unknown;
  const first = (Array.isArray(res) ? res[0] : (res as { rows?: unknown[] })?.rows?.[0]) as Record<string, unknown> | undefined;
  const d = first?.data;
  if (typeof d === 'string') return JSON.parse(d) as Record<string, unknown>;
  return (d && typeof d === 'object' ? d : {}) as Record<string, unknown>;
}

/**
 * Run a spec as the viewer: ONE statement (I6). The caller has already asked
 * `mayViewSpec` and wrapped this in `withReadTimeout` (renderWidget does both).
 */
export async function runTile(ctx: SemanticRunContext, spec: TileSpec): Promise<CustomTileData> {
  const ds: DatasetDef = DATASETS[spec.dataset];
  const measures = spec.measures.map((m) => ({ id: m, def: ds.measures[m]! }));
  const companions = measures.flatMap((m) => m.def.companions ?? []);
  const d = await firstJson(ctx.db, compileTile(ctx, spec));
  const value = (i: number, v: unknown) => (measures[i]!.def.zero ? num(v) : maybe(v));
  const dimLabel = (g: string, raw: unknown) => {
    const text = raw === null || raw === undefined ? '' : String(raw);
    if (isTimeUnit(g)) return text;
    return ds.dimensions[g]?.valueLabels?.[text] ?? text;
  };
  const totals = Array.isArray(d.total) ? d.total : [];
  const noteValues = Array.isArray(d.notes) ? d.notes : [];
  return {
    kind: 'custom',
    dataset: spec.dataset,
    viz: effectiveViz(spec),
    measures: measures.map((m) => ({ id: m.id, label: m.def.label, format: m.def.format })),
    dimensions: spec.groupBy.map((g) => ({ id: g, label: isTimeUnit(g) ? capitalise(g) : (ds.dimensions[g]?.label ?? g) })),
    total: measures.map((_, i) => value(i, totals[i])),
    rows: (Array.isArray(d.rows) ? d.rows : []).map((r: { l?: unknown[]; v?: unknown[] }) => ({
      labels: spec.groupBy.map((g, i) => dimLabel(g, r.l?.[i])),
      values: measures.map((_, i) => value(i, r.v?.[i])),
    })),
    notes: companions.map((c, i) => ({ label: c.label, value: num(noteValues[i]) })),
    groups: num(d.groups),
  };
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
