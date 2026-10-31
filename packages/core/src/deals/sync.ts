import { sql } from 'drizzle-orm';
import type { Db } from '@repo/db';
import { SUSPENDED_AGENCY_IDS } from '../platform/access';
import { AUTO_NOTES, DEAL_REMINDER_DAYS, DEAL_STAGES, STANDARD_CONDITIONS } from './stages';

/**
 * The deal sync (ADR 0063 §4), run by the every-minute tick: deals are opened and moved FROM what the
 * platform already knows — an appraisal, a listing's status, an offer — in SQL, never from a model. Every
 * statement is idempotent (one open deal per property per agency — ADR 0075 — a deal only ever moved forward, reminders deduped),
 * so an overlapping run, a retry or a manual curl changes nothing twice. Sales only (ADR 0063 §2).
 */

export type DealSyncReport = { linked: number; opened: number; appraisals: number; moved: number; withdrawn: number; conditions: number; reminders: number };

/** The stages as a Postgres array literal, from the one list (constants only — no input reaches it). */
const STAGES = sql.raw(`array[${DEAL_STAGES.map((s) => `'${s}'`).join(', ')}]`);
/** The history line for the stage in column `col` (constants only). */
const notesFor = (col: string) =>
  sql.raw(`(case ${col}::text ${DEAL_STAGES.map((s) => `when '${s}' then '${AUTO_NOTES[s].replace(/'/g, "''")}'`).join(' ')} end)`);
/** A listing's facts as a stage index (0-based), or null: draft/pending → listing, live → marketing (offers if one came), under offer → negotiation, sold → contract. */
const LISTING_STAGE = sql`(case
  when li.status in ('draft', 'pending') then 1
  when li.status = 'live' then (case when exists (select 1 from lead o where o.listing_id = li.id and o.kind = 'offer') then 3 else 2 end)
  when li.status = 'under_offer' then 4
  when li.status = 'sold' then 5
end)`;
/** How far back a sold listing or an appraisal still opens a deal — so switching this on does not fill the board with history. */
const BACKFILL_DAYS = 60;

/**
 * `agencyId` narrows every statement to one agency — for a manual run against a test agency on the shared
 * database. The tick passes nothing and syncs every agency, as before.
 */
