import { and, inArray, sql, type SQL } from 'drizzle-orm';
import { appointment, listing } from '@repo/db';
import type { Actor } from '../permissions';
import { leadScopeFilters } from '../leads/list-leads';
import { appointmentScopeFilters } from '../appointments/appointments';
import { ACTIVE_STATUSES } from '../appointments/appointment-schema';
import { threadScopeFilters } from '../mail/threads';
import { ACTIVE_LISTING_STATUSES, listingScopeFilters } from '../listings/scope';
import { contactScopeFilters } from '../contacts/visibility';
import { conversationOwnerSql, emailOwnerSql } from '../mail/owner';
import { previousWindow, rangeWindow, type WidgetRange } from './ranges';
import { capital, daysElapsed, iso, LEAD_KIND_LABELS, NO_AGENT, num, one, rowsOf, topSql, trendSql, untilToday, weekdaySql } from './detail';
import type { AgentMessage, AgentMessages, WidgetDetail } from './detail';
import type { WidgetContext } from './registry';

/**
 * The Agents widget (ADR 0034): every person in the agency with the email they
 * received and sent and the rest of their work, for owners and admins. Every
 * figure is SQL, read AS THE VIEWER through the inbox's, lead inbox's and
 * calendar's own scope; the email text on the full page is drawn as text and
 * never reaches a model.
 */

/** One person's row. `userId` null is the "No agent" row, so the rows add up to the totals. */
export type AgentActivityRow = {
  userId: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  /** Their role in the agency; null for someone who has left (or the "No agent" row). */
  role: string | null;
  /** False once they left the agency (their mail in the range still shows). */
  current: boolean;
  received: number;
  sent: number;
  failed: number;
  /** Conversations of theirs whose last word came in and has no emailed answer yet — now, not in the range. */
  awaitingReply: number;
  newLeads: number;
  appointments: number;
  /** Live + under offer listings they are named on — now. */
  activeListings: number;
  /** Contacts assigned to them — now. */
  contacts: number;
  lastEmailAt: string | null;
};

export { NO_AGENT } from './detail';

const agencyOf = (actor: Actor) => actor.agencyId ?? '00000000-0000-0000-0000-000000000000';

/**
 * The messages in a window that this viewer may read, each with whose it is
 * (`emailOwnerSql`, ADR 0036 P3): one we SENT belongs to its sender; one we
 * RECEIVED to the conversation's agent — the lead's assignee, else the
 * contact's (mail to the agency address). Queued sends are in flight and left
 * out. `lead`, `contact` and `mail_thread` keep their table names: the scope
 * filters and the owner expression name them.
 */
function messagesSql(ctx: WidgetContext, windows: { from: Date; to: Date }[], extra: SQL = sql``): SQL {
  const inWindow = windows.map((w) => sql`(mail_message.created_at >= ${iso(w.from)}::timestamptz and mail_message.created_at < ${iso(w.to)}::timestamptz)`);
  return sql`select mail_message.id, mail_message.thread_id, mail_message.direction::text as dir, mail_message.status::text as status,
           mail_message.created_at as at,
           ${emailOwnerSql} as agent_id
           ${extra}
    from mail_message
    join mail_thread on mail_thread.id = mail_message.thread_id
    left join lead on lead.id = mail_thread.lead_id
    left join contact on contact.id = mail_thread.contact_id
    where ${and(...threadScopeFilters(ctx.db, ctx.actor))}
      and (mail_message.direction = 'in' or mail_message.status in ('sent', 'failed'))
      and (${sql.join(inWindow, sql` or `)})`;
}

