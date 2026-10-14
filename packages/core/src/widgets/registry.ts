import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { agency, type DbOrTx } from '@repo/db';
import { can, type Action, type Actor } from '../permissions';
import { ACTIVE_STATUSES } from '../appointments/appointment-schema';
import { isReadTimeout, withReadTimeout } from './read-timeout';
import { RANGE_LABELS, WIDGET_RANGES, type WidgetRange } from './ranges';
import { appointmentsDetail, leadsDetail, listingsDetail, repliesDetail, salesDetail, type WidgetDetail } from './detail';
import { agentActivity, agentsDetail, type AgentActivityRow } from './agents';
import { describeSpec, mayViewSpec, runTile, standardReport, tileSpecSchema, type CustomTileData, type TileSpec } from '../semantic';
import { openTileSchema, runOpenTile, type OpenTileData, type OpenTileSpec } from '../open-query/tile';

/**
 * The FIXED widget library (ADR 0027). A dashboard — or the assistant — can
 * only name a widget id from here and parameters its schema accepts. Each
 * widget is one SQL statement, run AS THE VIEWER through the same scope
 * helpers the screens use; nothing here is generated, and no figure ever
 * comes from a model (#4). A new kind of widget is a code change, reviewed.
 */

export { isReadTimeout, READ_TIMEOUT, withReadTimeout } from './read-timeout';
export { previousWindow, RANGE_LABELS, rangeWindow, WIDGET_RANGES, type WidgetRange } from './ranges';

/** What a widget's query returns. Numbers from SQL only, already Number()-ed. */
export type WidgetData =
  | { kind: 'money'; total: number; count: number; undisclosed: number }
  | { kind: 'count'; total: number }
  | { kind: 'breakdown'; total: number; rows: { label: string; value: number }[] }
  | { kind: 'status'; active: number; rows: { label: string; value: number }[] }
  /** The Agents widget (ADR 0034): totals, how many people are in the agency, and one row per person. */
  | { kind: 'agents'; received: number; sent: number; failed: number; people: number; rows: AgentActivityRow[] }
  /** A tile made of a spec (ADR 0036): any dataset × measures × dimensions from the semantic catalog. */
  | CustomTileData
  /** A tile made of a model-written query (ADR 0042), checked and run as the viewer on every render. */
  | OpenTileData;

export type WidgetContext = { db: DbOrTx; actor: Actor; now: Date; timeZone: string };

type WidgetDef<P extends z.ZodTypeAny> = {
  title: string;
  /** In plain words, for the card and the tile ("Sold value — the last 7 days"). */
  describe: (params: z.infer<P>) => string;
  params: P;
  /** Asked of the VIEWER before the query runs; refused → a "no access" tile. */
  permission: Action;
  /** When the permission depends on the parameters (a spec: its dataset, measures, dimensions) — asked instead of `permission`. */
  permits?: (actor: Actor, params: z.infer<P>) => boolean;
  /** Seconds between refreshes on an open dashboard: 30–60 (ADR 0027 §7). */
  refreshSeconds: number;
  query: (ctx: WidgetContext, params: z.infer<P>) => Promise<WidgetData>;
  /** The full-page report (trend, figures, breakdowns): ONE more statement, same scope. Only the dashboard page asks. */
  detail?: (ctx: WidgetContext, params: z.infer<P>) => Promise<WidgetDetail>;
  /** Runs its own read-only transaction (an open tile: its ticket is inserted first, ADR 0042 L4) — not inside the shared one. */
  ownTransaction?: true;
};

/**
 * A preset (ADR 0036 Phase 1): a fixed widget whose figure is a named spec in
 * code, compiled like any custom tile. Written here, so it may use steps the
 * model's specs may not (a day-by-day trend over a year).
 */
async function runPreset(ctx: WidgetContext, spec: TileSpec): Promise<CustomTileData> {
  return runTile(ctx, spec);
}
const presetSpec = (s: Omit<TileSpec, 'filters' | 'limit' | 'groupBy'> & Partial<Pick<TileSpec, 'filters' | 'limit' | 'groupBy'>>): TileSpec => ({
  groupBy: [],
  filters: [],
  limit: 500,
  ...s,
});

