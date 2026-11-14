import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import {
  AI_CALLBACK_WORDS,
  CC_PAGE_SIZE,
  CC_RANGE_HOURS,
  MISSED_CALL_WORDS,
  OPPORTUNITY_WORDS,
  type CcLevel,
  type CcResult,
  type CcSource,
  type ControlCentreActivity,
  type ControlCentreQuery,
  type ControlCentreRow,
} from './types';

/**
 * The Control Centre's activity (ADR 0091, part A): what ran by itself, from the rows the five kinds of
 * automation already write. Two statements, none per row. Who sees what is the top-bar panel's rule
 * (client decision 1): your own, or the agency's for owners and admins.
 */

/** Null: this person may not see it. */
function viewOf(actor: Actor): { agencyId: string; mineOnly: boolean } | null {
  if (!actor.agencyId || !can(actor, 'automation_status:read', { type: 'automation_status', agencyId: actor.agencyId })) return null;
  return { agencyId: actor.agencyId, mineOnly: !can(actor, 'automation_status:read_all', { type: 'automation_status', agencyId: actor.agencyId }) };
}

const n = (v: unknown): number => Number(v ?? 0);

/** Tools whose step ends in a card a person must approve (ADR 0041, ADR 0078). */
const APPROVAL_TOOLS = sql`('draft_email', 'propose_ai_brief')`;

/**
 * Every source as the same columns: source, id, at, owner_id, what, sub, level, result, note, ai_status, ai,
 * sent, tasks. `note` is an error or a code the words below turn into text; nothing here is free model text.
 */
function feedSql(agencyId: string, mineOnly: boolean, me: string, hours: number): SQL {
  const since = sql`now() - make_interval(hours => ${hours})`;
  const mine = (column: SQL) => (mineOnly ? sql`and ${column} = ${me}::uuid` : sql``);
  return sql`
    select 'workflow' as source, r.id, r.created_at as at, w.owner_id, w.name as what, c.name as sub,
      case when s.approval > 0 then 'approve' else 'auto' end as level,
      case when r.status = 'skipped' then 'skip'
           when r.status = 'failed' or s.failed > 0 then 'bad'
           when s.waiting > 0 then 'wait'
           when s.pending > 0 then 'running'
           else 'ok' end as result,
      coalesce(r.error, s.error) as note, null::text as ai_status,
      (coalesce(r.decision->>'by', '') = 'ai' or s.approval > 0) as ai, s.sent, s.tasks
    from workflow_run r
    join workflow w on w.id = r.workflow_id
    left join contact c on c.id = r.contact_id
    cross join lateral (
      select count(*) filter (where p.status = 'failed')::int as failed,
        count(*) filter (where p.status in ('blocked', 'scheduled', 'running'))::int as pending,
        count(*) filter (where p.tool in ${APPROVAL_TOOLS})::int as approval,
        count(*) filter (where p.status = 'done' and p.tool in ('set_next_action', 'remind'))::int as tasks,
        count(*) filter (where p.status = 'done' and p.tool in ('send_template_email', 'send_template_sms'))::int as sent,
        max(p.error) filter (where p.status = 'failed') as error,
        -- The draft or brief a step made, still waiting for its person.
        count(*) filter (where exists (
          select 1 from proposed_action d
          where d.idempotency_key in ('wfdraft:' || p.id::text, 'brief:' || p.id::text) and d.status = 'proposed'))::int as waiting
      from proposed_action p where p.task_id = r.task_id
    ) s
    where r.agency_id = ${agencyId}::uuid and r.created_at > ${since} ${mine(sql`w.owner_id`)}

    union all
    select 'automation', r.id, r.created_at, r.user_id, a.name, null,
      'auto',
      case when r.status = 'running' then 'running'
           when r.status = 'failed' or r.failed > 0 then 'bad'
           when r.status in ('stopped', 'skipped') then 'skip'
           else 'ok' end,
      r.detail, null, false, r.sent, 0
    from automation_run r
    join automation a on a.id = r.automation_id
    where r.agency_id = ${agencyId}::uuid and r.created_at > ${since} ${mine(sql`r.user_id`)}

    union all
    select 'skill', r.id, r.created_at, r.user_id, sk.name, null,
      'auto',
      case r.status when 'running' then 'running' when 'failed' then 'bad' when 'skipped' then 'skip' else 'ok' end,
      r.error, null, r.model is not null, 0, 0
    from skill_run r
    join agent_skill ag on ag.id = r.agent_skill_id
    join skill sk on sk.id = ag.skill_id
    where r.agency_id = ${agencyId}::uuid and r.created_at > ${since} ${mine(sql`r.user_id`)}

    union all
    select 'phone', pc.id, pc.created_at, pn.user_id, 'Missed call', coalesce(c.name, pc.from_e164),
      'auto',
      case when pc.outcome = 'text_failed' or pc.ai_status = 'failed' then 'bad'
           when pc.ai_status in ('scheduled', 'calling') then 'running'
           when pc.outcome = 'texted' or pc.ai_status = 'done' then 'ok'
           else 'skip' end,
      pc.outcome, pc.ai_status, pc.ai_status is not null and pc.ai_status <> 'skipped',
      case when pc.outcome = 'texted' then 1 else 0 end, 0
    from phone_call pc
    join phone_number pn on pn.id = pc.phone_number_id
    left join contact c on c.id = pc.contact_id
    where pc.agency_id = ${agencyId}::uuid and pc.kind = 'missed' and pc.created_at > ${since} ${mine(sql`pn.user_id`)}

    union all
    select 'opportunity', o.id, o.created_at, o.user_id, o.kind, c.name,
      'auto', 'ok', null, null, false, 0, 0
    from opportunity o
    left join contact c on c.id = o.contact_id
    where o.agency_id = ${agencyId}::uuid and o.created_at > ${since} ${mine(sql`o.user_id`)}`;
}

