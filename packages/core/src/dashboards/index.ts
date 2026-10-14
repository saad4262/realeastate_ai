import { createHash } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { agency, dashboard, type Db, type DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';
import { renderWidget, WIDGETS, widgetRefSchema, type WidgetRef, type WidgetTile } from '../widgets/registry';
import { widgetPreview, type WidgetPreview } from './preview';

export { PREVIEW_SHAPES, widgetPreview, type PreviewShape, type WidgetPreview } from './preview';

/**
 * Saved dashboards (ADR 0027). Saved by owners/admins only; opened by signed-in
 * members of the same agency according to `audience`; every tile computed AS
 * THE VIEWER at every refresh. There is no share link and no public route.
 */

export class DashboardError extends Error {
  constructor(
    readonly code: 'forbidden' | 'not_found' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'DashboardError';
  }
}

const NOT_FOUND = () => new DashboardError('not_found', 'That dashboard was not found');

export const DASHBOARD_AUDIENCES = ['private', 'admins', 'agency'] as const;
export type DashboardAudience = (typeof DASHBOARD_AUDIENCES)[number];
export const AUDIENCE_LABELS: Record<DashboardAudience, string> = {
  private: 'Only you',
  admins: 'Owners and admins of the agency',
  agency: 'Everyone in the agency (each sees only the figures they may)',
};

/** The longest dashboard worth a TV screen. */
export const MAX_WIDGETS = 12;

export const createDashboardSchema = z
  .object({
    title: z.string().trim().min(1, 'Give it a title').max(80),
    widgets: z.array(widgetRefSchema).min(1).max(MAX_WIDGETS),
    audience: z.enum(DASHBOARD_AUDIENCES).default('admins'),
  })
  .strict()
  .superRefine((v, ctx) => {
    v.widgets.forEach((w, i) => {
      const def = WIDGETS[w.widget];
      const ok = def.params.safeParse(w.params ?? {});
      if (!ok.success) ctx.addIssue({ code: 'custom', path: ['widgets', i, 'params'], message: `Not a valid setting for ${def.title}` });
    });
  });
export type CreateDashboardInput = z.input<typeof createDashboardSchema>;

function resource(d: { id: string; agencyId: string; createdBy: string | null; audience: string }) {
  return {
    type: 'dashboard',
    id: d.id,
    agencyId: d.agencyId,
    ...(d.createdBy ? { ownerId: d.createdBy } : {}),
    audience: d.audience as DashboardAudience,
  };
}

/** Save one. Owners/admins only (decided Q4). Each widget's params are re-parsed by its own schema. */
export async function createDashboard(db: DbOrTx, actor: Actor, input: CreateDashboardInput): Promise<{ id: string }> {
  if (!actor.agencyId || !can(actor, 'dashboard:create', { type: 'dashboard', agencyId: actor.agencyId })) {
    throw new DashboardError('forbidden', 'Only an owner or admin can save a dashboard');
  }
  const parsed = createDashboardSchema.safeParse(input);
  if (!parsed.success) throw new DashboardError('invalid', parsed.error.issues[0]?.message ?? 'Check the dashboard');
  const widgets: WidgetRef[] = parsed.data.widgets.map((w) => ({ widget: w.widget, params: WIDGETS[w.widget].params.parse(w.params ?? {}) }));
  const [row] = await db
    .insert(dashboard)
    .values({ agencyId: actor.agencyId, createdBy: actor.userId, title: parsed.data.title, widgets, audience: parsed.data.audience })
    .returning({ id: dashboard.id });
  return { id: row!.id };
}

export type DashboardSummary = {
  id: string;
  title: string;
  audience: DashboardAudience;
  widgetCount: number;
  /** Each widget's title and shape, for the card's thumbnail — no figures (see preview.ts). */
  preview: WidgetPreview[];
  createdAt: Date;
  mayManage: boolean;
};

/** The dashboards this person may open, newest first. One statement. */
export async function listDashboards(db: Db, actor: Actor): Promise<DashboardSummary[]> {
  if (!actor.agencyId) return [];
  const rows = await db
    .select()
    .from(dashboard)
    .where(and(eq(dashboard.agencyId, actor.agencyId), isNull(dashboard.archivedAt)))
    .orderBy(desc(dashboard.createdAt))
    .limit(100);
  return rows
    .filter((d) => can(actor, 'dashboard:read', resource(d)))
    .map((d) => ({
      id: d.id,
      title: d.title,
      audience: d.audience as DashboardAudience,
      widgetCount: Array.isArray(d.widgets) ? d.widgets.length : 0,
      preview: Array.isArray(d.widgets) ? d.widgets.map(widgetPreview) : [],
      createdAt: new Date(d.createdAt),
      mayManage: can(actor, 'dashboard:manage', resource(d)),
    }));
}

async function loadReadable(db: DbOrTx, actor: Actor, id: string) {
  if (!actor.agencyId || !/^[0-9a-f-]{36}$/i.test(id)) throw NOT_FOUND();
  const [row] = await db
    .select({
      id: dashboard.id,
      agencyId: dashboard.agencyId,
      createdBy: dashboard.createdBy,
      title: dashboard.title,
      widgets: dashboard.widgets,
      audience: dashboard.audience,
      archivedAt: dashboard.archivedAt,
      timeZone: agency.timeZone,
    })
    .from(dashboard)
    .innerJoin(agency, eq(agency.id, dashboard.agencyId))
    .where(and(eq(dashboard.id, id), eq(dashboard.agencyId, actor.agencyId)))
    .limit(1);
  // Not found for anyone who may not open it — a guessed or forwarded link opens nothing.
  if (!row || row.archivedAt || !can(actor, 'dashboard:read', resource(row))) throw NOT_FOUND();
  return row;
}

export type DashboardData = {
  id: string;
  title: string;
  audience: DashboardAudience;
  timeZone: string;
  tiles: WidgetTile[];
  /** How often the page asks again: the shortest of its widgets', never under 30 s. */
  refreshSeconds: number;
  /** A hash of the tiles, so an unchanged poll is a 304. */
  version: string;
  mayManage: boolean;
};

/**
 * Everything one viewer sees on one dashboard, now. One statement for the
 * dashboard and the agency clock, then three per widget — the read guard
 * (timeout + read-only, ADR 0036 P6), its headline and its report — each AS
 * THE VIEWER.
 */
export async function getDashboardData(db: DbOrTx, actor: Actor, id: string, now = new Date()): Promise<DashboardData> {
  const row = await loadReadable(db, actor, id);
  const refs = (Array.isArray(row.widgets) ? row.widgets : []) as { widget: string; params?: unknown }[];
  const tiles: WidgetTile[] = [];
  for (const ref of refs) tiles.push(await renderWidget({ db, actor, now, timeZone: row.timeZone }, ref, { detail: true }));
  const refreshSeconds = Math.max(30, Math.min(...tiles.map((t) => t.refreshSeconds), 60));
  const version = createHash('sha1').update(JSON.stringify(tiles)).digest('hex').slice(0, 16);
  return {
    id: row.id,
    title: row.title,
    audience: row.audience as DashboardAudience,
    timeZone: row.timeZone,
    tiles,
    refreshSeconds,
    version,
    mayManage: can(actor, 'dashboard:manage', resource(row)),
  };
}

/** Archive one: its creator or an admin. */
export async function archiveDashboard(db: Db, actor: Actor, id: string): Promise<void> {
  const row = await loadReadable(db, actor, id);
  if (!can(actor, 'dashboard:manage', resource(row))) throw new DashboardError('forbidden', 'Only its creator or an admin can remove this dashboard');
  await db.update(dashboard).set({ archivedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(dashboard.id, row.id));
}

export {
  agencyTimeZone,
  describeWidget,
  RANGE_LABELS,
  rangeWindow,
  renderWidget,
  WIDGET_IDS,
  WIDGET_RANGES,
  WIDGETS,
  widgetRefSchema,
  type WidgetData,
  type WidgetId,
  type WidgetRange,
  type WidgetRef,
  type WidgetTile,
} from '../widgets/registry';
