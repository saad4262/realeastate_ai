import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { agentSkill, skill, skillRun, type Db, type DbOrTx } from '@repo/db';
import { can, type Actor, type Resource } from '../permissions';
import { requireIntegrations } from '../integrations/accounts';
import { PROVIDERS, type IntegrationProvider } from '../integrations/providers';
import { nextRunFor } from '../schedules/next-run';
import { isValidTimeZone } from '../time/local-input';
import {
  librarySkillSchema,
  MANUAL_ONLY_HANDLERS,
  parseSkillMarkdown,
  scheduleFromInput,
  skillBodySchema,
  skillScheduleSchema,
  type LibrarySkillInput,
  type SkillHandler,
  type SkillModelTier,
  type SkillRunStatus,
  type SkillScheduleInput,
} from './skill-schema';

/**
 * Skills, the library and an agent's own copies (docs/adr/0021). Every write
 * asks can(); an agent's copy is theirs alone, and switching one on asks
 * `requireIntegrations` for everything the skill and the copy require.
 */

export class SkillError extends Error {
  readonly code: 'forbidden' | 'not_found' | 'invalid' | 'missing_integrations' | 'conflict';
  readonly missing?: IntegrationProvider[];
  constructor(code: SkillError['code'], message: string, missing?: IntegrationProvider[]) {
    super(message);
    this.name = 'SkillError';
    this.code = code;
    if (missing) this.missing = missing;
  }
}

const NOT_FOUND = () => new SkillError('not_found', 'That skill was not found');
const UUID = /^[0-9a-f-]{36}$/i;

const copyResource = (c: { id: string; agencyId: string; userId: string }): Resource => ({
  type: 'agent_skill',
  id: c.id,
  agencyId: c.agencyId,
  ownerId: c.userId,
});

export type LibrarySkill = {
  id: string;
  scope: 'platform' | 'agency';
  name: string;
  description: string;
  handler: SkillHandler;
  requires: IntegrationProvider[];
  modelTier: SkillModelTier;
  bodyMd: string;
  /** The actor's copy, if they have added it. */
  myCopyId: string | null;
};

export type SkillLibrary = { skills: LibrarySkill[]; mayCurate: boolean; mayAdd: boolean };

/** The platform library and the actor's agency's own skills, one statement. */
export async function listSkillLibrary(db: Db, actor: Actor): Promise<SkillLibrary> {
  if (!actor.agencyId || !can(actor, 'skill:read', { type: 'skill' })) {
    throw new SkillError('forbidden', 'You do not have permission to view skills');
  }
  const rows = await db
    .select({
      id: skill.id,
      agencyId: skill.agencyId,
      name: skill.name,
      description: skill.description,
      handler: skill.handler,
      requires: skill.requires,
      modelTier: skill.modelTier,
      bodyMd: skill.bodyMd,
      // `skill.id`, written out: with no join Drizzle renders `${skill.id}` as a
      // bare "id", which inside this subquery is a.id.
      myCopyId: sql<string | null>`(
        select a.id from agent_skill a
        where a.skill_id = skill.id and a.user_id = ${actor.userId} and a.archived_at is null
        limit 1
      )`,
    })
    .from(skill)
    .where(and(isNull(skill.archivedAt), or(isNull(skill.agencyId), eq(skill.agencyId, actor.agencyId))))
    .orderBy(sql`${skill.agencyId} nulls first`, skill.name);
  return {
    skills: rows.map((r) => ({
      id: r.id,
      scope: r.agencyId ? 'agency' : 'platform',
      name: r.name,
      description: r.description,
      handler: r.handler as SkillHandler,
      requires: (r.requires ?? []) as IntegrationProvider[],
      modelTier: r.modelTier as SkillModelTier,
      bodyMd: r.bodyMd,
      myCopyId: r.myCopyId,
    })),
    mayCurate: can(actor, 'skill:curate', { type: 'skill', agencyId: actor.agencyId }),
    mayAdd: can(actor, 'agent_skill:manage', { type: 'agent_skill', agencyId: actor.agencyId, ownerId: actor.userId }),
  };
}

