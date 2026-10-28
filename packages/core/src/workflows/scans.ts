import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '@repo/db';
import { briefFitsSql, LISTING_EXPRS, LISTING_PRICE_RANGE } from '../buyer-matching/match';
import { TRIGGER_LIMITS, type TriggerKind } from './catalog';

/**
 * The triggers that are found rather than told (ADR 0066), each one statement per agency and setting, run by
 * the minute tick only while an active workflow wants it. Every event carries a dedupe key, so a scan run
 * twice — or every minute — writes each event once (`workflow_event_dedupe_idx`). And none reaches back
 * before the oldest such workflow was made, nor more than a day or two: switching a workflow on never
 * floods it with history.
 *
 *   deal.stage_reached / deal.settled — from `deal_event` rows (the sync's moves, a person's, Settle): one
 *     event per side (vendor, buyer), so the workflow's choice picks its contact. A side with nobody on the
 *     deal still makes an event; its run is skipped and says why.
 *   buyer.matched — a listing gone live in the last day, once for each buyer whose brief it fits: the same
 *     `briefFitsSql` as the listing's Matching buyers tab (ADR 0060).
 *   appointment.upcoming — a scheduled client appointment starting within N hours, if we are no more than
 *     two hours late for it (one booked at the last minute gets no "see you tomorrow"). Keyed on its start,
 *     so a moved appointment counts from its new time and a cancelled one is never picked.
 *   appraisal.not_listed — an appraisal held N days ago (a two-day window) with no listing of ours created
 *     at that address since.
 *   sale.anniversary — N years to the day (the agency's clock) after we sold an address: its owners linked
 *     after the sale, and the deal's buyer. Never the vendor.
 */

export const SCANNED_TRIGGERS = ['deal.stage_reached', 'deal.settled', 'buyer.matched', 'appointment.upcoming', 'appraisal.not_listed', 'sale.anniversary'] as const satisfies readonly TriggerKind[];
export type ScanReport = Record<(typeof SCANNED_TRIGGERS)[number], number>;

type Wanted = { agency_id: string; kind: string; setting: number | null; since: string };

const LATE_HOURS = 2;
const inRange = (n: number, r: { min: number; max: number }) => Number.isInteger(n) && n >= r.min && n <= r.max;

/** The active workflows' scanned triggers: per agency, kind and setting (hours, days or years), the oldest one's creation. */
async function wanted(db: Db): Promise<Wanted[]> {
  const rows = await db.execute<Wanted>(sql`
    select agency_id, spec->'trigger'->>'kind' as kind,
      coalesce(spec->'trigger'->>'hours', spec->'trigger'->>'days', spec->'trigger'->>'years')::int as setting,
      min(created_at) as since
    from workflow
    where status = 'active' and spec->'trigger'->>'kind' in (${sql.join(SCANNED_TRIGGERS.map((k) => sql`${k}`), sql`, `)})
    group by 1, 2, 3`);
  return [...rows];
}