const rangeParams = (fallback: WidgetRange) => z.object({ range: z.enum(WIDGET_RANGES).default(fallback) }).strict();
const noParams = z.object({}).strict();

export const WIDGETS = {
  /**
   * "Revenue" is Sold value (decided by the client): the sum of sold_price of
   * the agency's own sold listings in the range. A sale with no disclosed
   * price is COUNTED APART and never added as zero.
   */
  sold_value: {
    title: 'Sold value',
    describe: (p: { range: WidgetRange }) => `Sold value — ${RANGE_LABELS[p.range]}`,
    params: rangeParams('7d'),
    permission: 'report:read_agency',
    refreshSeconds: 60,
    detail: (ctx, p) => salesDetail(ctx, p.range, 'value'),
    // A preset (ADR 0036 Phase 2): the measure carries its rule — the sales without a disclosed price come with it, never as $0.
    query: async (ctx, p) => {
      const d = await runPreset(ctx, presetSpec({ dataset: 'sales', measures: ['sold_value', 'priced'], range: p.range }));
      return { kind: 'money', total: d.total[0] ?? 0, count: d.total[1] ?? 0, undisclosed: d.notes[0]?.value ?? 0 };
    },
  } satisfies WidgetDef<ReturnType<typeof rangeParams>>,

  sold_count: {
    title: 'Number of sales',
    describe: (p: { range: WidgetRange }) => `Number of sales — ${RANGE_LABELS[p.range]}`,
    params: rangeParams('30d'),
    permission: 'report:read_agency',
    refreshSeconds: 60,
    detail: (ctx, p) => salesDetail(ctx, p.range, 'count'),
    // A preset: sales, counted by lead agent (`leadAgentIdSql`); a sale with no agent row is "No agent".
    query: async (ctx, p) => {
      const d = await runPreset(ctx, presetSpec({ dataset: 'sales', measures: ['count'], groupBy: ['agent'], range: p.range }));
      return { kind: 'breakdown', total: d.total[0] ?? 0, rows: d.rows.map((r) => ({ label: r.labels[0]!, value: r.values[0] ?? 0 })) };
    },
  } satisfies WidgetDef<ReturnType<typeof rangeParams>>,

  /** Enquiries received, by day — the inbox's own scope (an agent's are theirs; offers only for those who may). */
  new_leads: {
    title: 'New leads',
    describe: (p: { range: WidgetRange }) => `New leads — ${RANGE_LABELS[p.range]}`,
    params: rangeParams('7d'),
    permission: 'lead:read',
    refreshSeconds: 30,
    detail: (ctx, p) => leadsDetail(ctx, p.range),
    // A preset: leads by day. The tile lists only days with a lead, oldest first (as before the preset).
    query: async (ctx, p) => {
      const d = await runPreset(ctx, presetSpec({ dataset: 'leads', measures: ['count'], groupBy: ['day'], range: p.range }));
      return { kind: 'breakdown', total: d.total[0] ?? 0, rows: d.rows.filter((r) => (r.values[0] ?? 0) > 0).map((r) => ({ label: r.labels[0]!, value: r.values[0]! })) };
    },
  } satisfies WidgetDef<ReturnType<typeof rangeParams>>,

  /** Appointments starting in the range that are still on, by type — the calendar's own scope. */
  upcoming_appointments: {
    title: 'Appointments',
    describe: (p: { range: WidgetRange }) => `Appointments — ${RANGE_LABELS[p.range]}`,
    params: rangeParams('this_week'),
    permission: 'appointment:read',
    refreshSeconds: 60,
    detail: (ctx, p) => appointmentsDetail(ctx, p.range),
    // A preset: client appointments still on, by type (a team meeting is not business with a customer — ADR 0038 Q4).
    query: async (ctx, p) => {
      const d = await runPreset(
        ctx,
        presetSpec({
          dataset: 'appointments',
          measures: ['count'],
          groupBy: ['type'],
          range: p.range,
          filters: [
            { dimension: 'status', op: 'in', values: [...ACTIVE_STATUSES] },
            { dimension: 'meeting_with', op: 'eq', values: ['client'] },
          ],
        }),
      );
      return { kind: 'breakdown', total: d.total[0] ?? 0, rows: d.rows.map((r) => ({ label: r.labels[0]!, value: r.values[0] ?? 0 })) };
    },
  } satisfies WidgetDef<ReturnType<typeof rangeParams>>,

  /**
   * "Active listings" (client): live + under offer right now, with the split.
   * Agency-wide for those with `listing:read_all`; otherwise only listings the
   * viewer is named on (`listingScopeFilters`).
   */
  listings_by_status: {
    title: 'Active listings',
    describe: () => 'Active listings — now (live + under offer)',
    params: noParams,
    permission: 'listing:read',
    refreshSeconds: 60,
    detail: (ctx) => listingsDetail(ctx),
    // A preset (ADR 0036 Phase 2): the listings snapshot's "active" measure, which always carries its split.
    query: async (ctx) => {
      const d = await runPreset(ctx, presetSpec({ dataset: 'listings', measures: ['active'] }));
      return { kind: 'status', active: d.total[0] ?? 0, rows: d.notes.map((n) => ({ label: n.label, value: n.value })) };
    },
  } satisfies WidgetDef<typeof noParams>,

  /** Email replies received (client): inbound messages in the range on conversations the viewer may read. */
  email_replies: {
    title: 'Email replies',
    describe: (p: { range: WidgetRange }) => `Email replies — ${RANGE_LABELS[p.range]}`,
    params: rangeParams('7d'),
    permission: 'mail:read',
    refreshSeconds: 30,
    detail: (ctx, p) => repliesDetail(ctx, p.range),
    // A preset: emails received, on conversations the viewer may read.
    query: async (ctx, p) => {
      const d = await runPreset(ctx, presetSpec({ dataset: 'emails', measures: ['received'], range: p.range }));
      return { kind: 'count', total: d.total[0] ?? 0 };
    },
  } satisfies WidgetDef<ReturnType<typeof rangeParams>>,

  /**
   * Agents (ADR 0034): every person in the agency — emails received, sent and
   * failed, conversations waiting for a reply, new leads, appointments,
   * listings and contacts. Owners and admins: it is a per-person view. The
   * full page adds each person's emails in the range.
   */
  agent_activity: {
    title: 'Agents',
    describe: (p: { range: WidgetRange }) => `Agents and their emails — ${RANGE_LABELS[p.range]}`,
    params: rangeParams('today'),
    permission: 'report:read_agency',
    refreshSeconds: 30,
    detail: (ctx, p) => agentsDetail(ctx, p.range),
    query: (ctx, p) => agentActivity(ctx, p.range),
  } satisfies WidgetDef<ReturnType<typeof rangeParams>>,

  /**
   * Any tile from the semantic catalog (ADR 0036): `params` is a tile spec,
   * re-parsed on every read. Its permission is the dataset's, each measure's
   * and each dimension's, asked of the viewer on every render (I3).
   */
  custom: {
    title: 'Custom',
    describe: (spec: TileSpec) => describeSpec(spec),
    params: tileSpecSchema,
    permission: 'dashboard:read',
    permits: (actor: Actor, spec: TileSpec) => mayViewSpec(actor, spec),
    refreshSeconds: 60,
    query: (ctx, spec) => runTile(ctx, spec),
    // The standard report (ADR 0036 Phase 4), generated from the dataset's definition.
    detail: (ctx, spec) => standardReport(ctx, spec),
  } satisfies WidgetDef<typeof tileSpecSchema>,

  /**
   * A tile from an open question (ADR 0042): the model's query, re-checked by the parser
   * and run as the viewer — their ticket, their scope — on every render.
   */
  open: {
    title: 'Worked out by the assistant',
    describe: (spec: OpenTileSpec) => spec.title,
    params: openTileSchema,
    permission: 'report:query',
    refreshSeconds: 60,
    query: (ctx, spec) => runOpenTile(ctx.db, ctx.actor, spec, ctx.timeZone),
    ownTransaction: true,
  } satisfies WidgetDef<typeof openTileSchema>,
} as const;

