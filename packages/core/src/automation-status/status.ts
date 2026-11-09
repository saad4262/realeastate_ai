import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import { usageFor } from '../usage';
import type { ActiveAutomation, AutomationItem, AutomationStatus } from './links';

/**
 * What is running, for the console's top bar (ADR 0088). Every number is counted here from the rows the
 * sends and the runs already write. An agent sees their own; an owner or admin the agency's, each row
 * saying whose. Five statements and the usage line; none per row.
 */

const RUNNING_ROWS = 20;
const ACTIVE_ROWS = 5;
/** A batch still "sending" past this was abandoned; a skill run past its limit died with its process. */
const BATCH_DAYS = 7;
const RUN_HOURS = 1;

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as string | Date).toISOString());
const n = (v: unknown): number => Number(v ?? 0);

/** Null: this person may not see it. Otherwise the condition on whose rows they see. */
function viewOf(actor: Actor): { agencyId: string; mineOnly: boolean } | null {
  if (!actor.agencyId || !can(actor, 'automation_status:read', { type: 'automation_status', agencyId: actor.agencyId })) return null;
  return { agencyId: actor.agencyId, mineOnly: !can(actor, 'automation_status:read_all', { type: 'automation_status', agencyId: actor.agencyId }) };
}

const NOT_A_WORKFLOW = (task: SQL) => sql`not exists (select 1 from proposed_action p where p.task_id = ${task} and p.origin = 'workflow')`;

/** The top bar's badge: one statement, asked once a minute. Null: this person may not see it. */
export async function runningAutomationCount(db: Db, actor: Actor): Promise<number | null> {
  const view = viewOf(actor);
  if (!view) return null;
  const whose = (column: SQL) => (view.mineOnly ? sql`and ${column} = ${actor.userId}::uuid` : sql``);
  const rows = await db.execute<{ total: unknown }>(sql`
    select
      (select count(*)::int from email_batch b
        where b.agency_id = ${view.agencyId}::uuid ${whose(sql`b.user_id`)}
          and b.status = 'approved_sending' and b.prepared_at > now() - make_interval(days => ${BATCH_DAYS}))
      + (select count(*)::int from assistant_task t
        where t.agency_id = ${view.agencyId}::uuid ${whose(sql`t.user_id`)}
          and t.status = 'active' and ${NOT_A_WORKFLOW(sql`t.id`)})
      + (select count(*)::int from skill_run r
        where r.agency_id = ${view.agencyId}::uuid ${whose(sql`r.user_id`)}
          and r.status = 'running' and r.started_at > now() - make_interval(hours => ${RUN_HOURS})) as total`);
  return n(rows[0]?.total);
}

