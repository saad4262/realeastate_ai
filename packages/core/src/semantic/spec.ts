import { z } from 'zod';
import { RANGE_LABELS, WIDGET_RANGES, type WidgetRange } from '../widgets/ranges';
import { DATASET_IDS, datasetDef, TIME_UNITS, type DatasetDef, type DatasetId, type TimeUnit } from './catalog';

/**
 * A tile spec (ADR 0036 §1): what the model — or a preset in code — asks for.
 * Strict at every level; every id is checked against the catalog for its
 * dataset, every filter value against the dimension's list (or kept as text
 * that only ever becomes a bound parameter). A spec has NO field that can name
 * an agency, a user, a role or a scope (§2): the compiler adds the scope.
 */

export const SPEC_LIMITS = { measures: 4, groupBy: 2, filters: 5, values: 20, valueLength: 100, rows: 50 } as const;

/** Every widget range, plus "all time" for an event dataset with no range (e.g. every contact). */
export const SPEC_RANGES = [...WIDGET_RANGES, 'all_time'] as const;
export type SpecRange = (typeof SPEC_RANGES)[number];
export const SPEC_RANGE_LABELS: Record<SpecRange, string> = { ...RANGE_LABELS, all_time: 'all time' };

export const VIZ = ['number', 'bar', 'line', 'table', 'donut', 'columns'] as const;
export type Viz = (typeof VIZ)[number];

/** The longest a range can be, in days — what a time step may be cut into. */
const RANGE_DAYS: Record<WidgetRange, number> = { today: 1, '7d': 7, '30d': 30, '90d': 90, this_week: 7, this_month: 31, last_month: 31, this_year: 366 };
/** The shortest step each range allows, so a trend has at most ~100 steps. */
const UNIT_MAX_DAYS: Record<TimeUnit, number> = { hour: 2, day: 92, week: 400, month: Infinity };

const filterSchema = z
  .object({
    dimension: z.string().min(1).max(40),
    op: z.enum(['eq', 'in', 'not_in']),
    values: z.array(z.string().trim().min(1).max(SPEC_LIMITS.valueLength)).min(1).max(SPEC_LIMITS.values),
  })
  .strict();

const baseSpec = z
  .object({
    dataset: z.enum(DATASET_IDS as [DatasetId, ...DatasetId[]]),
    measures: z.array(z.string().min(1).max(40)).min(1).max(SPEC_LIMITS.measures),
    groupBy: z.array(z.string().min(1).max(40)).max(SPEC_LIMITS.groupBy).default([]),
    filters: z.array(filterSchema).max(SPEC_LIMITS.filters).default([]),
    range: z.enum(SPEC_RANGES).optional(),
    viz: z.enum(VIZ).optional(),
    limit: z.number().int().min(1).max(SPEC_LIMITS.rows).default(20),
  })
  .strict();