export type { AgentMessage, AgentMessages, DetailRow, DetailSeries, WidgetDetail, WidgetFormat } from './detail';
export type { AgentActivityRow } from './agents';
export type WidgetId = keyof typeof WIDGETS;
export const WIDGET_IDS = Object.keys(WIDGETS) as WidgetId[];

/** A widget on a dashboard, as stored (`dashboard.widgets`) and as the assistant passes it. */
export const widgetRefSchema = z
  .object({ widget: z.enum(WIDGET_IDS as [WidgetId, ...WidgetId[]]), params: z.record(z.unknown()).default({}) })
  .strict();
export type WidgetRef = z.infer<typeof widgetRefSchema>;

export type WidgetTile =
  | { widget: WidgetId; title: string; description: string; refreshSeconds: number; state: 'ok'; data: WidgetData; detail?: WidgetDetail }
  /** `too_slow`: a statement ran past the read timeout (ADR 0036 P6) — "try a shorter range". */
  | { widget: string; title: string; description: string; refreshSeconds: number; state: 'no_access' | 'unavailable' | 'error' | 'too_slow' };

/** The viewer's agency clock — one statement, read once per request. */
export async function agencyTimeZone(db: DbOrTx, agencyId: string): Promise<string> {
  const [r] = await db.select({ tz: agency.timeZone }).from(agency).where(eq(agency.id, agencyId)).limit(1);
  return r?.tz || 'Australia/Sydney';
}