export type MySkill = {
  id: string;
  skillId: string;
  name: string;
  description: string;
  handler: SkillHandler;
  bodyMd: string;
  enabled: boolean;
  emailMe: boolean;
  cadence: 'daily' | 'weekly' | 'interval';
  sendAtMinute: number;
  sendOnWeekday: number | null;
  intervalMinutes: number | null;
  timezone: string;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  consecutiveFailures: number;
  /** The library's requirements plus the copy's own front-matter. */
  requires: IntegrationProvider[];
  lastRun: { id: string; status: SkillRunStatus; at: Date } | null;
};

const MY_COLUMNS = {
  id: agentSkill.id,
  agencyId: agentSkill.agencyId,
  userId: agentSkill.userId,
  skillId: agentSkill.skillId,
  name: skill.name,
  description: skill.description,
  handler: skill.handler,
  libraryRequires: skill.requires,
  bodyMd: agentSkill.bodyMd,
  enabled: agentSkill.enabled,
  emailMe: agentSkill.emailMe,
  cadence: agentSkill.cadence,
  sendAtMinute: agentSkill.sendAtMinute,
  sendOnWeekday: agentSkill.sendOnWeekday,
  intervalMinutes: agentSkill.intervalMinutes,
  timezone: agentSkill.timezone,
  nextRunAt: agentSkill.nextRunAt,
  lastRunAt: agentSkill.lastRunAt,
  consecutiveFailures: agentSkill.consecutiveFailures,
  lastRunId: sql<string | null>`(select r.id from skill_run r where r.agent_skill_id = ${agentSkill.id} order by r.started_at desc limit 1)`,
  lastRunStatus: sql<string | null>`(select r.status::text from skill_run r where r.agent_skill_id = ${agentSkill.id} order by r.started_at desc limit 1)`,
  lastRunAtStarted: sql<Date | null>`(select r.started_at from skill_run r where r.agent_skill_id = ${agentSkill.id} order by r.started_at desc limit 1)`,
};

type MyRow = { [K in keyof typeof MY_COLUMNS]: unknown } & { id: string; agencyId: string; userId: string };

export function requiresOf(libraryRequires: readonly string[] | null, bodyMd: string): IntegrationProvider[] {
  const all = new Set<string>([...(libraryRequires ?? []), ...parseSkillMarkdown(bodyMd).requires]);
  return [...all].filter((p): p is IntegrationProvider => p in PROVIDERS);
}

function toMySkill(r: MyRow): MySkill {
  return {
    id: r.id,
    skillId: r.skillId as string,
    name: r.name as string,
    description: r.description as string,
    handler: r.handler as SkillHandler,
    bodyMd: r.bodyMd as string,
    enabled: r.enabled as boolean,
    emailMe: r.emailMe as boolean,
    cadence: r.cadence as MySkill['cadence'],
    sendAtMinute: r.sendAtMinute as number,
    sendOnWeekday: (r.sendOnWeekday as number | null) ?? null,
    intervalMinutes: (r.intervalMinutes as number | null) ?? null,
    timezone: r.timezone as string,
    nextRunAt: r.nextRunAt ? new Date(r.nextRunAt as Date) : null,
    lastRunAt: r.lastRunAt ? new Date(r.lastRunAt as Date) : null,
    consecutiveFailures: r.consecutiveFailures as number,
    requires: requiresOf(r.libraryRequires as string[] | null, r.bodyMd as string),
    lastRun: r.lastRunId
      ? { id: r.lastRunId as string, status: r.lastRunStatus as SkillRunStatus, at: new Date(r.lastRunAtStarted as Date) }
      : null,
  };
}

/** The actor's own skills. One statement. Nobody else's — ever. */
export async function listMySkills(db: Db, actor: Actor): Promise<MySkill[]> {
  if (!actor.agencyId) throw new SkillError('forbidden', 'You do not have permission to view skills');
  if (!can(actor, 'agent_skill:read', { type: 'agent_skill', agencyId: actor.agencyId, ownerId: actor.userId })) {
    throw new SkillError('forbidden', 'You do not have permission to view skills');
  }
  const rows = await db
    .select(MY_COLUMNS)
    .from(agentSkill)
    .innerJoin(skill, eq(skill.id, agentSkill.skillId))
    .where(and(eq(agentSkill.userId, actor.userId), eq(agentSkill.agencyId, actor.agencyId), isNull(agentSkill.archivedAt)))
    .orderBy(skill.name);
  return rows.map((r) => toMySkill(r as MyRow));
}

