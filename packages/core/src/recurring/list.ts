import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { automation, type Db, user } from '@repo/db';
import { scheduleWords } from '../assistant/skill-tools';
import { skillKeyOfChatScope } from '../assistant/chat-scopes';
import { can, type Actor } from '../permissions';
import { listWorkflows } from '../workflows/manage';
import { AUTOMATION_SKILL, automationWords, type AutomationKind } from './kinds';

/**
 * Everything a person has set up, in one list (ADR 0089): workflows, one-off tasks, scheduled AI skills and repeating automations.
 * Each stays where it lives; they differ only in when they run. A fixed number of statements, none per row.
 */

export type AutomationRow = {
  key: string;
  source: 'recurring' | 'workflow' | 'task' | 'ai_skill';
  id: string;
  name: string;
  what: string;
  /** The skill it came from, in words. */
  skill: string;
  /** The platform skill's key, when it has one: the Skills panel groups by it. */
  skillKey: string | null;
  when: string;
  state: 'active' | 'off' | 'finished';
  note: string | null;
  owner: string | null;
  mine: boolean;
  lastAt: string | null;
  nextAt: string | null;
  canToggle: boolean;
  /** Only a repeating automation can be run by hand. */
  canRun: boolean;
  conversationId: string | null;
};

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as string | Date).toISOString());
const ROWS = 30;
const name = (u: { name: string | null; email: string }) => (u.name && u.name.trim() ? u.name : u.email);