/** The headline: one row per person, ONE statement. */
export async function agentActivity(ctx: WidgetContext, range: WidgetRange) {
  const { db, actor, now, timeZone: tz } = ctx;
  const { from, to } = rangeWindow(range, now, tz);
  const agencyId = agencyOf(actor);
  const d = await one(
    ctx,
    sql`with msgs as (${messagesSql(ctx, [{ from, to }])}),
      members as (
        select m.user_id from membership m
        where m.agency_id = ${agencyId} and m.status = 'active' and m.removed_at is null
      ),
      new_leads as (
        select lead.assigned_to as agent_id, count(*) as n from lead
        where ${and(...leadScopeFilters(db as never, actor))} and lead.kind <> 'offer'
          and lead.created_at >= ${iso(from)}::timestamptz and lead.created_at < ${iso(to)}::timestamptz
        group by 1
      ),
      appts as (
        select appointment.assigned_agent_id as agent_id, count(*) as n from appointment
        where ${and(...appointmentScopeFilters(actor), inArray(appointment.status, [...ACTIVE_STATUSES]))}
          and appointment.starts_at >= ${iso(from)}::timestamptz and appointment.starts_at < ${iso(to)}::timestamptz
        group by 1
      ),
      listings_held as (
        select la.user_id as agent_id, count(distinct listing.id) as n
        from listing join listing_agent la on la.listing_id = listing.id
        where ${and(...listingScopeFilters(actor), inArray(listing.status, [...ACTIVE_LISTING_STATUSES]))}
        group by 1
      ),
      contacts_held as (
        select contact.assigned_to as agent_id, count(*) as n from contact
        where ${and(...contactScopeFilters(actor))} and contact.assigned_to is not null and contact.archived_at is null
        group by 1
      ),
      -- Waiting for an emailed answer: the last word in (a message, or the enquiry that opened it) is newer than our last sent one.
      last_words as (
        select mail_message.thread_id,
               max(mail_message.created_at) filter (where mail_message.direction = 'in') as last_in,
               max(mail_message.created_at) filter (where mail_message.direction = 'out' and mail_message.status = 'sent') as last_out
        from mail_message where mail_message.agency_id = ${agencyId}
        group by 1
      ),
      waiting as (
        select ${conversationOwnerSql} as agent_id, count(*) as n
        from mail_thread
        left join lead on lead.id = mail_thread.lead_id
        left join contact on contact.id = mail_thread.contact_id
        left join last_words w on w.thread_id = mail_thread.id
        where ${and(...threadScopeFilters(db, actor))}
          and (lead.id is null or lead.status <> 'closed')
          and greatest(w.last_in, lead.created_at) is not null
          and greatest(w.last_in, lead.created_at) > coalesce(w.last_out, '-infinity'::timestamptz)
        group by 1
      ),
      people as (
        select u.id as user_id, coalesce(nullif(u.name, ''), u.email) as name, u.email, u.phone, m.role::text as role, true as current
        from membership m join "user" u on u.id = m.user_id
        where m.agency_id = ${agencyId} and m.status = 'active' and m.removed_at is null
        union all
        select u.id, coalesce(nullif(u.name, ''), u.email), u.email, u.phone, null, false
        from "user" u
        where u.id in (select agent_id from msgs where agent_id is not null)
          and u.id not in (select user_id from members)
        union all
        select null, ${NO_AGENT}, null, null, null, true
        where exists (select 1 from msgs where agent_id is null) or exists (select 1 from new_leads where agent_id is null)
      ),
      rows_ as (
        select p.user_id, p.name, p.email, p.phone, p.role, p.current,
          (select count(*) from msgs where agent_id is not distinct from p.user_id and dir = 'in') as received,
          (select count(*) from msgs where agent_id is not distinct from p.user_id and dir = 'out' and status = 'sent') as sent,
          (select count(*) from msgs where agent_id is not distinct from p.user_id and dir = 'out' and status = 'failed') as failed,
          (select max(at) from msgs where agent_id is not distinct from p.user_id) as last_email_at,
          coalesce((select n from waiting where agent_id is not distinct from p.user_id), 0) as awaiting_reply,
          coalesce((select n from new_leads where agent_id is not distinct from p.user_id), 0) as new_leads,
          coalesce((select n from appts where agent_id is not distinct from p.user_id), 0) as appointments,
          coalesce((select n from listings_held where agent_id = p.user_id), 0) as active_listings,
          coalesce((select n from contacts_held where agent_id = p.user_id), 0) as contacts
        from people p
      )
      select json_build_object(
        'received', (select count(*) from msgs where dir = 'in'),
        'sent', (select count(*) from msgs where dir = 'out' and status = 'sent'),
        'failed', (select count(*) from msgs where dir = 'out' and status = 'failed'),
        'people', (select count(*) from members),
        'rows', coalesce((select json_agg(r order by r.user_id is null, r.current desc, r.received desc, r.sent desc, r.name) from rows_ r), '[]'::json)
      ) as data`,
    'data',
  );
  const rows: AgentActivityRow[] = (Array.isArray(d.rows) ? d.rows : []).map((r: Record<string, unknown>) => ({
    userId: typeof r.user_id === 'string' ? r.user_id : null,
    name: String(r.name ?? NO_AGENT),
    email: typeof r.email === 'string' ? r.email : null,
    phone: typeof r.phone === 'string' && r.phone ? r.phone : null,
    role: typeof r.role === 'string' ? r.role : null,
    current: r.current !== false,
    received: num(r.received),
    sent: num(r.sent),
    failed: num(r.failed),
    awaitingReply: num(r.awaiting_reply),
    newLeads: num(r.new_leads),
    appointments: num(r.appointments),
    activeListings: num(r.active_listings),
    contacts: num(r.contacts),
    lastEmailAt: typeof r.last_email_at === 'string' ? r.last_email_at : null,
  }));
  return { kind: 'agents' as const, received: num(d.received), sent: num(d.sent), failed: num(d.failed), people: num(d.people), rows };
}

/** At most this many of a person's emails on the page; the rest are counted ("and 12 more"). */
export const MESSAGES_PER_PERSON = 25;