/** One of the actor's own skills — not-found for anybody else's, so ids cannot be probed. */
export async function getMySkill(db: DbOrTx, actor: Actor, id: string): Promise<MySkill & { agencyId: string; userId: string }> {
  if (!actor.agencyId || !UUID.test(id)) throw NOT_FOUND();
  const [r] = await db
    .select(MY_COLUMNS)
    .from(agentSkill)
    .innerJoin(skill, eq(skill.id, agentSkill.skillId))
    .where(and(eq(agentSkill.id, id), eq(agentSkill.agencyId, actor.agencyId), isNull(agentSkill.archivedAt)))
    .limit(1);
  if (!r) throw NOT_FOUND();
  const row = r as MyRow;
  if (!can(actor, 'agent_skill:read', copyResource(row))) throw NOT_FOUND();
  return { ...toMySkill(row), agencyId: row.agencyId, userId: row.userId };
}

async function requireManage(db: DbOrTx, actor: Actor, id: string) {
  const s = await getMySkill(db, actor, id);
  if (!can(actor, 'agent_skill:manage', copyResource(s))) {
    throw new SkillError('forbidden', 'You can view this skill but not change it');
  }
  return s;
}

/** Add a library skill to the actor's list — off, with the library's defaults and the browser's zone. */
export async function addSkillToMine(db: Db, actor: Actor, skillId: string, timezone: string): Promise<{ id: string }> {
  if (!actor.agencyId || !UUID.test(skillId)) throw NOT_FOUND();
  if (!can(actor, 'agent_skill:manage', { type: 'agent_skill', agencyId: actor.agencyId, ownerId: actor.userId })) {
    throw new SkillError('forbidden', 'You cannot add skills');
  }
  const [s] = await db
    .select()
    .from(skill)
    .where(and(eq(skill.id, skillId), isNull(skill.archivedAt), or(isNull(skill.agencyId), eq(skill.agencyId, actor.agencyId))))
    .limit(1);
  if (!s || !can(actor, 'skill:read', { type: 'skill', ...(s.agencyId ? { agencyId: s.agencyId } : {}) })) throw NOT_FOUND();
  if (MANUAL_ONLY_HANDLERS.includes(s.handler as SkillHandler)) {
    throw new SkillError('conflict', 'This skill is used from its own page: Prepare, then Approve & Send');
  }
  const zone = isValidTimeZone(timezone) ? timezone : 'Australia/Sydney';
  const [row] = await db
    .insert(agentSkill)
    .values({
      agencyId: actor.agencyId,
      userId: actor.userId,
      skillId: s.id,
      bodyMd: s.bodyMd,
      cadence: s.defaultCadence,
      sendAtMinute: s.defaultSendAtMinute,
      sendOnWeekday: s.defaultSendOnWeekday,
      intervalMinutes: s.defaultIntervalMinutes,
      timezone: zone,
    })
    .onConflictDoNothing()
    .returning({ id: agentSkill.id });
  if (row) return { id: row.id };
  const [existing] = await db
    .select({ id: agentSkill.id })
    .from(agentSkill)
    .where(and(eq(agentSkill.userId, actor.userId), eq(agentSkill.skillId, s.id), isNull(agentSkill.archivedAt)))
    .limit(1);
  return { id: existing!.id };
}

function nextFor(s: { cadence: string; sendAtMinute: number; sendOnWeekday: number | null; intervalMinutes: number | null; timezone: string }, after: Date): Date {
  return nextRunFor({
    cadence: s.cadence as 'daily' | 'weekly' | 'interval',
    sendAtMinute: s.sendAtMinute,
    timezone: s.timezone,
    sendOnWeekday: s.sendOnWeekday ?? undefined,
    intervalMinutes: s.intervalMinutes ?? undefined,
    after,
  });
}

/** Refuses with the missing providers when a requirement is not connected for this actor. */
export async function assertSkillRequirements(db: Db, actor: Actor, requires: IntegrationProvider[]): Promise<void> {
  if (!requires.length) return;
  const check = await requireIntegrations(db, actor, requires);
  if (!check.ok) {
    throw new SkillError(
      'missing_integrations',
      `Connect ${check.missing.map((p) => PROVIDERS[p].label).join(' and ')} first`,
      check.missing,
    );
  }
}