export const tileSpecSchema = baseSpec.superRefine((spec, ctx) => {
  const ds = datasetDef(spec.dataset)!;
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  const known = (kind: string, list: string[]) => `${kind} for ${spec.dataset}: ${list.join(', ')}`;

  if (new Set(spec.measures).size !== spec.measures.length) issue(['measures'], 'A measure is named twice');
  spec.measures.forEach((m, i) => {
    if (!ds.measures[m]) issue(['measures', i], `Unknown measure "${m}". ${known('Measures', Object.keys(ds.measures))}`);
  });

  if (new Set(spec.groupBy).size !== spec.groupBy.length) issue(['groupBy'], 'A dimension is named twice');
  const times = spec.groupBy.filter((g) => isTimeUnit(g));
  if (times.length > 1) issue(['groupBy'], 'Group by at most one time step');
  spec.groupBy.forEach((g, i) => {
    if (isTimeUnit(g)) {
      if (ds.kind !== 'event') issue(['groupBy', i], `${spec.dataset} is the state right now: it has no time steps`);
      return;
    }
    if (!ds.dimensions[g]) issue(['groupBy', i], `Unknown dimension "${g}". ${known('Dimensions', [...Object.keys(ds.dimensions), ...(ds.kind === 'event' ? TIME_UNITS : [])])}`);
  });

  spec.filters.forEach((f, i) => {
    const dim = ds.dimensions[f.dimension];
    if (!dim) return issue(['filters', i, 'dimension'], `Unknown dimension "${f.dimension}". ${known('Dimensions', Object.keys(ds.dimensions))}`);
    if (f.op === 'eq' && f.values.length !== 1) issue(['filters', i, 'values'], '"eq" takes exactly one value');
    if (dim.values) {
      f.values.forEach((v, j) => {
        if (!dim.values!.includes(v)) issue(['filters', i, 'values', j], `"${v}" is not a value of ${f.dimension}: ${dim.values!.join(', ')}`);
      });
    }
  });

  const range = effectiveRange(spec as TileSpec);
  if (ds.kind === 'snapshot' && spec.range && spec.range !== 'all_time') {
    issue(['range'], `${spec.dataset} is the state right now: leave the range out`);
  }
  const unit = times[0] as TimeUnit | undefined;
  if (unit && ds.kind === 'event') {
    if (range === 'all_time') issue(['range'], 'A trend needs a range, not "all time"');
    else if (RANGE_DAYS[range as WidgetRange] > UNIT_MAX_DAYS[unit]) issue(['groupBy'], `Steps of one ${unit} are too fine for ${SPEC_RANGE_LABELS[range]}: use a longer step`);
  }
});

export type TileSpecInput = z.input<typeof tileSpecSchema>;
export type TileSpec = z.output<typeof baseSpec>;

export function isTimeUnit(id: string): id is TimeUnit {
  return (TIME_UNITS as readonly string[]).includes(id);
}

/** The range a spec runs over: its own, else the dataset's default. Snapshots have none ('all_time'). */
export function effectiveRange(spec: Pick<TileSpec, 'dataset' | 'range'>): SpecRange {
  const ds = datasetDef(spec.dataset)!;
  if (ds.kind === 'snapshot') return 'all_time';
  return spec.range ?? (ds.defaultRange as SpecRange);
}

/** How it is drawn when the spec does not say: one figure, a line over time, bars by a category, or a table. */
export function effectiveViz(spec: Pick<TileSpec, 'groupBy' | 'measures' | 'viz'>): Viz {
  if (spec.viz) return spec.viz;
  if (spec.groupBy.length === 0) return 'number';
  if (spec.groupBy.length === 2 || spec.measures.length > 1) return 'table';
  return isTimeUnit(spec.groupBy[0]!) ? 'line' : 'bar';
}

/** Plain words for a tile and the assistant's card: "Sales — Sold value by Agent (Suburb: Carlton) — last month". */
export function describeSpec(spec: TileSpec): string {
  const ds: DatasetDef = datasetDef(spec.dataset)!;
  const measures = spec.measures.map((m) => ds.measures[m]?.label ?? m).join(' and ');
  const by = spec.groupBy.length ? ` by ${spec.groupBy.map((g) => (isTimeUnit(g) ? g : (ds.dimensions[g]?.label ?? g).toLowerCase())).join(' and ')}` : '';
  const filters = spec.filters.length
    ? ` (${spec.filters
        .map((f) => {
          const dim = ds.dimensions[f.dimension];
          const shown = f.values.map((v) => dim?.valueLabels?.[v] ?? v).join(' or ');
          return `${dim?.label ?? f.dimension} ${f.op === 'not_in' ? 'not ' : ''}${shown}`;
        })
        .join('; ')})`
    : '';
  const range = effectiveRange(spec);
  const when = ds.kind === 'snapshot' ? 'now' : SPEC_RANGE_LABELS[range];
  return `${ds.label} — ${measures}${by}${filters} — ${when}`;
}