type FeedRow = {
  source: CcSource; id: string; at: unknown; owner_id: string; owner: string; what: string; sub: string | null;
  level: CcLevel; result: CcResult; note: string | null; ai_status: string | null; ai: boolean; total: unknown;
};

function words(r: FeedRow): { what: string; note: string | null } {
  if (r.source === 'opportunity') return { what: OPPORTUNITY_WORDS[r.what] ?? r.what, note: null };
  if (r.source === 'phone') {
    const parts = [r.note ? MISSED_CALL_WORDS[r.note] ?? r.note : null, r.ai_status ? AI_CALLBACK_WORDS[r.ai_status] ?? r.ai_status : null];
    return { what: r.what, note: parts.filter(Boolean).join(' · ') || null };
  }
  return { what: r.what, note: r.note };
}

/** Null: this person may not see the Control Centre. */
export async function controlCentreActivity(db: Db, actor: Actor, q: ControlCentreQuery): Promise<ControlCentreActivity | null> {
  const view = viewOf(actor);
  if (!view) return null;
  const { agencyId, mineOnly } = view;
  const feed = feedSql(agencyId, mineOnly, actor.userId, CC_RANGE_HOURS[q.range]);
  // An agent's view is already only theirs; `who` narrows an owner's.
  const who = !mineOnly && q.who ? sql`and f.owner_id = ${q.who}::uuid` : sql``;
  const source = q.source === 'all' ? sql`` : sql`and f.source = ${q.source}`;
  const result =
    q.result === 'all' ? sql`` : q.result === 'bad' ? sql`and f.result in ('bad', 'skip')` : sql`and f.result = ${q.result}`;
  const person = sql.raw(`coalesce(nullif(u.name, ''), u.email)`);

  const [rows, totals] = await Promise.all([
    db.execute<FeedRow>(sql`
      with feed as (${feed})
      select f.*, ${person} as owner, count(*) over() as total
      from feed f join "user" u on u.id = f.owner_id
      where true ${who} ${source} ${result}
      order by f.at desc, f.source, f.id desc
      limit ${CC_PAGE_SIZE} offset ${(q.page - 1) * CC_PAGE_SIZE}`),
    db.execute<{ ran: unknown; tasks: unknown; sent: unknown; opportunities: unknown; failed: unknown; waiting: unknown; people: { id: string; name: string }[] | null }>(sql`
      with feed as (${feed})
      select
        count(*) filter (where f.result = 'ok' and f.source <> 'opportunity' ${who}) as ran,
        coalesce(sum(f.tasks) filter (where true ${who}), 0) as tasks,
        coalesce(sum(f.sent) filter (where true ${who}), 0) as sent,
        count(*) filter (where f.source = 'opportunity' ${who}) as opportunities,
        count(*) filter (where f.result in ('bad', 'skip') ${who}) as failed,
        (select count(*) from proposed_action p
          where p.agency_id = ${agencyId}::uuid and p.origin = 'workflow' and p.status = 'proposed' and p.expires_at > now()
            ${mineOnly ? sql`and p.user_id = ${actor.userId}::uuid` : q.who ? sql`and p.user_id = ${q.who}::uuid` : sql``}) as waiting,
        (select json_agg(json_build_object('id', u.id, 'name', ${person}) order by ${person})
          from "user" u where u.id in (select owner_id from feed)) as people
      from feed f`),
  ]);

  const t = totals[0];
  return {
    tiles: { ran: n(t?.ran), tasks: n(t?.tasks), sent: n(t?.sent), opportunities: n(t?.opportunities), waiting: n(t?.waiting), failed: n(t?.failed) },
    rows: rows.map((r): ControlCentreRow => {
      const mine = r.owner_id === actor.userId;
      return {
        key: `${r.source}:${r.id}`,
        source: r.source,
        id: r.id,
        at: new Date(r.at as string | Date).toISOString(),
        ...words(r),
        sub: r.sub,
        level: r.level,
        result: r.result,
        ai: Boolean(r.ai),
        owner: mine ? null : r.owner,
        mine,
      };
    }),
    total: n(rows[0]?.total),
    page: q.page,
    pageSize: CC_PAGE_SIZE,
    people: mineOnly ? null : (t?.people ?? []),
  };
}