export async function listEveryAutomation(db: Db, actor: Actor): Promise<AutomationRow[]> {
  if (!actor.agencyId || !can(actor, 'automation_status:read', { type: 'automation_status', agencyId: actor.agencyId })) return [];
  const agencyId = actor.agencyId;
  const mineOnly = !can(actor, 'automation_status:read_all', { type: 'automation_status', agencyId });
  const whose = (column: ReturnType<typeof sql>) => (mineOnly ? sql`and ${column} = ${actor.userId}::uuid` : sql``);

  const [recurring, workflows, tasks, skills] = await Promise.all([
    db
      .select({ a: automation, ownerName: user.name, ownerEmail: user.email })
      .from(automation)
      .innerJoin(user, eq(user.id, automation.userId))
      .where(and(eq(automation.agencyId, agencyId), ne(automation.status, 'archived'), ...(mineOnly ? [eq(automation.userId, actor.userId)] : [])))
      .orderBy(desc(automation.createdAt))
      .limit(ROWS),
    listWorkflows(db, actor),
    db.execute<{ id: string; title: string; status: string; user_id: string; owner: string; conversation_id: string | null; chat_scope: string | null; created_at: unknown; finished_at: unknown }>(sql`
      select t.id, t.title, t.status, t.user_id, coalesce(nullif(u.name, ''), u.email) as owner, t.conversation_id, c.chat_scope, t.created_at, t.finished_at
      from assistant_task t
      join "user" u on u.id = t.user_id
      left join assistant_conversation c on c.id = t.conversation_id
      where t.agency_id = ${agencyId}::uuid ${whose(sql`t.user_id`)}
        and t.status <> 'proposed' and t.created_at > now() - interval '30 days'
        and not exists (select 1 from proposed_action p where p.task_id = t.id and p.origin = 'workflow')
      order by t.created_at desc
      limit ${ROWS}`),
    db.execute<{ id: string; name: string; enabled: boolean; user_id: string; owner: string; cadence: string; send_at_minute: number; send_on_weekday: number | null; interval_minutes: number | null; timezone: string; next_at: unknown; last_at: unknown }>(sql`
      select a.id, s.name, a.enabled, a.user_id, coalesce(nullif(u.name, ''), u.email) as owner, a.cadence, a.send_at_minute, a.send_on_weekday, a.interval_minutes, a.timezone, a.next_run_at as next_at, a.last_run_at as last_at
      from agent_skill a
      join skill s on s.id = a.skill_id
      join "user" u on u.id = a.user_id
      where a.agency_id = ${agencyId}::uuid ${whose(sql`a.user_id`)} and a.archived_at is null and (a.enabled or a.last_run_at is not null)
      order by a.enabled desc, a.next_run_at asc nulls last
      limit ${ROWS}`),
  ]);

  const shownFlows = workflows.filter((w) => w.status !== 'archived');
  const ids = shownFlows.map((w) => w.id);
  // The chat a workflow was made in: read from its approved card (ADR 0047's way), so no column is needed.
  const chats = ids.length
    ? await db.execute<{ workflow_id: string; conversation_id: string }>(sql`
        select distinct on (p.result->>'workflowId') p.result->>'workflowId' as workflow_id, p.conversation_id
        from proposed_action p
        where p.agency_id = ${agencyId}::uuid and p.tool = 'create_workflow' and p.status = 'done' and p.conversation_id is not null
          and p.result->>'workflowId' in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
        order by p.result->>'workflowId', p.created_at asc`)
    : [];
  const chatOf = new Map(chats.map((c) => [c.workflow_id, c.conversation_id]));
  const who = (userId: string, owner: string) => ({ mine: userId === actor.userId, owner: userId === actor.userId ? null : owner });

  const rows: AutomationRow[] = [
    ...recurring.map(({ a, ownerName, ownerEmail }): AutomationRow => {
      const skill = AUTOMATION_SKILL[a.kind as AutomationKind];
      return {
        key: `recurring:${a.id}`,
        source: 'recurring',
        id: a.id,
        name: a.name,
        what: automationWords(a.kind, a.spec),
        skill: skill?.name ?? a.skillKey,
        skillKey: a.skillKey,
        when: scheduleWords(a),
        state: a.status === 'active' ? 'active' : 'off',
        note: a.pausedReason,
        ...who(a.userId, name({ name: ownerName, email: ownerEmail })),
        lastAt: iso(a.lastRunAt),
        nextAt: iso(a.nextRunAt),
        canToggle: can(actor, 'automation:manage', { type: 'automation', id: a.id, agencyId, ownerId: a.userId }),
        canRun: a.status === 'active' && can(actor, 'automation:manage', { type: 'automation', id: a.id, agencyId, ownerId: a.userId }),
        conversationId: a.conversationId,
      };
    }),
    ...shownFlows.map((w): AutomationRow => {
      const texts = w.stepTypes.includes('send_template_sms');
      const emails = w.stepTypes.some((t) => t === 'send_template_email' || t === 'draft_email');
      return {
        key: `workflow:${w.id}`,
        source: 'workflow',
        id: w.id,
        name: w.name,
        what: w.words.then.join(', then ') || 'Runs its steps',
        skill: texts && !emails ? 'Workflow texts' : emails && !texts ? 'Workflow emails' : 'Workflows',
        skillKey: texts && !emails ? 'workflow_texts' : emails && !texts ? 'workflow_emails' : null,
        when: w.words.when,
        state: w.status === 'active' ? 'active' : 'off',
        note: w.pausedReason ?? (w.runsToday ? `${w.runsToday} today` : null),
        mine: w.mine,
        owner: w.mine ? null : w.ownerName,
        lastAt: null,
        nextAt: null,
        canToggle: w.mayManage,
        canRun: false,
        conversationId: chatOf.get(w.id) ?? null,
      };
    }),
    ...tasks.map((t): AutomationRow => ({
      key: `task:${t.id}`,
      source: 'task',
      id: t.id,
      name: t.title,
      what: 'A task done once, in steps',
      skill: 'Daily work',
      skillKey: skillKeyOfChatScope(t.chat_scope),
      when: 'Once',
      state: t.status === 'active' ? 'active' : 'finished',
      note: t.status === 'active' ? null : t.status,
      ...who(t.user_id, t.owner),
      lastAt: iso(t.finished_at) ?? iso(t.created_at),
      nextAt: null,
      canToggle: false,
      canRun: false,
      conversationId: t.conversation_id,
    })),
    ...skills.map((s): AutomationRow => ({
      key: `ai_skill:${s.id}`,
      source: 'ai_skill',
      id: s.id,
      name: s.name,
      what: 'A scheduled AI skill',
      skill: 'AI skills',
      skillKey: null,
      when: scheduleWords({ cadence: s.cadence, sendAtMinute: s.send_at_minute, sendOnWeekday: s.send_on_weekday, intervalMinutes: s.interval_minutes, timezone: s.timezone }),
      state: s.enabled ? 'active' : 'off',
      note: null,
      ...who(s.user_id, s.owner),
      lastAt: iso(s.last_at),
      nextAt: iso(s.next_at),
      canToggle: can(actor, 'agent_skill:manage', { type: 'agent_skill', id: s.id, agencyId, ownerId: s.user_id }),
      canRun: false,
      conversationId: null,
    })),
  ];
  const order = { active: 0, off: 1, finished: 2 } as const;
  return rows.sort((a, b) => order[a.state] - order[b.state]);
}