/**
 * One tile, computed AS THE VIEWER. An unknown widget or bad parameters (the
 * code changed since it was saved) is "unavailable"; a widget the viewer may
 * not see is "no access" — the rest of the dashboard still renders.
 */
export async function renderWidget(
  ctx: WidgetContext,
  ref: { widget: string; params?: unknown },
  opts: { detail?: boolean } = {},
): Promise<WidgetTile> {
  const def = (WIDGETS as Record<string, WidgetDef<z.ZodTypeAny>>)[ref.widget];
  if (!def) return { widget: ref.widget, title: 'Widget', description: 'This widget is no longer available', refreshSeconds: 60, state: 'unavailable' };
  const parsed = def.params.safeParse(ref.params ?? {});
  if (!parsed.success) return { widget: ref.widget, title: def.title, description: 'This widget is no longer available', refreshSeconds: def.refreshSeconds, state: 'unavailable' };
  const base = { widget: ref.widget as WidgetId, title: def.title, description: def.describe(parsed.data), refreshSeconds: def.refreshSeconds };
  const allowed = def.permits
    ? def.permits(ctx.actor, parsed.data)
    : can(ctx.actor, def.permission, { type: def.permission.split(':')[0]!, agencyId: ctx.actor.agencyId ?? '' });
  if (!ctx.actor.agencyId || !allowed) {
    return { ...base, state: 'no_access' };
  }
  try {
    if (def.ownTransaction) return { ...base, state: 'ok', data: await def.query(ctx, parsed.data) };
    // The headline and its report share one read-only transaction with a statement timeout (ADR 0036 P6).
    return await withReadTimeout(ctx.db, async (db): Promise<WidgetTile> => {
      const c = { ...ctx, db };
      const data = await def.query(c, parsed.data);
      if (!opts.detail || !def.detail) return { ...base, state: 'ok', data };
      // The report around the headline is extra: if it fails, the headline still shows.
      try {
        return { ...base, state: 'ok', data, detail: await def.detail(c, parsed.data) };
      } catch (err) {
        console.error(`[widgets] ${ref.widget} detail failed`, err instanceof Error ? err.message : err);
        return { ...base, state: 'ok', data };
      }
    });
  } catch (err) {
    console.error(`[widgets] ${ref.widget} failed`, err instanceof Error ? err.message : err);
    return { ...base, state: isReadTimeout(err) ? 'too_slow' : 'error' };
  }
}

/** Plain-words line for a widget reference, for cards ("Sold value — the last 7 days"). */
export function describeWidget(ref: { widget: string; params?: unknown }): string | null {
  const def = (WIDGETS as Record<string, WidgetDef<z.ZodTypeAny>>)[ref.widget];
  if (!def) return null;
  const parsed = def.params.safeParse(ref.params ?? {});
  return parsed.success ? def.describe(parsed.data) : null;
}
