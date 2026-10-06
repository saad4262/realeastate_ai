import { and, eq, gte, inArray, isNull, lt, ne, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { agency, appointment, lead, listing, listingAgent, mailMessage, mailThread, user, type DbOrTx } from '@repo/db';
import { can, type Action, type Actor } from '../permissions';
import { leadScopeFilters } from '../leads/list-leads';
import { appointmentScopeFilters } from '../appointments/appointments';
import { ACTIVE_STATUSES, APPOINTMENT_TYPE_LABELS, type AppointmentType } from '../appointments/appointment-schema';
import { threadScopeFilters } from '../mail/threads';
import { startOfDayIn, startOfMonthIn, startOfWeekIn, startOfYearIn } from '../time/local-input';

/**
 * The FIXED widget library (ADR 0027). A dashboard — or the assistant — can
 * only name a widget id from here and parameters its schema accepts. Each
 * widget is one SQL statement, run AS THE VIEWER through the same scope
 * helpers the screens use; nothing here is generated, and no figure ever
 * comes from a model (#4). A new kind of widget is a code change, reviewed.
 */

export const WIDGET_RANGES = ['today', '7d', '30d', '90d', 'this_week', 'this_month', 'last_month', 'this_year'] as const;
export type WidgetRange = (typeof WIDGET_RANGES)[number];

export const RANGE_LABELS: Record<WidgetRange, string> = {
  today: 'today',
  '7d': 'the last 7 days',
  '30d': 'the last 30 days',
  '90d': 'the last 90 days',
  this_week: 'this week',
  this_month: 'this month',
  last_month: 'last month',
  this_year: 'this year',
};

/** The time window a range means, on the agency's clock. `to` is exclusive. */
export function rangeWindow(range: WidgetRange, now: Date, tz: string): { from: Date; to: Date } {
  switch (range) {
    case 'today':
      return { from: startOfDayIn(now, tz), to: startOfDayIn(now, tz, 1) };
    case '7d':
      return { from: startOfDayIn(now, tz, -6), to: startOfDayIn(now, tz, 1) };
    case '30d':
      return { from: startOfDayIn(now, tz, -29), to: startOfDayIn(now, tz, 1) };
    case '90d':
      return { from: startOfDayIn(now, tz, -89), to: startOfDayIn(now, tz, 1) };
    case 'this_week':
      return { from: startOfWeekIn(now, tz), to: startOfWeekIn(now, tz, 1) };
    case 'this_month':
      return { from: startOfMonthIn(now, tz), to: startOfMonthIn(now, tz, 1) };
    case 'last_month':
      return { from: startOfMonthIn(now, tz, -1), to: startOfMonthIn(now, tz) };
    case 'this_year':
      return { from: startOfYearIn(now, tz), to: startOfDayIn(now, tz, 1) };
  }
}

/** What a widget's query returns. Numbers from SQL only, already Number()-ed. */
export type WidgetData =
  | { kind: 'money'; total: number; count: number; undisclosed: number }
  | { kind: 'count'; total: number }
  | { kind: 'breakdown'; total: number; rows: { label: string; value: number }[] }
  | { kind: 'status'; active: number; rows: { label: string; value: number }[] };

export type WidgetContext = { db: DbOrTx; actor: Actor; now: Date; timeZone: string };

type WidgetDef<P extends z.ZodTypeAny> = {
  title: string;
  /** In plain words, for the card and the tile ("Sold value — the last 7 days"). */
  describe: (params: z.infer<P>) => string;
  params: P;
  /** Asked of the VIEWER before the query runs; refused → a "no access" tile. */
  permission: Action;
  /** Seconds between refreshes on an open dashboard: 30–60 (ADR 0027 §7). */
  refreshSeconds: number;
  query: (ctx: WidgetContext, params: z.infer<P>) => Promise<WidgetData>;
};

const rangeParams = (fallback: WidgetRange) => z.object({ range: z.enum(WIDGET_RANGES).default(fallback) }).strict();
const noParams = z.object({}).strict();

const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

function agencyOf(actor: Actor): string {
  return actor.agencyId ?? '00000000-0000-0000-0000-000000000000';
}

/** Sold in the window: the agency's own listings with status sold and a sold_date inside it. */
function soldInWindow(actor: Actor, from: Date, to: Date): SQL {
  return and(
    eq(listing.agencyId, agencyOf(actor)),
    eq(listing.status, 'sold'),
    gte(listing.soldDate, from),
    lt(listing.soldDate, to),
  )!;
}

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
    query: async ({ db, actor, now, timeZone }, p) => {
      const { from, to } = rangeWindow(p.range, now, timeZone);
      const [r] = await db
        .select({
          total: sql<string>`coalesce(sum(${listing.soldPrice}) filter (where ${listing.soldPrice} is not null), 0)`,
          count: sql<string>`count(*) filter (where ${listing.soldPrice} is not null)`,
          undisclosed: sql<string>`count(*) filter (where ${listing.soldPrice} is null)`,
        })
        .from(listing)
        .where(soldInWindow(actor, from, to));
      return { kind: 'money', total: num(r?.total), count: num(r?.count), undisclosed: num(r?.undisclosed) };
    },
  } satisfies WidgetDef<ReturnType<typeof rangeParams>>,

  sold_count: {
    title: 'Number of sales',
    describe: (p: { range: WidgetRange }) => `Number of sales — ${RANGE_LABELS[p.range]}`,
    params: rangeParams('30d'),
    permission: 'report:read_agency',
    refreshSeconds: 60,
    query: async ({ db, actor, now, timeZone }, p) => {
      const { from, to } = rangeWindow(p.range, now, timeZone);
      // By lead agent; a sale with no agent row counts under "No agent".
      const rows = await db
        .select({
          label: sql<string>`coalesce(${user.name}, ${user.email}, 'No agent')`,
          value: sql<string>`count(distinct ${listing.id})`,
          total: sql<string>`sum(count(distinct ${listing.id})) over()`,
        })
        .from(listing)
        .leftJoin(listingAgent, and(eq(listingAgent.listingId, listing.id), eq(listingAgent.displayOrder, 0)))
        .leftJoin(user, eq(user.id, listingAgent.userId))
        .where(soldInWindow(actor, from, to))
        .groupBy(sql`1`)
        .orderBy(sql`2 desc`, sql`1`);
      return { kind: 'breakdown', total: num(rows[0]?.total), rows: rows.map((r) => ({ label: r.label, value: num(r.value) })) };
    },
  } satisfies WidgetDef<ReturnType<typeof rangeParams>>,

  /** Enquiries received, by day — the inbox's own scope (an agent's are theirs; offers only for those who may). */
  new_leads: {
    title: 'New leads',
    describe: (p: { range: WidgetRange }) => `New leads — ${RANGE_LABELS[p.range]}`,
    params: rangeParams('7d'),
    permission: 'lead:read',
    refreshSeconds: 30,
    query: async ({ db, actor, now, timeZone }, p) => {
      const { from, to } = rangeWindow(p.range, now, timeZone);
      const day = sql<string>`to_char(${lead.createdAt} at time zone ${timeZone}, 'Dy DD Mon')`;
      const rows = await db
        .select({ label: day, value: sql<string>`count(*)`, total: sql<string>`sum(count(*)) over()`, first: sql<string>`min(${lead.createdAt})` })
        .from(lead)
        .where(and(...leadScopeFilters(db as never, actor), ne(lead.kind, 'offer'), gte(lead.createdAt, from), lt(lead.createdAt, to)))
        // By position: the day expression carries the zone as a parameter, so Postgres
        // would not see the SELECT and GROUP BY copies as the same expression.
        .groupBy(sql`1`)
        .orderBy(sql`4`);
      return { kind: 'breakdown', total: num(rows[0]?.total), rows: rows.map((r) => ({ label: r.label, value: num(r.value) })) };
    },
  } satisfies WidgetDef<ReturnType<typeof rangeParams>>,

  /** Appointments starting in the range that are still on, by type — the calendar's own scope. */
  upcoming_appointments: {
    title: 'Appointments',
    describe: (p: { range: WidgetRange }) => `Appointments — ${RANGE_LABELS[p.range]}`,
    params: rangeParams('this_week'),
    permission: 'appointment:read',
    refreshSeconds: 60,
    query: async ({ db, actor, now, timeZone }, p) => {
      const { from, to } = rangeWindow(p.range, now, timeZone);
      const rows = await db
        .select({ type: appointment.type, value: sql<string>`count(*)`, total: sql<string>`sum(count(*)) over()` })
        .from(appointment)
        .where(
          and(
            ...appointmentScopeFilters(actor),
            inArray(appointment.status, [...ACTIVE_STATUSES]),
            gte(appointment.startsAt, from),
            lt(appointment.startsAt, to),
          ),
        )
        .groupBy(appointment.type)
        .orderBy(sql`2 desc`);
      return {
        kind: 'breakdown',
        total: num(rows[0]?.total),
        rows: rows.map((r) => ({ label: APPOINTMENT_TYPE_LABELS[r.type as AppointmentType] ?? r.type, value: num(r.value) })),
      };
    },
  } satisfies WidgetDef<ReturnType<typeof rangeParams>>,

  /**
   * "Active listings" (client): live + under offer right now, with the split.
   * Agency-wide for those with `report:read_agency`; otherwise only listings
   * the viewer is named on.
   */
  listings_by_status: {
    title: 'Active listings',
    describe: () => 'Active listings — now (live + under offer)',
    params: noParams,
    permission: 'listing:read',
    refreshSeconds: 60,
    query: async ({ db, actor }) => {
      const mine = !can(actor, 'report:read_agency', { type: 'report', agencyId: agencyOf(actor) });
      const [r] = await db
        .select({
          live: sql<string>`count(*) filter (where ${listing.status} = 'live')`,
          underOffer: sql<string>`count(*) filter (where ${listing.status} = 'under_offer')`,
        })
        .from(listing)
        .where(
          and(
            eq(listing.agencyId, agencyOf(actor)),
            inArray(listing.status, ['live', 'under_offer']),
            ...(mine
              ? [sql`${listing.id} in (select ${listingAgent.listingId} from ${listingAgent} where ${listingAgent.userId} = ${actor.userId})`]
              : []),
          ),
        );
      const live = num(r?.live);
      const underOffer = num(r?.underOffer);
      return { kind: 'status', active: live + underOffer, rows: [{ label: 'Live', value: live }, { label: 'Under offer', value: underOffer }] };
    },
  } satisfies WidgetDef<typeof noParams>,

  /** Email replies received (client): inbound messages in the range on conversations the viewer may read. */
  email_replies: {
    title: 'Email replies',
    describe: (p: { range: WidgetRange }) => `Email replies — ${RANGE_LABELS[p.range]}`,
    params: rangeParams('7d'),
    permission: 'mail:read',
    refreshSeconds: 30,
    query: async ({ db, actor, now, timeZone }, p) => {
      const { from, to } = rangeWindow(p.range, now, timeZone);
      const [r] = await db
        .select({ total: sql<string>`count(*)` })
        .from(mailMessage)
        .innerJoin(mailThread, eq(mailThread.id, mailMessage.threadId))
        .leftJoin(lead, eq(lead.id, mailThread.leadId))
        .where(
          and(
            ...threadScopeFilters(db, actor),
            eq(mailMessage.direction, 'in'),
            gte(mailMessage.createdAt, from),
            lt(mailMessage.createdAt, to),
          ),
        );
      return { kind: 'count', total: num(r?.total) };
    },
  } satisfies WidgetDef<ReturnType<typeof rangeParams>>,
} as const;

