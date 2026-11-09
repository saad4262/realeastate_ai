import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import { usageFor } from '../usage';
import { chatScopeOfSkill } from '../assistant/chat-scopes';
import { listSkillSwitches, skillIsUsable } from '../skill-switches/switches';
import type { AutomationItem, AutomationStatus, SkillsPanel } from './links';
import { listEveryAutomation } from '../recurring/list';
import { listAssistantConversations } from '../assistant/conversations';
import { OPEN_CHAT_SCOPES } from '../assistant/chat-scopes';

/**
 * What is running, for the console's top bar (ADR 0088). Every number is counted here from the rows the
 * sends and the runs already write. An agent sees their own; an owner or admin the agency's, each row
 * saying whose. Five statements and the usage line; none per row.
 */

const RUNNING_ROWS = 20;
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
      + (select count(*)::int from automation_run ar
        where ar.agency_id = ${view.agencyId}::uuid ${whose(sql`ar.user_id`)} and ar.status = 'running')
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

  const [batches, tasks, runs, recurring, usage] = await Promise.all([
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
    db.execute<{ id: string; conversation_id: string | null; status: string; user_id: string; owner: string; title: string; error: string | null; done: unknown; total: unknown; next_at: unknown; send_parts: unknown; people: unknown; sent: unknown; failed: unknown; list: string | null }>(sql`
      select t.id, t.conversation_id, t.status, t.user_id, ${person('u')} as owner, t.title, t.error, c.done, c.total, c.next_at, c.send_parts, c.people, c.list, sends.sent, sends.failed
      from assistant_task t
      join "user" u on u.id = t.user_id
      cross join lateral (
        select count(*) filter (where p.status = 'done')::int as done, count(*)::int as total,
          min(p.run_at) filter (where p.status = 'scheduled') as next_at,
          count(*) filter (where p.args->'part' is not null)::int as send_parts,
          coalesce(sum(jsonb_array_length(p.args->'contactIds')) filter (where p.args->'part' is not null), 0)::int as people,
          max(p.args->'part'->>'list') as list
        from proposed_action p where p.task_id = t.id and p.task_seq is not null
      ) c
      -- What has really gone, from the batches its parts made so far.
      cross join lateral (
        select count(*) filter (where r.status = 'sent')::int as sent, count(*) filter (where r.status = 'failed')::int as failed
        from proposed_action p
        join email_batch_recipient r on r.batch_id = (p.result->>'batchId')::uuid
        where p.task_id = t.id and p.task_seq is not null and p.result->>'batchId' is not null
      ) sends
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
    db.execute<{ id: string; automation_id: string; status: string; user_id: string; owner: string; name: string; conversation_id: string | null; next_at: unknown; total: unknown; sent: unknown; failed: unknown; detail: string | null }>(sql`
      select r.id, r.automation_id, r.status, r.user_id, ${person('u')} as owner, a.name, a.conversation_id, a.next_run_at as next_at,
        jsonb_array_length(r.contact_ids) as total, r.sent, r.failed, r.detail
      from automation_run r
      join automation a on a.id = r.automation_id
      join "user" u on u.id = r.user_id
      where r.agency_id = ${agencyId}::uuid ${whose(sql`r.user_id`)}
        and (r.status = 'running' or r.created_at > now() - interval '24 hours')
      order by r.created_at desc
      limit ${RUNNING_ROWS}`),
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
      parts: null,
      canStop: false,
      nextAt: null,
      error: null,
      ...whoIs(b.user_id, b.owner),
      targetId: b.id,
      conversationId: null,
    })),
    ...tasks.map((t): AutomationItem => {
      const isSend = n(t.send_parts) > 0;
      return {
      key: `task:${t.id}`,
      kind: isSend ? 'send_plan' : 'task',
      channel: isSend ? 'email' : null,
      state: t.status === 'active' ? 'running' : 'failed',
      title: t.title,
      subtitle: isSend ? t.list : null,
      done: isSend ? n(t.sent) : n(t.done),
      total: isSend ? n(t.people) : n(t.total),
      failed: isSend ? n(t.failed) : 0,
      parts: isSend ? { done: n(t.done), total: n(t.total) } : null,
      canStop: t.status === 'active' && can(actor, 'proposed_action:cancel', { type: 'proposed_action', agencyId, ownerId: t.user_id }),
      nextAt: iso(t.next_at),
      error: t.error,
      ...whoIs(t.user_id, t.owner),
      targetId: t.id,
      conversationId: t.conversation_id,
      };
    }),
    ...recurring.map((r): AutomationItem => {
      const state = r.status === 'running' ? 'running' : r.status === 'done' ? 'done' : 'failed';
      return {
        key: `automation_run:${r.id}`,
        kind: 'automation_run',
        channel: null,
        state,
        title: r.name,
        subtitle: null,
        done: n(r.sent),
        total: n(r.total),
        failed: n(r.failed),
        parts: null,
        canStop: r.status === 'running' && can(actor, 'automation:manage', { type: 'automation', agencyId, ownerId: r.user_id }),
        nextAt: iso(r.next_at),
        error: state === 'failed' ? r.detail : null,
        ...whoIs(r.user_id, r.owner),
        targetId: r.id,
        conversationId: r.conversation_id,
      };
    }),
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
      parts: null,
      canStop: false,
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
    finished: items.filter((i) => i.state === 'done'),
    usage,
  };
}

/** The top bar's Skills panel: the person's own switches, the ones really on. Null: this person may not see it. */
export async function skillsPanel(db: Db, actor: Actor): Promise<SkillsPanel | null> {
  if (!viewOf(actor)) return null;
  const { holder, skills } = await listSkillSwitches(db, actor);
  const resource = { type: 'skill_switch', agencyId: actor.agencyId as string, ...(holder === 'personal' ? { ownerId: actor.userId } : {}) };
  const [every, chats] = await Promise.all([listEveryAutomation(db, actor), listAssistantConversations(db, actor, new Date(), 30, { chatScopes: OPEN_CHAT_SCOPES })]);
  return {
    skills: skills
      .filter((s) => skillIsUsable(s, holder))
      .map((s) => {
        const chat = chatScopeOfSkill(s.key);
        return {
          key: s.key,
          name: s.name,
          icon: s.icon,
          chat,
          automations: every.filter((a) => a.skillKey === s.key).map((a) => ({ key: a.key, name: a.name, state: a.state, conversationId: a.conversationId })),
          chats: chat ? chats.filter((c) => c.chatScope === chat).slice(0, 3).map((c) => ({ id: c.id, title: c.title })) : [],
        };
      }),
    mayManage: can(actor, 'skill_switch:manage', resource),
  };
}