/** Switch on or off. On: every requirement connected, and the next slot computed. */
export async function setSkillEnabled(db: Db, actor: Actor, id: string, enabled: boolean, now = new Date()): Promise<void> {
  const s = await requireManage(db, actor, id);
  if (enabled) {
    await assertSkillRequirements(db, actor, s.requires);
    if (parseSkillMarkdown(s.bodyMd).errors.length) throw new SkillError('invalid', 'Fix the skill text before switching it on');
  }
  await db
    .update(agentSkill)
    .set({
      enabled,
      nextRunAt: enabled ? nextFor(s, now) : null,
      ...(enabled ? { consecutiveFailures: 0 } : {}),
      updatedAt: sql`now()`,
    })
    .where(eq(agentSkill.id, s.id));
}

export async function updateMySkill(
  db: Db,
  actor: Actor,
  id: string,
  input: { bodyMd?: string; schedule?: SkillScheduleInput; emailMe?: boolean },
  now = new Date(),
): Promise<void> {
  const s = await requireManage(db, actor, id);
  const set: Partial<typeof agentSkill.$inferInsert> = {};
  if (input.bodyMd !== undefined) {
    const body = skillBodySchema.safeParse(input.bodyMd);
    if (!body.success) throw new SkillError('invalid', body.error.issues[0]?.message ?? 'Check the skill text');
    set.bodyMd = body.data;
    // An edit that adds a requirement may not leave a skill on that cannot run.
    if (s.enabled) {
      const [lib] = await db.select({ requires: skill.requires }).from(skill).where(eq(skill.id, s.skillId)).limit(1);
      await assertSkillRequirements(db, actor, requiresOf(lib?.requires ?? [], body.data));
    }
  }
  let sched = { cadence: s.cadence, sendAtMinute: s.sendAtMinute, sendOnWeekday: s.sendOnWeekday, intervalMinutes: s.intervalMinutes, timezone: s.timezone } as {
    cadence: string; sendAtMinute: number; sendOnWeekday: number | null; intervalMinutes: number | null; timezone: string;
  };
  if (input.schedule !== undefined) {
    const parsed = skillScheduleSchema.safeParse(input.schedule);
    if (!parsed.success) throw new SkillError('invalid', parsed.error.issues[0]?.message ?? 'Check the schedule');
    sched = { ...scheduleFromInput(parsed.data), timezone: parsed.data.timezone };
    Object.assign(set, sched);
  }
  if (input.emailMe !== undefined) set.emailMe = input.emailMe;
  if (s.enabled && input.schedule !== undefined) set.nextRunAt = nextFor(sched, now);
  await db.update(agentSkill).set({ ...set, updatedAt: sql`now()` }).where(eq(agentSkill.id, s.id));
}

/** Off the agent's list. Runs are kept; the copy is archived, not deleted. */
export async function removeMySkill(db: Db, actor: Actor, id: string): Promise<void> {
  const s = await requireManage(db, actor, id);
  await db
    .update(agentSkill)
    .set({ archivedAt: sql`now()`, enabled: false, nextRunAt: null, updatedAt: sql`now()` })
    .where(eq(agentSkill.id, s.id));
}

// ── Runs, for the history and result pages ─────────────────────────────────

export type SkillRunView = {
  id: string;
  trigger: 'schedule' | 'manual';
  status: SkillRunStatus;
  startedAt: Date;
  finishedAt: Date | null;
  summary: string | null;
  summarySource: 'model' | 'template' | 'none';
  result: unknown;
  error: string | null;
  itemsProcessed: number;
  model: string | null;
  emailedAt: Date | null;
  /** USD, from the ai_run rows this run wrote. */
  costUsd: number;
};

const RUN_COLUMNS = {
  id: skillRun.id,
  agentSkillId: skillRun.agentSkillId,
  trigger: skillRun.trigger,
  status: skillRun.status,
  startedAt: skillRun.startedAt,
  finishedAt: skillRun.finishedAt,
  summary: skillRun.summary,
  summarySource: skillRun.summarySource,
  result: skillRun.result,
  error: skillRun.error,
  itemsProcessed: skillRun.itemsProcessed,
  model: skillRun.model,
  emailedAt: skillRun.emailedAt,
  cost: sql<string>`(select coalesce(sum(cost_usd), 0) from ai_run where entity_id = ${skillRun.id})`,
};

