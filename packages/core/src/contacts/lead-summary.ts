import { and, eq, sql, type SQL } from 'drizzle-orm';
import { lead, type Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import { leadScopeFilters } from '../leads/list-leads';
import type { ReadableContact } from './get-contact';

/**
 * The summary above a profile's Leads tab (ADR 0083 §2), under the inbox's own scope, so it never counts a lead the
 * table below would not show. Every figure is SQL (#4). First reply: the first email or text a PERSON sent after the
 * lead; an automatic one is not a reply.
 */

export type ContactLeadSummary = {
  total: number;
  new: number;
  contacted: number;
  qualified: number;
  closed: number;
  byKind: { enquiry: number; inspection: number; appraisal: number; offer: number };
  bySource: { source: string; count: number }[];
  firstAt: Date | null;
  latestAt: Date | null;
  /** Average over the leads that have had a reply. */
  averageFirstReplySeconds: number | null;
  /** Open leads nobody has replied to. */
  waiting: number;
  openDeals: number;
};

/** The first reply a person sent after this lead. Needs `"lead"` in scope. */
export const FIRST_REPLY_SQL: SQL = sql`(
  select min(x.at) from (
    select m.created_at as at from mail_message m join mail_thread t on t.id = m.thread_id
    where t.lead_id = "lead".id and m.direction = 'out' and m.sent_by is not null and m.status <> 'failed' and m.created_at >= "lead".created_at
    union all
    select s.created_at from sms_message s
    where s.contact_id = "lead".contact_id and s.direction = 'out' and s.sent_by is not null and s.created_at >= "lead".created_at
  ) x
)`;

export async function contactLeadSummary(db: Db, actor: Actor, c: ReadableContact): Promise<ContactLeadSummary> {
  const scope = and(eq(lead.contactId, c.id), ...leadScopeFilters(db, actor));
  const seesEveryDeal = can(actor, 'lead:read_all', { type: 'lead', agencyId: c.agencyId });
  const [r] = await db.execute<Record<string, string | null> & { sources: { source: string; count: number }[] | string | null }>(sql`
    with l as (
      select "lead".status::text as status, "lead".kind::text as kind, "lead".source, "lead".created_at, ${FIRST_REPLY_SQL} as first_reply
      from "lead" where ${scope}
    )
    select
      (select count(*) from l) as total,
      (select count(*) from l where status = 'new') as new,
      (select count(*) from l where status = 'contacted') as contacted,
      (select count(*) from l where status = 'qualified') as qualified,
      (select count(*) from l where status = 'closed') as closed,
      (select count(*) from l where kind = 'enquiry') as enquiry,
      (select count(*) from l where kind = 'inspection') as inspection,
      (select count(*) from l where kind = 'appraisal') as appraisal,
      (select count(*) from l where kind = 'offer') as offer,
      (select json_agg(json_build_object('source', s.source, 'count', s.n) order by s.n desc, s.source) from (select source, count(*)::int as n from l group by source) s) as sources,
      (select min(created_at) from l) as first_at,
      (select max(created_at) from l) as latest_at,
      (select avg(extract(epoch from first_reply - created_at)) from l where first_reply is not null) as average_reply,
      (select count(*) from l where status <> 'closed' and first_reply is null) as waiting,
      (select count(*) from deal d where d.agency_id = ${c.agencyId} and d.status = 'open'
        and (d.vendor_contact_id = ${c.id} or d.buyer_contact_id = ${c.id})
        ${seesEveryDeal ? sql`` : sql`and d.agent_id = ${actor.userId}`}) as open_deals`);
  const n = (v: unknown) => Number(v ?? 0);
  const when = (v: unknown) => (v ? new Date(v as string) : null);
  const sources = typeof r?.sources === 'string' ? (JSON.parse(r.sources) as { source: string; count: number }[]) : (r?.sources ?? []);
  return {
    total: n(r?.total),
    new: n(r?.new),
    contacted: n(r?.contacted),
    qualified: n(r?.qualified),
    closed: n(r?.closed),
    byKind: { enquiry: n(r?.enquiry), inspection: n(r?.inspection), appraisal: n(r?.appraisal), offer: n(r?.offer) },
    bySource: sources,
    firstAt: when(r?.first_at),
    latestAt: when(r?.latest_at),
    averageFirstReplySeconds: r?.average_reply === null || r?.average_reply === undefined ? null : Number(r.average_reply),
    waiting: n(r?.waiting),
    openDeals: n(r?.open_deals),
  };
}

/** "45 min", "2 h 10 min", "3 days". Pure. */
export function durationWords(seconds: number): string {
  const min = Math.round(seconds / 60);
  if (min < 1) return 'under a minute';
  if (min < 60) return `${min} min`;
  const hours = Math.floor(min / 60);
  if (hours < 48) return min % 60 ? `${hours} h ${min % 60} min` : `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}
