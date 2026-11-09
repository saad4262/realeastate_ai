import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { automation, automationRun, type Db, type DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';
import { nextRunFor } from '../schedules/next-run';
import { AUTOMATION_SKILL, AUTOMATION_SPECS, type AutomationDraft, type AutomationKind } from './kinds';

export class AutomationError extends Error {
  constructor(
    public code: 'forbidden' | 'not_found' | 'invalid' | 'conflict',
    message: string,
  ) {
    super(message);
  }
}

type Row = typeof automation.$inferSelect;
const NOT_FOUND = () => new AutomationError('not_found', 'That automation was not found');
const resource = (a: { id?: string; agencyId: string; userId: string }) => ({ type: 'automation', ...(a.id ? { id: a.id } : {}), agencyId: a.agencyId, ownerId: a.userId });

export const nextRunOf = (a: Pick<Row, 'cadence' | 'sendAtMinute' | 'sendOnWeekday' | 'intervalMinutes' | 'timezone'>, after: Date): Date =>
  nextRunFor({ cadence: a.cadence, sendAtMinute: a.sendAtMinute, timezone: a.timezone, sendOnWeekday: a.sendOnWeekday ?? undefined, intervalMinutes: a.intervalMinutes ?? undefined, after });

async function load(db: DbOrTx, actor: Actor, id: string): Promise<Row> {
  if (!actor.agencyId || !/^[0-9a-f-]{36}$/i.test(id)) throw NOT_FOUND();
  const [a] = await db.select().from(automation).where(and(eq(automation.id, id), eq(automation.agencyId, actor.agencyId))).limit(1);
  if (!a || !can(actor, 'automation:read', resource(a))) throw NOT_FOUND();
  return a;
}

/** Made from a card the person approved. The spec is parsed again here. */
export async function createAutomation(db: DbOrTx, actor: Actor, draft: AutomationDraft, now = new Date()): Promise<{ id: string; nextRunAt: Date }> {
  if (!actor.agencyId || !can(actor, 'automation:create', { type: 'automation', agencyId: actor.agencyId, ownerId: actor.userId })) {
    throw new AutomationError('forbidden', 'You may not create automations');
  }
  const kind = draft.kind as AutomationKind;
  const parsed = AUTOMATION_SPECS[kind]?.safeParse(draft.spec);
  if (!parsed?.success) throw new AutomationError('invalid', 'That automation could not be read');
  const nextRunAt = nextRunOf(draft, now);
  const [row] = await db
    .insert(automation)
    .values({
      agencyId: actor.agencyId,
      userId: actor.userId,
      conversationId: draft.conversationId,
      skillKey: AUTOMATION_SKILL[kind].key,
      kind,
      name: draft.name,
      spec: parsed.data,
      cadence: draft.cadence,
      sendAtMinute: draft.sendAtMinute,
      sendOnWeekday: draft.sendOnWeekday,
      intervalMinutes: draft.intervalMinutes,
      timezone: draft.timezone,
      nextRunAt,
    })
    .returning({ id: automation.id });
  return { id: row!.id, nextRunAt };
}

/** On, off or removed. Turning one back on starts from its next slot and clears its failures. */
export async function setAutomationStatus(db: DbOrTx, actor: Actor, id: string, status: 'active' | 'paused' | 'archived', now = new Date()): Promise<void> {
  const a = await load(db, actor, id);
  if (!can(actor, 'automation:manage', resource(a))) throw new AutomationError('forbidden', 'Only its owner or an admin can change this automation');
  if (a.status === 'archived') throw new AutomationError('conflict', 'This automation has been removed');
  await db
    .update(automation)
    .set({ status, nextRunAt: status === 'active' ? nextRunOf(a, now) : null, pausedReason: null, ...(status === 'active' ? { consecutiveFailures: 0 } : {}), updatedAt: sql`now()` })
    .where(eq(automation.id, a.id));
}

export type AutomationRunView = { id: string; status: string; at: Date; finishedAt: Date | null; total: number; sent: number; failed: number; skipped: number; detail: string | null; trigger: string };

/** One automation's history, newest first. */
export async function listAutomationRuns(db: DbOrTx, actor: Actor, id: string, limit = 20): Promise<AutomationRunView[]> {
  const a = await load(db, actor, id);
  const rows = await db.select().from(automationRun).where(eq(automationRun.automationId, a.id)).orderBy(desc(automationRun.createdAt)).limit(limit);
  return rows.map((r) => ({ id: r.id, status: r.status, at: new Date(r.scheduledFor), finishedAt: r.finishedAt ? new Date(r.finishedAt) : null, total: Array.isArray(r.contactIds) ? r.contactIds.length : 0, sent: r.sent, failed: r.failed, skipped: r.skipped, detail: r.detail, trigger: r.trigger }));
}

/** Stop a run that is sending: what has gone stays gone; the automation itself stays on. */
export async function stopAutomationRun(db: Db, actor: Actor, runId: string, now = new Date()): Promise<void> {
  if (!actor.agencyId || !/^[0-9a-f-]{36}$/i.test(runId)) throw NOT_FOUND();
  const [r] = await db.select({ automationId: automationRun.automationId, agencyId: automationRun.agencyId, userId: automationRun.userId, status: automationRun.status }).from(automationRun).where(eq(automationRun.id, runId)).limit(1);
  if (!r || r.agencyId !== actor.agencyId || !can(actor, 'automation:read', resource({ agencyId: r.agencyId, userId: r.userId }))) throw NOT_FOUND();
  if (!can(actor, 'automation:manage', resource({ agencyId: r.agencyId, userId: r.userId }))) throw new AutomationError('forbidden', 'Only its owner or an admin can stop this');
  const done = await db
    .update(automationRun)
    .set({ status: 'stopped', detail: 'Stopped by hand. What had gone stays gone.', finishedAt: now, leaseUntil: null, updatedAt: sql`now()` })
    .where(and(eq(automationRun.id, runId), inArray(automationRun.status, ['running'])))
    .returning({ id: automationRun.id });
  if (!done.length) throw new AutomationError('conflict', 'That run has already finished');
}