function toRun(r: Record<string, unknown>): SkillRunView {
  return {
    id: r.id as string,
    trigger: r.trigger as 'schedule' | 'manual',
    status: r.status as SkillRunStatus,
    startedAt: new Date(r.startedAt as Date),
    finishedAt: r.finishedAt ? new Date(r.finishedAt as Date) : null,
    summary: (r.summary as string | null) ?? null,
    summarySource: r.summarySource as SkillRunView['summarySource'],
    result: r.result ?? null,
    error: (r.error as string | null) ?? null,
    itemsProcessed: r.itemsProcessed as number,
    model: (r.model as string | null) ?? null,
    emailedAt: r.emailedAt ? new Date(r.emailedAt as Date) : null,
    costUsd: Number(r.cost ?? 0),
  };
}

/** The last runs of one of the actor's own skills. One statement after the ownership check. */
export async function listSkillRuns(db: Db, actor: Actor, agentSkillId: string, limit = 20): Promise<SkillRunView[]> {
  const s = await getMySkill(db, actor, agentSkillId);
  const rows = await db
    .select(RUN_COLUMNS)
    .from(skillRun)
    .where(eq(skillRun.agentSkillId, s.id))
    .orderBy(desc(skillRun.startedAt))
    .limit(limit);
  return rows.map(toRun);
}

export async function getSkillRun(db: Db, actor: Actor, agentSkillId: string, runId: string): Promise<SkillRunView> {
  const s = await getMySkill(db, actor, agentSkillId);
  if (!UUID.test(runId)) throw new SkillError('not_found', 'That run was not found');
  const [r] = await db
    .select(RUN_COLUMNS)
    .from(skillRun)
    .where(and(eq(skillRun.id, runId), eq(skillRun.agentSkillId, s.id)))
    .limit(1);
  if (!r) throw new SkillError('not_found', 'That run was not found');
  return toRun(r);
}

// ── The agency's own library (admins) ──────────────────────────────────────

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'skill';
}

export async function createAgencySkill(db: Db, actor: Actor, input: LibrarySkillInput): Promise<{ id: string }> {
  if (!actor.agencyId || !can(actor, 'skill:curate', { type: 'skill', agencyId: actor.agencyId })) {
    throw new SkillError('forbidden', 'Only an owner or admin adds library skills');
  }
  const v = librarySkillSchema.safeParse(input);
  if (!v.success) throw new SkillError('invalid', v.error.issues[0]?.message ?? 'Check the fields');
  const parsed = parseSkillMarkdown(v.data.bodyMd);
  const base = slugify(v.data.name);
  const [row] = await db
    .insert(skill)
    .values({
      agencyId: actor.agencyId,
      slug: `${base}-${Math.random().toString(36).slice(2, 6)}`,
      name: v.data.name,
      description: v.data.description,
      handler: v.data.handler,
      bodyMd: v.data.bodyMd,
      requires: parsed.requires,
      modelTier: parsed.model ?? 'summary',
      ...(parsed.schedule
        ? {
            defaultCadence: parsed.schedule.cadence,
            defaultSendAtMinute: parsed.schedule.sendAtMinute,
            defaultSendOnWeekday: 'sendOnWeekday' in parsed.schedule ? parsed.schedule.sendOnWeekday : null,
            defaultIntervalMinutes: 'intervalMinutes' in parsed.schedule ? parsed.schedule.intervalMinutes : null,
          }
        : {}),
      createdBy: actor.userId,
    })
    .returning({ id: skill.id });
  return { id: row!.id };
}

/** Archive one of the agency's own skills. Agents keep their copies; nobody can add it any more. */
export async function archiveAgencySkill(db: Db, actor: Actor, skillId: string): Promise<void> {
  if (!actor.agencyId || !can(actor, 'skill:curate', { type: 'skill', agencyId: actor.agencyId })) {
    throw new SkillError('forbidden', 'Only an owner or admin curates the library');
  }
  const done = await db
    .update(skill)
    .set({ archivedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(skill.id, skillId), eq(skill.agencyId, actor.agencyId), isNull(skill.archivedAt)))
    .returning({ id: skill.id });
  if (!done.length) throw NOT_FOUND();
}