export async function runTriggerScans(db: Db, now: Date): Promise<ScanReport> {
  const report: ScanReport = { 'deal.stage_reached': 0, 'deal.settled': 0, 'buyer.matched': 0, 'appointment.upcoming': 0, 'appraisal.not_listed': 0, 'sale.anniversary': 0 };
  const list = await wanted(db);
  if (!list.length) return report;
  const at = sql`${now.toISOString()}::timestamptz`;
  const floor = (w: Wanted, back: SQL) => sql`greatest(${w.since}::timestamptz, ${at} - ${back})`;

  // Deals: both kinds from one pass over each agency's recent deal history.
  const dealAgencies = new Map<string, string>();
  for (const w of list) {
    if (w.kind !== 'deal.stage_reached' && w.kind !== 'deal.settled') continue;
    const was = dealAgencies.get(w.agency_id);
    if (!was || new Date(w.since) < new Date(was)) dealAgencies.set(w.agency_id, w.since);
  }
  for (const [agencyId, since] of dealAgencies) {
    const rows = await db.execute<{ kind: 'deal.stage_reached' | 'deal.settled' }>(sql`
      insert into workflow_event (agency_id, kind, contact_id, listing_id, actor_id, origin, data, dedupe_key)
      select de.agency_id, k.kind, case w.who when 'vendor' then d.vendor_contact_id else d.buyer_contact_id end, d.listing_id, de.actor_id,
        case when de.auto then 'system' else 'person' end,
        jsonb_strip_nulls(jsonb_build_object('to', de.to_stage::text, 'who', w.who, 'deal', d.id::text, 'agent', d.agent_id::text)),
        'deal:' || de.id || ':' || k.kind || ':' || w.who
      from deal_event de
      join deal d on d.id = de.deal_id
      cross join (values ('vendor'), ('buyer')) as w(who)
      cross join lateral (
        select 'deal.stage_reached'::text as kind where de.to_stage is not null and de.kind in ('opened', 'stage', 'settled')
        union all select 'deal.settled' where de.kind = 'settled'
      ) k
      where de.agency_id = ${agencyId} and de.created_at > greatest(${since}::timestamptz, ${at} - interval '1 day')
      on conflict do nothing
      returning kind`);
    for (const r of rows) report[r.kind] += 1;
  }

  for (const w of list) {
    const n = w.setting ?? 0;
    switch (w.kind) {
      case 'buyer.matched': {
        const rows = await db.execute(sql`
          insert into workflow_event (agency_id, kind, contact_id, listing_id, origin, data, dedupe_key)
          select distinct li.agency_id, 'buyer.matched', contact.id, li.id, 'system', '{}'::jsonb, 'match:' || li.id || ':' || contact.id
          from listing li
          join property p on p.id = li.property_id
          ${LISTING_PRICE_RANGE}
          join buyer_requirement br on br.agency_id = li.agency_id
          join contact on contact.id = br.contact_id and contact.agency_id = br.agency_id
          where li.agency_id = ${w.agency_id} and li.status = 'live' and li.published_at > ${floor(w, sql`interval '1 day'`)}
            and contact.archived_at is null and contact.merged_into_id is null
            and ${sql.join(briefFitsSql(LISTING_EXPRS), sql` and `)}
          on conflict do nothing
          returning id`);
        report['buyer.matched'] += rows.length;
        break;
      }
      case 'appointment.upcoming': {
        if (!inRange(n, TRIGGER_LIMITS.upcomingHours)) break;
        const rows = await db.execute(sql`
          insert into workflow_event (agency_id, kind, contact_id, appointment_id, origin, data, dedupe_key)
          select a.agency_id, 'appointment.upcoming', a.contact_id, a.id, 'system', jsonb_build_object('hours', ${n}::int, 'type', a.type::text),
            'upcoming:' || a.id || ':' || floor(extract(epoch from a.starts_at))::bigint || ':' || ${n}::int
          from appointment a
          where a.agency_id = ${w.agency_id} and a.kind = 'client' and a.contact_id is not null and a.status::text in ('scheduled', 'rescheduled')
            and a.starts_at <= ${at} + make_interval(hours => ${n}::int)
            and a.starts_at > greatest(${at}, ${at} + make_interval(hours => ${n}::int) - make_interval(hours => ${LATE_HOURS}::int))
          on conflict do nothing
          returning id`);
        report['appointment.upcoming'] += rows.length;
        break;
      }
      case 'appraisal.not_listed': {
        if (!inRange(n, TRIGGER_LIMITS.notListedDays)) break;
        const rows = await db.execute(sql`
          insert into workflow_event (agency_id, kind, contact_id, appointment_id, origin, data, dedupe_key)
          select a.agency_id, 'appraisal.not_listed', a.contact_id, a.id, 'system', jsonb_build_object('days', ${n}::int, 'type', 'appraisal'),
            'notlisted:' || a.id || ':' || ${n}::int
          from appointment a
          where a.agency_id = ${w.agency_id} and a.type = 'appraisal' and a.status::text <> 'cancelled' and a.contact_id is not null and a.property_id is not null
            and a.starts_at <= ${at} - make_interval(days => ${n}::int)
            and a.starts_at > ${at} - make_interval(days => ${n + 2}::int)
            and not exists (select 1 from listing li where li.property_id = a.property_id and li.agency_id = a.agency_id and li.created_at > a.starts_at)
          on conflict do nothing
          returning id`);
        report['appraisal.not_listed'] += rows.length;
        break;
      }
      case 'sale.anniversary': {
        if (!inRange(n, TRIGGER_LIMITS.anniversaryYears)) break;
        const rows = await db.execute(sql`
          insert into workflow_event (agency_id, kind, contact_id, listing_id, origin, data, dedupe_key)
          select distinct li.agency_id, 'sale.anniversary', c.id, li.id, 'system', jsonb_build_object('years', ${n}::int),
            'anniv:' || li.id || ':' || c.id || ':' || ${n}::int
          from listing li
          join agency ag on ag.id = li.agency_id
          join lateral (
            select cp.contact_id as id from contact_property cp
            where cp.property_id = li.property_id and cp.relation = 'owner' and cp.created_at > li.sold_date
            union
            select d.buyer_contact_id from deal d where d.listing_id = li.id and d.buyer_contact_id is not null
          ) r on true
          join contact c on c.id = r.id and c.agency_id = li.agency_id and c.archived_at is null and c.merged_into_id is null
          where li.agency_id = ${w.agency_id} and li.status = 'sold' and li.sold_date is not null
            and (li.sold_date at time zone ag.time_zone)::date = ((${at} at time zone ag.time_zone)::date - make_interval(years => ${n}::int))::date
            and not exists (select 1 from deal v where v.listing_id = li.id and v.vendor_contact_id = c.id)
          on conflict do nothing
          returning id`);
        report['sale.anniversary'] += rows.length;
        break;
      }
    }
  }
  return report;
}