/** The full page: the comparison, the trend, the breakdowns and each person's emails — ONE more statement. */
export async function agentsDetail(ctx: WidgetContext, range: WidgetRange): Promise<WidgetDetail> {
  const { now, timeZone: tz } = ctx;
  const cur = rangeWindow(range, now, tz);
  const prev = previousWindow(range, now, tz);
  // Text for the page only: the other party, the subject and a plain-text snippet.
  const extra = sql`, mail_message.subject,
           case when mail_message.direction = 'in' then coalesce(nullif(mail_message.from_name, ''), mail_message.from_email)
                else coalesce(nullif(mail_thread.contact_name, ''), array_to_string(mail_message.to_emails, ', ')) end as other,
           left(btrim(regexp_replace(mail_message.text, '[[:space:]]+', ' ', 'g')), 160) as snippet,
           coalesce(lead.kind::text, 'agency') as kind,
           mail_message.created_at >= ${iso(cur.from)}::timestamptz as is_cur`;
  const d = await one(
    ctx,
    sql`with msgs as (${messagesSql(ctx, [cur, prev], extra)}),
      cur as (
        select msgs.*, coalesce(nullif(u.name, ''), u.email, ${NO_AGENT}) as agent
        from msgs left join "user" u on u.id = msgs.agent_id
        where msgs.is_cur
      ),
      came_in as (select * from cur where dir = 'in'),
      went_out as (select * from cur where dir = 'out' and status = 'sent'),
      ranked as (
        select cur.*, row_number() over (partition by agent_id order by at desc, id) as rn, count(*) over (partition by agent_id) as total
        from cur
      )
      select json_build_object(
        'prev', (select count(*) from msgs where not is_cur and dir = 'in'),
        'received', (select count(*) from came_in),
        'sent', (select count(*) from went_out),
        'failed', (select count(*) from cur where dir = 'out' and status = 'failed'),
        'threads', (select count(distinct thread_id) from cur),
        'agents_n', (select count(distinct agent_id) from came_in where agent_id is not null),
        'per_day', (select round(count(*)::numeric / ${daysElapsed(cur, now)}::numeric, 1) from came_in),
        'trend', ${trendSql('came_in', 'at', 'count(*)', { from: cur.from, to: untilToday(cur.to, now, tz) }, tz)},
        'in_by_agent', ${topSql('came_in', 'agent', 'count(*)')},
        'out_by_agent', ${topSql('went_out', 'agent', 'count(*)')},
        'kinds', ${topSql('came_in', 'kind', 'count(*)')},
        'weekdays', ${weekdaySql('came_in', 'at', 'true', tz)},
        'people', coalesce((
          select json_agg(json_build_object('user_id', g.agent_id, 'total', g.total, 'messages', g.messages))
          from (
            select agent_id, max(total) as total,
                   json_agg(json_build_object('id', id, 'thread_id', thread_id, 'dir', dir, 'status', status, 'at', at,
                                              'subject', subject, 'other', other, 'snippet', snippet, 'kind', kind) order by at desc, id) as messages
            from ranked where rn <= ${MESSAGES_PER_PERSON}
            group by agent_id
          ) g), '[]'::json)
      ) as detail`,
  );
  return {
    compare: { label: prev.label, previous: num(d.prev) },
    kpis: [
      { label: 'Emails sent', value: num(d.sent), format: 'count' },
      { label: 'Failed to send', value: num(d.failed), format: 'count' },
      { label: 'Conversations', value: num(d.threads), format: 'count' },
      { label: 'People who received email', value: num(d.agents_n), format: 'count' },
      { label: 'Received per day', value: num(d.per_day), format: 'decimal' },
    ],
    trend: { title: 'Emails received over time', format: 'count', rows: rowsOf(d.trend) },
    breakdowns: [
      { title: 'Received and sent', format: 'count', chart: 'donut', rows: [{ label: 'Received', value: num(d.received) }, { label: 'Sent', value: num(d.sent) }] },
      { title: 'Received by person', format: 'count', chart: 'bars', rows: rowsOf(d.in_by_agent) },
      { title: 'Sent by person', format: 'count', chart: 'bars', rows: rowsOf(d.out_by_agent) },
      { title: 'Received by kind of conversation', format: 'count', chart: 'bars', rows: rowsOf(d.kinds, (k) => (k === 'agency' ? 'Agency address' : (LEAD_KIND_LABELS[k] ?? capital(k)))) },
      { title: 'Received by day of the week', format: 'count', chart: 'columns', rows: rowsOf(d.weekdays) },
    ],
    people: (Array.isArray(d.people) ? d.people : []).map(
      (p: Record<string, unknown>): AgentMessages => ({
        userId: typeof p.user_id === 'string' ? p.user_id : null,
        total: num(p.total),
        messages: (Array.isArray(p.messages) ? p.messages : []).map(
          (m: Record<string, unknown>): AgentMessage => ({
            id: String(m.id ?? ''),
            threadId: String(m.thread_id ?? ''),
            direction: m.dir === 'out' ? 'out' : 'in',
            status: String(m.status ?? ''),
            at: String(m.at ?? ''),
            subject: String(m.subject ?? ''),
            other: String(m.other ?? ''),
            snippet: String(m.snippet ?? ''),
            kind: String(m.kind ?? ''),
          }),
        ),
      }),
    ),
  };
}