/** Null: this person may not see it. */
export async function automationStatus(db: Db, actor: Actor, opts: { env?: NodeJS.ProcessEnv } = {}): Promise<AutomationStatus | null> {
  const view = viewOf(actor);
  if (!view) return null;
  const { agencyId, mineOnly } = view;
  const whose = (column: SQL) => (mineOnly ? sql`and ${column} = ${actor.userId}::uuid` : sql``);
  const person = (u: string) => sql.raw(`coalesce(nullif(${u}.name, ''), ${u}.email)`);

  const [batches, tasks, runs, workflows, skills, usage] = await Promise.all([
    db.execute<{ id: string; channel: string; status: string; user_id: string; owner: string; template: string | null; list: string | null; sent: unknown; total: unknown; failed: unknown }>(sql`
      select b.id, b.channel, b.status, b.user_id, ${person('u')} as owner,
        b.template_snapshot->>'name' as template, b.filter_snapshot->>'name' as list, c.sent, c.total, c.failed
      from email_batch b
      join "user" u on u.id = b.user_id
      cross join lateral (
        select count(*) filter (where r.status = 'sent')::int as sent,
          count(*) filter (where r.status in ('queued', 'sending', 'sent', 'failed'))::int as total,
          count(*) filter (where r.status = 'failed')::int as failed
        from email_batch_recipient r where r.batch_id = b.id
      ) c
      where b.agency_id = ${agencyId}::uuid ${whose(sql`b.user_id`)}
        and b.prepared_at > now() - make_interval(days => ${BATCH_DAYS})
        and (b.status = 'approved_sending' or (b.status = 'sent' and b.finished_at > now() - interval '24 hours' and c.failed > 0))
      order by b.prepared_at desc
      limit ${RUNNING_ROWS}`),
    db.execute<{ id: string; conversation_id: string | null; status: string; user_id: string; owner: string; title: string; error: string | null; done: unknown; total: unknown; next_at: unknown }>(sql`
      select t.id, t.conversation_id, t.status, t.user_id, ${person('u')} as owner, t.title, t.error, c.done, c.total, c.next_at
      from assistant_task t
      join "user" u on u.id = t.user_id
      cross join lateral (
        select count(*) filter (where p.status = 'done')::int as done, count(*)::int as total,
          min(p.run_at) filter (where p.status = 'scheduled') as next_at
        from proposed_action p where p.task_id = t.id and p.task_seq is not null
      ) c
      where t.agency_id = ${agencyId}::uuid ${whose(sql`t.user_id`)}
        and (t.status = 'active' or (t.status = 'failed' and t.finished_at > now() - interval '24 hours'))
        and ${NOT_A_WORKFLOW(sql`t.id`)}
      order by t.created_at desc
      limit ${RUNNING_ROWS}`),
    db.execute<{ id: string; agent_skill_id: string; status: string; user_id: string; owner: string; name: string }>(sql`
      select r.id, r.agent_skill_id, r.status, r.user_id, ${person('u')} as owner, s.name
      from skill_run r
      join "user" u on u.id = r.user_id
      join agent_skill a on a.id = r.agent_skill_id
      join skill s on s.id = a.skill_id
      where r.agency_id = ${agencyId}::uuid ${whose(sql`r.user_id`)}
        and r.created_at > now() - interval '24 hours'
        and ((r.status = 'running' and r.started_at > now() - make_interval(hours => ${RUN_HOURS})) or r.status = 'failed')
      order by r.created_at desc
      limit ${RUNNING_ROWS}`),
    db.execute<{ id: string; name: string; owner_id: string; owner: string; last_at: unknown; total: unknown }>(sql`
      select w.id, w.name, w.owner_id, ${person('u')} as owner, last_run.created_at as last_at, count(*) over ()::int as total
      from workflow w
      join "user" u on u.id = w.owner_id
      left join lateral (select r.created_at from workflow_run r where r.workflow_id = w.id order by r.created_at desc limit 1) last_run on true
      where w.agency_id = ${agencyId}::uuid ${whose(sql`w.owner_id`)} and w.status = 'active'
      order by w.updated_at desc
      limit ${ACTIVE_ROWS}`),
    db.execute<{ id: string; name: string; user_id: string; owner: string; next_at: unknown; total: unknown }>(sql`
      select a.id, s.name, a.user_id, ${person('u')} as owner, a.next_run_at as next_at, count(*) over ()::int as total
      from agent_skill a
      join "user" u on u.id = a.user_id
      join skill s on s.id = a.skill_id
      where a.agency_id = ${agencyId}::uuid ${whose(sql`a.user_id`)} and a.enabled and a.archived_at is null
      order by a.next_run_at asc nulls last
      limit ${ACTIVE_ROWS}`),
    usageFor(db, actor, opts),
  ]);

  const whoIs = (userId: string, owner: string) => ({ mine: userId === actor.userId, owner: userId === actor.userId ? null : owner });
  const items: AutomationItem[] = [
    ...batches.map((b): AutomationItem => ({
      key: `batch:${b.id}`,
      kind: 'batch',
      channel: b.channel === 'sms' ? 'sms' : 'email',
      state: b.status === 'approved_sending' ? 'running' : 'failed',
      title: b.template ?? 'Bulk send',
      subtitle: b.list,
      done: n(b.sent),
      total: n(b.total),
      failed: n(b.failed),
      nextAt: null,
      error: null,
      ...whoIs(b.user_id, b.owner),
      targetId: b.id,
      conversationId: null,
    })),
    ...tasks.map((t): AutomationItem => ({
      key: `task:${t.id}`,
      kind: 'task',
      channel: null,
      state: t.status === 'active' ? 'running' : 'failed',
      title: t.title,
      subtitle: null,
      done: n(t.done),
      total: n(t.total),
      failed: 0,
      nextAt: iso(t.next_at),
      error: t.error,
      ...whoIs(t.user_id, t.owner),
      targetId: t.id,
      conversationId: t.conversation_id,
    })),
    ...runs.map((r): AutomationItem => ({
      key: `run:${r.id}`,
      kind: 'skill_run',
      channel: null,
      state: r.status === 'running' ? 'running' : 'failed',
      title: r.name,
      subtitle: null,
      done: 0,
      total: 0,
      failed: 0,
      nextAt: null,
      error: null,
      ...whoIs(r.user_id, r.owner),
      targetId: r.agent_skill_id,
      conversationId: null,
    })),
  ];

  return {
    running: items.filter((i) => i.state === 'running'),
    failed: items.filter((i) => i.state === 'failed'),
    active: [
      ...workflows.map((w): ActiveAutomation => ({ key: `workflow:${w.id}`, kind: 'workflow', title: w.name, ...whoIs(w.owner_id, w.owner), targetId: w.id, nextAt: null, lastAt: iso(w.last_at) })),
      ...skills.map((s): ActiveAutomation => ({ key: `skill:${s.id}`, kind: 'skill', title: s.name, ...whoIs(s.user_id, s.owner), targetId: s.id, nextAt: iso(s.next_at), lastAt: null })),
    ],
    activeTotal: n(workflows[0]?.total) + n(skills[0]?.total),
    usage,
  };
}