export async function runDealSync(db: Db, opts: { agencyId?: string } = {}): Promise<DealSyncReport> {
  /** `and <col> = <agencyId>` when scoped, nothing otherwise. */
  const only = (col: string) => (opts.agencyId ? sql`and ${sql.raw(col)} = ${opts.agencyId}::uuid` : sql``);
  const report: DealSyncReport = { linked: 0, opened: 0, appraisals: 0, moved: 0, withdrawn: 0, conditions: 0, reminders: 0 };

  // 1. An appraisal's deal meets its listing: the property's newest sale listing that no deal has yet.
  const linked = await db.execute<{ id: string }>(sql`
    update deal d set listing_id = l.id, updated_at = now()
    from (
      -- ADR 0075: per agency — several agencies may list one address, each with its own deal.
      select distinct on (li.agency_id, li.property_id) li.id, li.property_id, li.agency_id
      from listing li
      where li.channel = 'sale' and li.status <> 'withdrawn' and not exists (select 1 from deal x where x.listing_id = li.id)
      order by li.agency_id, li.property_id, li.created_at desc
    ) l
    where d.status = 'open' and d.listing_id is null and d.property_id = l.property_id and d.agency_id = l.agency_id ${only('d.agency_id')}
    returning d.id`);
  report.linked = linked.length;

  // 2. A sale listing with no deal opens one at the stage its facts give (recent sales only, see BACKFILL_DAYS).
  const opened = await db.execute<{ id: string }>(sql`
    with cand as (
      select li.id as listing_id, li.agency_id, li.property_id, ${LISTING_STAGE} as t, li.sold_price, li.sold_date,
        (select la.user_id from listing_agent la where la.listing_id = li.id order by (la.role = 'lead') desc, la.display_order limit 1) as agent_id
      from listing li
      where li.channel = 'sale'
        and (li.status in ('draft', 'pending', 'live', 'under_offer') or (li.status = 'sold' and li.sold_date > now() - make_interval(days => ${BACKFILL_DAYS})))
        and li.agency_id not in ${SUSPENDED_AGENCY_IDS} ${only('li.agency_id')}
        and not exists (select 1 from deal d where d.listing_id = li.id)
    ), ins as (
      insert into deal (agency_id, property_id, listing_id, stage, agent_id, sale_price, contract_date)
      select agency_id, property_id, listing_id, (${STAGES})[t + 1]::deal_stage, agent_id,
        case when t = 5 then sold_price end, case when t = 5 then sold_date::date end
      from cand where t is not null
      on conflict (agency_id, property_id) where status = 'open' do nothing
      returning id, agency_id, stage
    )
    insert into deal_event (deal_id, agency_id, kind, to_stage, auto, note)
    select id, agency_id, 'opened', stage, true, ${notesFor('stage')} from ins
    returning deal_id as id`);
  report.opened = opened.length;

  // 3. An appraisal (a lead of that kind, or an appraisal appointment) on a property with no open deal opens one at Appraisal.
  const appraisals = await db.execute<{ id: string }>(sql`
    with cand as (
      select distinct on (x.agency_id, x.property_id) x.agency_id, x.property_id, x.agent_id, x.contact_id
      from (
        select l.agency_id, l.property_id, l.assigned_to as agent_id, l.contact_id, l.created_at as at
        from lead l where l.kind = 'appraisal' and l.property_id is not null and l.created_at > now() - make_interval(days => ${BACKFILL_DAYS})
        union all
        select a.agency_id, a.property_id, a.assigned_agent_id, a.contact_id, a.starts_at
        from appointment a where a.type = 'appraisal' and a.property_id is not null and a.status::text <> 'cancelled'
          and a.starts_at > now() - make_interval(days => ${BACKFILL_DAYS})
      ) x
      where x.agency_id not in ${SUSPENDED_AGENCY_IDS} ${only('x.agency_id')}
        and not exists (select 1 from deal d where d.agency_id = x.agency_id and d.property_id = x.property_id and (d.status = 'open' or d.updated_at > now() - make_interval(days => ${BACKFILL_DAYS})))
      order by x.agency_id, x.property_id, x.at desc
    ), ins as (
      insert into deal (agency_id, property_id, stage, agent_id, vendor_contact_id)
      select agency_id, property_id, 'appraisal', agent_id, contact_id from cand
      on conflict (agency_id, property_id) where status = 'open' do nothing
      returning id, agency_id
    )
    insert into deal_event (deal_id, agency_id, kind, to_stage, auto, note)
    select id, agency_id, 'opened', 'appraisal', true, ${AUTO_NOTES.appraisal} from ins
    returning deal_id as id`);
  report.appraisals = appraisals.length;

  // 4. Forward only: an open deal moves to the stage its listing's facts give, when that is further on.
  //    "Mark sold" also fills the sale price and contract date, if the agent has not.
  const moved = await db.execute<{ id: string }>(sql`
    with tgt as (
      select d.id, d.agency_id, d.stage as cur, ${LISTING_STAGE} as t, li.sold_price, li.sold_date
      from deal d join listing li on li.id = d.listing_id
      where d.status = 'open' ${only('d.agency_id')}
    ), mv as (
      update deal d set
        stage = (${STAGES})[tgt.t + 1]::deal_stage,
        sale_price = coalesce(d.sale_price, case when tgt.t = 5 then tgt.sold_price end),
        contract_date = coalesce(d.contract_date, case when tgt.t = 5 then tgt.sold_date::date end),
        updated_at = now()
      from tgt
      where tgt.id = d.id and tgt.t is not null and tgt.t > array_position(${STAGES}, d.stage::text) - 1
      returning d.id, d.agency_id, tgt.cur, d.stage
    )
    insert into deal_event (deal_id, agency_id, kind, from_stage, to_stage, auto, note)
    select id, agency_id, 'stage', cur, stage, true, ${notesFor('stage')} from mv
    returning deal_id as id`);
  report.moved = moved.length;

  // 5. A listing withdrawn before contract closes its deal as withdrawn (after contract, a person decides).
  const withdrawn = await db.execute<{ id: string }>(sql`
    with w as (
      update deal d set status = 'withdrawn', updated_at = now()
      from listing li
      where li.id = d.listing_id and d.status = 'open' and li.status = 'withdrawn'
        and array_position(${STAGES}, d.stage::text) - 1 < 5 ${only('d.agency_id')}
      returning d.id, d.agency_id, d.stage
    )
    insert into deal_event (deal_id, agency_id, kind, from_stage, auto, note)
    select id, agency_id, 'withdrawn', stage, true, 'The listing was withdrawn' from w
    returning deal_id as id`);
  report.withdrawn = withdrawn.length;

  // 6. A deal at Contract or later gets the four standard conditions once.
  const conditions = await db.execute<{ id: string }>(sql`
    insert into deal_condition (deal_id, agency_id, kind, label, sort)
    select d.id, d.agency_id, c.kind, c.label, c.sort
    from deal d
    cross join (values ${sql.join(STANDARD_CONDITIONS.map((c, i) => sql`(${c.kind}::text, ${c.label}::text, ${i}::int)`), sql`, `)}) as c(kind, label, sort)
    where d.status = 'open' and array_position(${STAGES}, d.stage::text) - 1 >= 5 ${only('d.agency_id')}
      and not exists (select 1 from deal_condition x where x.deal_id = d.id)
    returning id`);
  report.conditions = conditions.length;

  // 7. Two days before a condition's due date and the settlement date (the agency's clock), the deal's agent is told — once.
  const reminders = await db.execute<{ id: string }>(sql`
    with due as (
      select d.agent_id as user_id, d.agency_id, d.listing_id, 'deal-cond:' || c.id || ':' || c.due_on as key,
        c.label || ' is due ' || to_char(c.due_on, 'Dy DD Mon') || ' — ' || p.address as title
      from deal_condition c
      join deal d on d.id = c.deal_id
      join agency ag on ag.id = d.agency_id
      cross join lateral (select concat_ws(', ', nullif(trim(concat_ws(' ', pr.street_number, pr.street)), ''), pr.suburb) as address from property pr where pr.id = d.property_id) p
      where d.status = 'open' and d.agent_id is not null and c.done_at is null and c.due_on is not null
        and c.due_on = (now() at time zone ag.time_zone)::date + ${DEAL_REMINDER_DAYS}::int
      union all
      select d.agent_id, d.agency_id, d.listing_id, 'deal-settle:' || d.id || ':' || d.settlement_date,
        'Settlement ' || to_char(d.settlement_date, 'Dy DD Mon') || ' — ' || p.address
      from deal d
      join agency ag on ag.id = d.agency_id
      cross join lateral (select concat_ws(', ', nullif(trim(concat_ws(' ', pr.street_number, pr.street)), ''), pr.suburb) as address from property pr where pr.id = d.property_id) p
      where d.status = 'open' and d.agent_id is not null and d.settlement_date = (now() at time zone ag.time_zone)::date + ${DEAL_REMINDER_DAYS}::int
    )
    insert into notification (user_id, agency_id, kind, title, href, dedupe_key)
    select due.user_id, due.agency_id, 'deal', due.title,
      case when due.listing_id is null then null
        when m.role in ('owner', 'admin') then '/live-listings/' || due.listing_id || '/edit?tab=deal'
        else '/listings/' || due.listing_id || '/edit?tab=deal' end,
      due.key
    from due
    join membership m on m.user_id = due.user_id and m.agency_id = due.agency_id and m.status = 'active'
    where due.agency_id not in ${SUSPENDED_AGENCY_IDS} ${only('due.agency_id')}
    on conflict do nothing
    returning id`);
  report.reminders = reminders.length;

  return report;
}
