import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { scheduleRun, searchSchedule, type Db, type DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';
import { consumerSkillBlocks, consumerSkillOffMessage } from '../consumer-skills';
import { describeSavedQuery, savedSearchQuerySchema, type SavedSearchQuery } from '../listings/search-url';
import { nextRunFor } from '../schedules/next-run';
import { SAVED_QUERY_VERSION, ScheduleError } from '../schedules/manage-schedules';
import { readProposal, signProposal } from '../acting/signed';
import { areaQuery, MAX_TASKS, readSections, taskInputSchema, whenText, type TaskInput, type TaskSection } from './sections';
import type { TaskReport } from './report';

/**
 * Tasks' own reads and writes (ADR 0080, C8 decision 5): rows of `search_schedule` with `kind = 'task'`, beside the
 * buyer's saved searches but never mixed with them. `can()` is the schedule's — the owner only. Creating one needs
 * Tasks switched on (an "acts" skill, off until then); pausing, deleting and reading never do.
 */

export type TaskSummary = {
  id: string;
  name: string;
  area: string;
  sections: TaskSection[];
  when: string;
  cadence: string;
  status: 'active' | 'paused' | 'failing' | 'done';
  skipEmpty: boolean;
  nextRunAt: Date;
  lastRunAt: Date | null;
};

export type TaskRun = { id: string; scheduledFor: Date; status: string; summary: string | null; summarySource: string; emailStatus: string; report: TaskReport | null };

const resource = (ownerId: string, id?: string) => (id ? { type: 'schedule', id, ownerId } : { type: 'schedule', ownerId });
const asDate = (v: Date | string) => (v instanceof Date ? v : new Date(v));

function toSummary(row: typeof searchSchedule.$inferSelect): TaskSummary {
  const q = savedSearchQuerySchema.safeParse(row.query);
  return {
    id: row.id,
    name: row.name,
    area: q.success ? describeSavedQuery(q.data) : 'Your search',
    sections: readSections(row.sections),
    when: whenText(row),
    cadence: row.cadence,
    status: row.status,
    skipEmpty: row.skipEmpty,
    nextRunAt: asDate(row.nextRunAt),
    lastRunAt: row.lastRunAt ? asDate(row.lastRunAt) : null,
  };
}

export async function createTask(db: Db, actor: Actor, input: unknown, opts: { now?: Date } = {}): Promise<TaskSummary> {
  if (!can(actor, 'schedule:create', resource(actor.userId))) throw new ScheduleError('You need an account to set up a task', 'refused');
  const block = (await consumerSkillBlocks(db, actor)).get('tasks');
  if (block) throw new ScheduleError(consumerSkillOffMessage('tasks', block), 'refused');
  const parsed = taskInputSchema.safeParse(input);
  if (!parsed.success) throw new ScheduleError(parsed.error.issues[0]?.message ?? 'That task could not be saved', 'invalid');
  const t: TaskInput = parsed.data;
  const [existing] = await db.select({ n: count() }).from(searchSchedule).where(and(eq(searchSchedule.userId, actor.userId), eq(searchSchedule.kind, 'task'), sql`${searchSchedule.status} <> 'done'`));
  if ((existing?.n ?? 0) >= MAX_TASKS) throw new ScheduleError(`You can have ${MAX_TASKS} tasks. Delete one to add another.`, 'limit');
  const now = opts.now ?? new Date();
  const [row] = await db
    .insert(searchSchedule)
    .values({
      userId: actor.userId,
      kind: 'task',
      name: t.name,
      prompt: '',
      query: areaQuery(t.area),
      promptVersion: SAVED_QUERY_VERSION,
      sections: t.sections,
      skipEmpty: t.skipEmpty,
      cadence: t.cadence,
      sendAtMinute: t.sendAtMinute,
      sendOnWeekday: t.sendOnWeekday ?? null,
      timezone: t.timezone,
      nextRunAt: nextRunFor({ cadence: t.cadence, sendAtMinute: t.sendAtMinute, timezone: t.timezone, sendOnWeekday: t.sendOnWeekday, after: now }),
    })
    .returning();
  return toSummary(row!);
}

export async function listTasks(db: DbOrTx, actor: Actor): Promise<TaskSummary[]> {
  if (!can(actor, 'schedule:read', resource(actor.userId))) return [];
  const rows = await db.select().from(searchSchedule).where(and(eq(searchSchedule.userId, actor.userId), eq(searchSchedule.kind, 'task'))).orderBy(desc(searchSchedule.createdAt), desc(searchSchedule.id)).limit(50);
  return rows.map(toSummary);
}

async function ownTask(db: DbOrTx, actor: Actor, id: string, action: 'schedule:read' | 'schedule:manage') {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await db.select().from(searchSchedule).where(and(eq(searchSchedule.id, id), eq(searchSchedule.kind, 'task'))).limit(1);
  return row && can(actor, action, resource(row.userId, row.id)) ? row : null;
}

/** One task and its latest reports, newest first. Two reads. */
export async function getTask(db: DbOrTx, actor: Actor, id: string, opts: { runs?: number } = {}): Promise<{ task: TaskSummary; runs: TaskRun[] } | null> {
  const row = await ownTask(db, actor, id, 'schedule:read');
  if (!row) return null;
  const runs = await db
    .select({ id: scheduleRun.id, scheduledFor: scheduleRun.scheduledFor, status: scheduleRun.status, summary: scheduleRun.summary, summarySource: scheduleRun.summarySource, emailStatus: scheduleRun.emailStatus, report: scheduleRun.report })
    .from(scheduleRun)
    .where(eq(scheduleRun.scheduleId, row.id))
    .orderBy(desc(scheduleRun.scheduledFor), desc(scheduleRun.id))
    .limit(opts.runs ?? 10);
  return { task: toSummary(row), runs: runs.map((r) => ({ ...r, scheduledFor: asDate(r.scheduledFor), report: (r.report as TaskReport | null) ?? null })) };
}

/** Pause or resume. Resuming re-anchors to the next real slot (the alerts' reasoning); a done task cannot resume. */
export async function setTaskStatus(db: DbOrTx, actor: Actor, id: string, status: 'active' | 'paused', opts: { now?: Date } = {}): Promise<void> {
  const row = await ownTask(db, actor, id, 'schedule:manage');
  if (!row) throw new ScheduleError('No such task', 'not_found');
  if (row.status === 'done') throw new ScheduleError('That task has already run. Set up a new one.', 'invalid');
  const resuming = status === 'active' && row.status !== 'active';
  await db
    .update(searchSchedule)
    .set({
      status,
      consecutiveFailures: resuming ? 0 : row.consecutiveFailures,
      ...(resuming ? { nextRunAt: nextRunFor({ cadence: row.cadence, sendAtMinute: row.sendAtMinute, timezone: row.timezone, sendOnWeekday: row.sendOnWeekday ?? undefined, after: opts.now ?? new Date() }), unsubscribedAt: null } : {}),
      updatedAt: sql`now()`,
    })
    .where(eq(searchSchedule.id, row.id));
}

export async function setTaskSkipEmpty(db: DbOrTx, actor: Actor, id: string, skipEmpty: boolean): Promise<void> {
  const row = await ownTask(db, actor, id, 'schedule:manage');
  if (!row) throw new ScheduleError('No such task', 'not_found');
  await db.update(searchSchedule).set({ skipEmpty, updatedAt: sql`now()` }).where(eq(searchSchedule.id, row.id));
}

/** Delete a task and, by cascade, its reports. */
export async function deleteTask(db: DbOrTx, actor: Actor, id: string): Promise<void> {
  const row = await ownTask(db, actor, id, 'schedule:manage');
  if (!row) throw new ScheduleError('No such task', 'not_found');
  await db.delete(searchSchedule).where(eq(searchSchedule.id, row.id));
}

/** How many of a set of schedule ids are tasks — the unsubscribe page says "task" rather than "saved search". */
export async function countTasks(db: DbOrTx, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const [r] = await db.select({ n: count() }).from(searchSchedule).where(and(inArray(searchSchedule.id, ids), eq(searchSchedule.kind, 'task')));
  return Number(r?.n ?? 0);
}

// ── the guide's card (decision 12): a signed proposal, saved only on Accept ──

/** What the card shows: the server's words for what will be saved, never the model's. Pure. */
export function describeTaskInput(t: TaskInput): { name: string; when: string; area: string; sections: TaskSection[] } {
  return { name: t.name, when: whenText(t), area: describeSavedQuery(areaQuery(t.area) as SavedSearchQuery), sections: t.sections };
}

export function signTaskProposal(t: TaskInput, secret: string, opts: { now?: Date } = {}): string {
  return signProposal('task', t, secret, opts);
}

/** Accept the guide's card: the token's task, saved for the signed-in buyer, through the same checks as the page. */
export async function acceptTaskProposal(db: Db, actor: Actor, token: string, secret: string, opts: { now?: Date } = {}): Promise<TaskSummary> {
  const t = readProposal('task', token, z.unknown(), secret, opts);
  if (t === null) throw new ScheduleError('That card has expired. Ask the guide again.', 'invalid');
  return createTask(db, actor, t, opts);
}
