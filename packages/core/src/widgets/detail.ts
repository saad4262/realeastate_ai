import { and, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { appointment, lead } from '@repo/db';
import { leadScopeFilters } from '../leads/list-leads';
import { appointmentScopeFilters } from '../appointments/appointments';
import { ACTIVE_STATUSES, APPOINTMENT_TYPE_LABELS, type AppointmentType } from '../appointments/appointment-schema';
import { threadScopeFilters } from '../mail/threads';
import { ACTIVE_LISTING_STATUSES, leadAgentIdSql, listingScopeFilters } from '../listings/scope';
import { emailOwnerSql } from '../mail/owner';
import { startOfDayIn, startOfWeekIn } from '../time/local-input';
import { bucketFor, previousWindow, rangeWindow, type WidgetRange } from './ranges';
import type { WidgetContext } from './registry';

/**
 * The full-page view of a widget (ADR 0027): a comparison with the period
 * before, a row of figures, a trend and four breakdowns — so a dashboard of
 * one widget still reads as a report. ONE statement per widget, run AS THE
 * VIEWER through the same scope as its headline; every figure is SQL (#4).
 * The assistant never sees any of it: only the full dashboard page asks.
 */

export type WidgetFormat = 'money' | 'count' | 'days' | 'decimal';
export type DetailRow = { label: string; value: number };
export type DetailSeries = { title: string; format: WidgetFormat; rows: DetailRow[] };
export type WidgetDetail = {
  /** The headline figure over the comparison window (`label` says which). */
  compare: { label: string; previous: number } | null;
  /** `null` when there is nothing to work it out from (a median of no sales). */
  kpis: { label: string; value: number | null; format: WidgetFormat }[];
  trend: DetailSeries;
  breakdowns: (DetailSeries & { chart: 'bars' | 'donut' | 'columns' })[];
  /** The Agents widget only (ADR 0034): each person's emails in the range, newest first. */
  people?: AgentMessages[];
};

/** One email on a person's list (ADR 0034). Other people's words: drawn as text, never handed to a model. */
export type AgentMessage = {
  id: string;
  threadId: string;
  direction: 'in' | 'out';
  status: string;
  /** ISO instant. */
  at: string;
  subject: string;
  /** Who wrote it (in) or who it went to (out). */
  other: string;
  snippet: string;
  /** The conversation's kind: enquiry, inspection, appraisal, offer — or `agency` for the agency address. */
  kind: string;
};
/** `userId` null is the "No agent" row. `total` counts every message in the range; `messages` holds the newest. */
export type AgentMessages = { userId: string | null; total: number; messages: AgentMessage[] };

/** The row for figures nobody is assigned to, so the rows add up to the total (ADR 0034). */
export const NO_AGENT = 'No agent';

export const iso = (d: Date) => d.toISOString();
export const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const maybe = (v: unknown) => (v === null || v === undefined ? null : num(v));
export const rowsOf = (v: unknown, relabel: (l: string) => string = (l) => l): DetailRow[] =>
  (Array.isArray(v) ? v : []).map((r: { label?: unknown; value?: unknown }) => ({ label: relabel(String(r?.label ?? '')), value: num(r?.value) }));

/** A ring has at most six slices: the rest fold into "Other". */
function fold(rows: DetailRow[], keep = 5): DetailRow[] {
  if (rows.length <= keep + 1) return rows;
  const other = rows.slice(keep).reduce((s, r) => s + r.value, 0);
  return [...rows.slice(0, keep), { label: 'Other', value: other }];
}

/** postgres-js hands json back parsed; a string is parsed here so the shape never depends on the driver. */
export async function one(ctx: WidgetContext, query: SQL, column = 'detail'): Promise<Record<string, unknown>> {
  const res = (await ctx.db.execute(query)) as unknown;
  const first = (Array.isArray(res) ? res[0] : (res as { rows?: unknown[] })?.rows?.[0]) as Record<string, unknown> | undefined;
  const d = first?.[column];
  if (typeof d === 'string') return JSON.parse(d) as Record<string, unknown>;
  return (d && typeof d === 'object' ? d : {}) as Record<string, unknown>;
}

// ── SQL pieces. Every `sql.raw` below takes a constant written in this file, never input. ──

/** A value per step of the window, every step present (a quiet day is a 0, not a gap). */
export function trendSql(cte: string, col: string, value: string, w: { from: Date; to: Date }, tz: string): SQL {
  const { unit, format } = bucketFor(w.from, w.to);
  return sql`(select coalesce(json_agg(json_build_object('label', to_char(g.b, ${format}::text), 'value', coalesce(x.v, 0)) order by g.b), '[]'::json)
    from generate_series(
      date_trunc(${unit}::text, ${iso(w.from)}::timestamptz at time zone ${tz}::text),
      date_trunc(${unit}::text, (${iso(w.to)}::timestamptz - interval '1 microsecond') at time zone ${tz}::text),
      ${`1 ${unit}`}::interval) as g(b)
    left join (select date_trunc(${unit}::text, ${sql.raw(col)} at time zone ${tz}::text) as k, ${sql.raw(value)} as v
               from ${sql.raw(cte)} group by 1) x on x.k = g.b)`;
}

/** The largest groups first, at most `limit`. */
export function topSql(cte: string, label: string, value: string, where = 'true', limit = 20): SQL {
  return sql`(select coalesce(json_agg(json_build_object('label', t.l, 'value', t.v) order by t.v desc, t.l), '[]'::json)
    from (select ${sql.raw(label)} as l, ${sql.raw(value)} as v from ${sql.raw(cte)} where ${sql.raw(where)}
          group by 1 order by 2 desc, 1 limit ${limit}) t)`;
}

const PRICE_BANDS = `(1, '<$500k', 0::numeric, 500000::numeric), (2, '$500–750k', 500000, 750000),
  (3, '$750k–1M', 750000, 1000000), (4, '$1–1.5M', 1000000, 1500000), (5, '$1.5–2M', 1500000, 2000000), (6, '$2M+', 2000000, null)`;

/** How many rows fall in each price band, in band order (a row with no price is in none). */
function bandsSql(cte: string, col: string): SQL {
  return sql.raw(`(select json_agg(json_build_object('label', b.l, 'value',
      (select count(*) from ${cte} where ${col} >= b.lo and (b.hi is null or ${col} < b.hi))) order by b.o)
    from (values ${PRICE_BANDS}) as b(o, l, lo, hi))`);
}

/** Monday to Sunday on the agency's clock, every day present. */
export function weekdaySql(cte: string, col: string, where: string, tz: string): SQL {
  return sql`(select json_agg(json_build_object('label', w.l, 'value',
      (select count(*) from ${sql.raw(cte)} where ${sql.raw(where)} and extract(isodow from ${sql.raw(col)} at time zone ${tz}::text) = w.n)) order by w.n)
    from (values (1, 'Mon'), (2, 'Tue'), (3, 'Wed'), (4, 'Thu'), (5, 'Fri'), (6, 'Sat'), (7, 'Sun')) as w(n, l))`;
}

const medianSql = (cte: string, expr: string, where = 'true') =>
  sql.raw(`(select round(percentile_cont(0.5) within group (order by ${expr})::numeric) from ${cte} where ${where})`);

/** The lead agent of a listing, as the headline widgets count it (`leadAgentIdSql`, ADR 0036 P4). */
const LEAD_AGENT = sql`left join "user" u on u.id = ${leadAgentIdSql(sql`listing.id`)}`;

/** The active statuses as an SQL list, for the CTEs below that hold `status` as text. */
const ACTIVE_LIST = sql.join(ACTIVE_LISTING_STATUSES.map((s) => sql`${s}`), sql`, `);
/** The trend stops at the end of today: future days of "this month" are not zeros yet. */
export const untilToday = (to: Date, now: Date, tz: string) => new Date(Math.min(to.getTime(), startOfDayIn(now, tz, 1).getTime()));
/** Days of the window that have begun, for a per-day average. */
export const daysElapsed = (w: { from: Date; to: Date }, now: Date) =>
  Math.max(1, Math.ceil((Math.min(now.getTime(), w.to.getTime()) - w.from.getTime()) / 86_400_000));

// ── Sales (Sold value / Number of sales): the agency's own sold listings, as the headline. ──

export async function salesDetail(ctx: WidgetContext, range: WidgetRange, metric: 'value' | 'count'): Promise<WidgetDetail> {
  const { now, timeZone: tz } = ctx;
  const cur = rangeWindow(range, now, tz);
  const prev = previousWindow(range, now, tz);
  const v = metric === 'value' ? 'coalesce(sum(price), 0)' : 'count(*)';
  const d = await one(
    ctx,
    sql`with base as (
        select listing.sold_price as price, listing.sold_date as d, listing.published_at as pub, p.suburb,
               coalesce(nullif(coalesce(listing.property_type, p.property_type), ''), 'Not stated') as ptype,
               coalesce(u.name, u.email, 'No agent') as agent,
               listing.sold_date >= ${iso(cur.from)}::timestamptz as is_cur
        from listing
        join property p on p.id = listing.property_id
        ${LEAD_AGENT}
        where ${and(...listingScopeFilters(ctx.actor))} and listing.status = 'sold'
          and ((listing.sold_date >= ${iso(cur.from)}::timestamptz and listing.sold_date < ${iso(cur.to)}::timestamptz)
            or (listing.sold_date >= ${iso(prev.from)}::timestamptz and listing.sold_date < ${iso(prev.to)}::timestamptz))
      ),
      cur as (select * from base where is_cur)
      select json_build_object(
        'prev', (select ${sql.raw(v)} from base where not is_cur),
        'priced', (select count(price) from cur),
        'undisclosed', (select count(*) - count(price) from cur),
        'avg', (select round(avg(price)) from cur),
        'median', ${medianSql('cur', 'price', 'price is not null')},
        'dom', ${medianSql('cur', 'extract(epoch from (d - pub)) / 86400', 'pub is not null and pub <= d')},
        'agents_n', (select count(distinct agent) from cur),
        'trend', ${trendSql('cur', 'd', v, { from: cur.from, to: untilToday(cur.to, now, tz) }, tz)},
        'agents', ${topSql('cur', 'agent', v)},
        'suburbs', ${topSql('cur', 'suburb', v)},
        'types', ${topSql('cur', 'ptype', 'count(*)')},
        'bands', ${bandsSql('cur', 'price')}
      ) as detail`,
  );
  const money = metric === 'value';
  return {
    compare: { label: prev.label, previous: num(d.prev) },
    kpis: money
      ? [
          { label: 'Sales with a price', value: num(d.priced), format: 'count' },
          { label: 'Average sold price', value: maybe(d.avg), format: 'money' },
          { label: 'Median sold price', value: maybe(d.median), format: 'money' },
          { label: 'Median days on market', value: maybe(d.dom), format: 'days' },
          { label: 'No disclosed price (not $0)', value: num(d.undisclosed), format: 'count' },
        ]
      : [
          { label: 'With a price', value: num(d.priced), format: 'count' },
          { label: 'No disclosed price (not $0)', value: num(d.undisclosed), format: 'count' },
          { label: 'Median sold price', value: maybe(d.median), format: 'money' },
          { label: 'Median days on market', value: maybe(d.dom), format: 'days' },
          { label: 'Agents with a sale', value: num(d.agents_n), format: 'count' },
        ],
    trend: { title: money ? 'Sold value over time' : 'Sales over time', format: money ? 'money' : 'count', rows: rowsOf(d.trend) },
    breakdowns: [
      { title: money ? 'Sold value by agent' : 'Sales by agent', format: money ? 'money' : 'count', chart: 'bars', rows: rowsOf(d.agents) },
      { title: 'By property type', format: 'count', chart: 'donut', rows: fold(rowsOf(d.types)) },
      { title: money ? 'Sold value by suburb' : 'Sales by suburb', format: money ? 'money' : 'count', chart: 'bars', rows: rowsOf(d.suburbs) },
      { title: 'Sales by price band', format: 'count', chart: 'columns', rows: rowsOf(d.bands) },
    ],
  };
}

// ── New leads: the inbox's own scope, never offers (as the headline). ──

export const LEAD_KIND_LABELS: Record<string, string> = { enquiry: 'Enquiry', inspection: 'Inspection request', appraisal: 'Appraisal request' };
export const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export async function leadsDetail(ctx: WidgetContext, range: WidgetRange): Promise<WidgetDetail> {
  const { db, actor, now, timeZone: tz } = ctx;
  const cur = rangeWindow(range, now, tz);
  const prev = previousWindow(range, now, tz);
  const d = await one(
    ctx,
    sql`with base as (
        select ${lead.createdAt} as d, ${lead.status}::text as status, ${lead.kind}::text as kind,
               ${lead.assignedTo} is null as unassigned,
               coalesce(u.name, u.email, 'Unassigned') as agent,
               concat_ws(', ', nullif(concat_ws(' ', p.street_number, p.street), ''), p.suburb) as place,
               ${lead.createdAt} >= ${iso(cur.from)}::timestamptz as is_cur
        from ${lead}
        join property p on p.id = ${lead.propertyId}
        left join "user" u on u.id = ${lead.assignedTo}
        where ${and(...leadScopeFilters(db as never, actor), ne(lead.kind, 'offer'))}
          and ((${lead.createdAt} >= ${iso(cur.from)}::timestamptz and ${lead.createdAt} < ${iso(cur.to)}::timestamptz)
            or (${lead.createdAt} >= ${iso(prev.from)}::timestamptz and ${lead.createdAt} < ${iso(prev.to)}::timestamptz))
      ),
      cur as (select * from base where is_cur)
      select json_build_object(
        'prev', (select count(*) from base where not is_cur),
        'still_new', (select count(*) from cur where status = 'new'),
        'unassigned', (select count(*) from cur where unassigned),
        'per_day', (select round(count(*)::numeric / ${daysElapsed(cur, now)}::numeric, 1) from cur),
        'places_n', (select count(distinct place) from cur),
        'trend', ${trendSql('cur', 'd', 'count(*)', { from: cur.from, to: untilToday(cur.to, now, tz) }, tz)},
        'kinds', ${topSql('cur', 'kind', 'count(*)')},
        'statuses', ${topSql('cur', 'status', 'count(*)')},
        'agents', ${topSql('cur', 'agent', 'count(*)')},
        'places', ${topSql('cur', 'place', 'count(*)')}
      ) as detail`,
  );
  return {
    compare: { label: prev.label, previous: num(d.prev) },
    kpis: [
      { label: 'Still new', value: num(d.still_new), format: 'count' },
      { label: 'Not assigned', value: num(d.unassigned), format: 'count' },
      { label: 'Average per day', value: num(d.per_day), format: 'decimal' },
      { label: 'Properties enquired about', value: num(d.places_n), format: 'count' },
    ],
    trend: { title: 'Leads over time', format: 'count', rows: rowsOf(d.trend) },
    breakdowns: [
      { title: 'By type of enquiry', format: 'count', chart: 'donut', rows: fold(rowsOf(d.kinds, (k) => LEAD_KIND_LABELS[k] ?? capital(k))) },
      { title: 'By status', format: 'count', chart: 'bars', rows: rowsOf(d.statuses, capital) },
      { title: 'By assigned agent', format: 'count', chart: 'bars', rows: rowsOf(d.agents) },
      { title: 'Most enquired-about properties', format: 'count', chart: 'bars', rows: rowsOf(d.places) },
    ],
  };
}

// ── Appointments: the calendar's own scope; the trend covers the whole window, future days included. ──

const APPOINTMENT_STATUS_LABELS: Record<string, string> = { scheduled: 'Scheduled', rescheduled: 'Rescheduled', completed: 'Completed', cancelled: 'Cancelled' };

export async function appointmentsDetail(ctx: WidgetContext, range: WidgetRange): Promise<WidgetDetail> {
  const { actor, now, timeZone: tz } = ctx;
  const cur = rangeWindow(range, now, tz);
  const prev = previousWindow(range, now, tz);
  const d = await one(
    ctx,
    sql`with base as (
        select ${appointment.startsAt} as d, ${appointment.type}::text as type, ${appointment.status}::text as status,
               coalesce(u.name, u.email, 'No agent') as agent,
               ${inArray(appointment.status, [...ACTIVE_STATUSES])} as active,
               ${appointment.startsAt} >= ${iso(cur.from)}::timestamptz as is_cur
        from ${appointment}
        left join "user" u on u.id = ${appointment.assignedAgentId}
        where ${and(...appointmentScopeFilters(actor), eq(appointment.kind, 'client'))}
          and ((${appointment.startsAt} >= ${iso(cur.from)}::timestamptz and ${appointment.startsAt} < ${iso(cur.to)}::timestamptz)
            or (${appointment.startsAt} >= ${iso(prev.from)}::timestamptz and ${appointment.startsAt} < ${iso(prev.to)}::timestamptz))
      ),
      cur as (select * from base where is_cur),
      on_ as (select * from cur where active)
      select json_build_object(
        'prev', (select count(*) from base where not is_cur and active),
        'completed', (select count(*) from cur where status = 'completed'),
        'cancelled', (select count(*) from cur where status = 'cancelled'),
        'appraisals', (select count(*) from on_ where type = 'appraisal'),
        'agents_n', (select count(distinct agent) from on_),
        'trend', ${trendSql('on_', 'd', 'count(*)', cur, tz)},
        'types', ${topSql('on_', 'type', 'count(*)')},
        'agents', ${topSql('on_', 'agent', 'count(*)')},
        'statuses', ${topSql('cur', 'status', 'count(*)')},
        'weekdays', ${weekdaySql('on_', 'd', 'true', tz)}
      ) as detail`,
  );
  return {
    compare: { label: prev.label, previous: num(d.prev) },
    kpis: [
      { label: 'Appraisals booked', value: num(d.appraisals), format: 'count' },
      { label: 'Completed', value: num(d.completed), format: 'count' },
      { label: 'Cancelled', value: num(d.cancelled), format: 'count' },
      { label: 'Agents with bookings', value: num(d.agents_n), format: 'count' },
    ],
    trend: { title: 'Appointments over time', format: 'count', rows: rowsOf(d.trend) },
    breakdowns: [
      { title: 'By type', format: 'count', chart: 'donut', rows: fold(rowsOf(d.types, (t) => APPOINTMENT_TYPE_LABELS[t as AppointmentType] ?? capital(t))) },
      { title: 'By agent', format: 'count', chart: 'bars', rows: rowsOf(d.agents) },
      { title: 'By day of the week', format: 'count', chart: 'columns', rows: rowsOf(d.weekdays) },
      { title: 'All appointments by status', format: 'count', chart: 'bars', rows: rowsOf(d.statuses, (s) => APPOINTMENT_STATUS_LABELS[s] ?? capital(s)) },
    ],
  };
}

// ── Active listings: now, no range. `listingScopeFilters`: agency-wide with `listing:read_all`, otherwise the viewer's own, as the headline. ──

export async function listingsDetail(ctx: WidgetContext): Promise<WidgetDetail> {
  const { actor, now, timeZone: tz } = ctx;
  const weeks = { from: startOfWeekIn(now, tz, -11), to: startOfWeekIn(now, tz, 1) };
  const d = await one(
    ctx,
    sql`with base as (
        select listing.status::text as status, listing.channel::text as channel, listing.price_from as price, listing.published_at as pub, p.suburb,
               coalesce(nullif(coalesce(listing.property_type, p.property_type), ''), 'Not stated') as ptype,
               coalesce(u.name, u.email, 'No agent') as agent
        from listing
        join property p on p.id = listing.property_id
        ${LEAD_AGENT}
        where ${and(...listingScopeFilters(actor))}
      ),
      active as (select * from base where status in (${ACTIVE_LIST})),
      published as (select * from base where pub >= ${iso(weeks.from)}::timestamptz and pub < ${iso(weeks.to)}::timestamptz)
      select json_build_object(
        'pending', (select count(*) from base where status = 'pending'),
        'days_listed', (select round(percentile_cont(0.5) within group (order by extract(epoch from (${iso(now)}::timestamptz - pub)) / 86400)::numeric)
                        from active where pub is not null),
        'asking', ${medianSql('active', 'price', `price is not null and channel = 'sale'`)},
        'for_lease', (select count(*) from active where channel = 'rent'),
        'trend', ${trendSql('published', 'pub', 'count(*)', weeks, tz)},
        'suburbs', ${topSql('active', 'suburb', 'count(*)')},
        'types', ${topSql('active', 'ptype', 'count(*)')},
        'agents', ${topSql('active', 'agent', 'count(*)')},
        'bands', ${bandsSql(`(select * from active where channel = 'sale') s`, 'price')}
      ) as detail`,
  );
  return {
    compare: null,
    kpis: [
      { label: 'Waiting for approval', value: num(d.pending), format: 'count' },
      { label: 'Median days listed', value: maybe(d.days_listed), format: 'days' },
      { label: 'Median asking price (from)', value: maybe(d.asking), format: 'money' },
      { label: 'For lease', value: num(d.for_lease), format: 'count' },
    ],
    trend: { title: 'Listings published — last 12 weeks', format: 'count', rows: rowsOf(d.trend) },
    breakdowns: [
      { title: 'By property type', format: 'count', chart: 'donut', rows: fold(rowsOf(d.types)) },
      { title: 'By suburb', format: 'count', chart: 'bars', rows: rowsOf(d.suburbs) },
      { title: 'By agent', format: 'count', chart: 'bars', rows: rowsOf(d.agents) },
      { title: 'For sale by asking price', format: 'count', chart: 'columns', rows: rowsOf(d.bands) },
    ],
  };
}

// ── Email replies: conversations the viewer may read (the inbox's scope); each email on its owner (`emailOwnerSql`, ADR 0036 P3), as the Agents widget. ──

export async function repliesDetail(ctx: WidgetContext, range: WidgetRange): Promise<WidgetDetail> {
  const { db, actor, now, timeZone: tz } = ctx;
  const cur = rangeWindow(range, now, tz);
  const prev = previousWindow(range, now, tz);
  const d = await one(
    ctx,
    sql`with base as (
        select mail_message.created_at as d, mail_message.direction::text as dir, mail_message.thread_id as thread,
               coalesce(nullif(u.name, ''), u.email, ${NO_AGENT}) as agent,
               coalesce(lead.kind::text, 'agency') as kind,
               mail_message.created_at >= ${iso(cur.from)}::timestamptz as is_cur
        from mail_message
        join mail_thread on mail_thread.id = mail_message.thread_id
        left join lead on lead.id = mail_thread.lead_id
        left join contact on contact.id = mail_thread.contact_id
        left join "user" u on u.id = ${emailOwnerSql}
        where ${and(...threadScopeFilters(db, actor))}
          and (mail_message.direction = 'in' or mail_message.status = 'sent')
          and ((mail_message.created_at >= ${iso(cur.from)}::timestamptz and mail_message.created_at < ${iso(cur.to)}::timestamptz)
            or (mail_message.created_at >= ${iso(prev.from)}::timestamptz and mail_message.created_at < ${iso(prev.to)}::timestamptz))
      ),
      cur as (select * from base where is_cur),
      came_in as (select * from cur where dir = 'in')
      select json_build_object(
        'prev', (select count(*) from base where not is_cur and dir = 'in'),
        'threads', (select count(distinct thread) from came_in),
        'received', (select count(*) from came_in),
        'sent', (select count(*) from cur where dir = 'out'),
        'per_day', (select round(count(*)::numeric / ${daysElapsed(cur, now)}::numeric, 1) from came_in),
        'trend', ${trendSql('came_in', 'd', 'count(*)', { from: cur.from, to: untilToday(cur.to, now, tz) }, tz)},
        'agents', ${topSql('came_in', 'agent', 'count(*)')},
        'kinds', ${topSql('came_in', 'kind', 'count(*)')},
        'weekdays', ${weekdaySql('came_in', 'd', 'true', tz)}
      ) as detail`,
  );
  return {
    compare: { label: prev.label, previous: num(d.prev) },
    kpis: [
      { label: 'Conversations with a reply', value: num(d.threads), format: 'count' },
      { label: 'Emails sent', value: num(d.sent), format: 'count' },
      { label: 'Replies per day', value: num(d.per_day), format: 'decimal' },
    ],
    trend: { title: 'Replies over time', format: 'count', rows: rowsOf(d.trend) },
    breakdowns: [
      { title: 'Received and sent', format: 'count', chart: 'donut', rows: [{ label: 'Received', value: num(d.received) }, { label: 'Sent', value: num(d.sent) }] },
      { title: 'Replies by agent', format: 'count', chart: 'bars', rows: rowsOf(d.agents) },
      { title: 'By day of the week', format: 'count', chart: 'columns', rows: rowsOf(d.weekdays) },
      { title: 'Replies by kind of conversation', format: 'count', chart: 'bars', rows: rowsOf(d.kinds, (k) => (k === 'agency' ? 'Agency address' : (LEAD_KIND_LABELS[k] ?? capital(k)))) },
    ],
  };
}