export type WidgetId = keyof typeof WIDGETS;
export const WIDGET_IDS = Object.keys(WIDGETS) as WidgetId[];

/** A widget on a dashboard, as stored (`dashboard.widgets`) and as the assistant passes it. */
export const widgetRefSchema = z
  .object({ widget: z.enum(WIDGET_IDS as [WidgetId, ...WidgetId[]]), params: z.record(z.unknown()).default({}) })
  .strict();
export type WidgetRef = z.infer<typeof widgetRefSchema>;

export type WidgetTile =
  | { widget: WidgetId; title: string; description: string; refreshSeconds: number; state: 'ok'; data: WidgetData }
  | { widget: string; title: string; description: string; refreshSeconds: number; state: 'no_access' | 'unavailable' | 'error' };

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
export async function renderWidget(ctx: WidgetContext, ref: { widget: string; params?: unknown }): Promise<WidgetTile> {
  const def = (WIDGETS as Record<string, WidgetDef<z.ZodTypeAny>>)[ref.widget];
  if (!def) return { widget: ref.widget, title: 'Widget', description: 'This widget is no longer available', refreshSeconds: 60, state: 'unavailable' };
  const parsed = def.params.safeParse(ref.params ?? {});
  if (!parsed.success) return { widget: ref.widget, title: def.title, description: 'This widget is no longer available', refreshSeconds: def.refreshSeconds, state: 'unavailable' };
  const base = { widget: ref.widget as WidgetId, title: def.title, description: def.describe(parsed.data), refreshSeconds: def.refreshSeconds };
  if (!ctx.actor.agencyId || !can(ctx.actor, def.permission, { type: def.permission.split(':')[0]!, agencyId: ctx.actor.agencyId })) {
    return { ...base, state: 'no_access' };
  }
  try {
    return { ...base, state: 'ok', data: await def.query(ctx, parsed.data) };
  } catch (err) {
    console.error(`[widgets] ${ref.widget} failed`, err instanceof Error ? err.message : err);
    return { ...base, state: 'error' };
  }
}

/** Plain-words line for a widget reference, for cards ("Sold value — the last 7 days"). */
export function describeWidget(ref: { widget: string; params?: unknown }): string | null {
  const def = (WIDGETS as Record<string, WidgetDef<z.ZodTypeAny>>)[ref.widget];
  if (!def) return null;
  const parsed = def.params.safeParse(ref.params ?? {});
  return parsed.success ? def.describe(parsed.data) : null;
}
