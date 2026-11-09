import { and, asc, eq, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { automation, automationRun, type Db } from '@repo/db';
import type { Actor } from '../permissions';
import { SUSPENDED_AGENCY_IDS } from '../platform/access';
import { skillOffMessage, type SkillKey } from '../skill-switches/catalog';
import { holderOf, isSkillOnForChat } from '../skill-switches/switches';
import { activeMemberActor } from '../team/member-actor';
import { AUTOMATION_LIMITS, type AutomationKind } from './kinds';
import { nextRunOf, AutomationError } from './manage';
import { AUTOMATION_RUNNERS, type RunnerDeps } from './runners';
import { can } from '../permissions';

/**
 * The clock (ADR 0089), on the skills' pattern (ADR 0021 §7). Claiming makes the run and moves the cursor in one transaction, so a
 * double-fired tick is harmless. A run is then advanced one slice at a time, under a lease, so it survives a function that times out.
 */

const CLAIM_LIMIT = 10;
const OWNER_LEFT = 'Its owner is no longer an active member of this agency.';

export async function claimDueAutomations(db: Db, now: Date): Promise<number> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(automation)
      .where(and(eq(automation.status, 'active'), lte(automation.nextRunAt, now), sql`${automation.agencyId} not in ${SUSPENDED_AGENCY_IDS}`))
      .orderBy(asc(automation.nextRunAt), asc(automation.id))
      .limit(CLAIM_LIMIT)
      .for('update', { of: automation, skipLocked: true });
    let made = 0;
    for (const row of due) {
      const slot = row.nextRunAt!;
      // Anchored on the slot, never on now: 7 AM stays 7 AM after an outage.
      await tx.update(automation).set({ nextRunAt: nextRunOf(row, slot), updatedAt: sql`now()` }).where(eq(automation.id, row.id));
      const [busy] = await tx.select({ id: automationRun.id }).from(automationRun).where(and(eq(automationRun.automationId, row.id), eq(automationRun.status, 'running'))).limit(1);
      const [run] = await tx
        .insert(automationRun)
        .values({
          automationId: row.id,
          agencyId: row.agencyId,
          userId: row.userId,
          scheduledFor: slot,
          ...(busy ? { status: 'skipped', detail: 'The run before it was still going.', finishedAt: now } : {}),
        })
        .onConflictDoNothing()
        .returning({ id: automationRun.id });
      if (run) made += 1;
    }
    return made;
  });
}

type RunRow = typeof automationRun.$inferSelect;
type AutomationRow = typeof automation.$inferSelect;

async function claimRun(db: Db, now: Date, runId?: string): Promise<RunRow | null> {
  return db.transaction(async (tx) => {
    const [r] = await tx
      .select()
      .from(automationRun)
      .where(and(eq(automationRun.status, 'running'), or(isNull(automationRun.leaseUntil), lt(automationRun.leaseUntil, now)), ...(runId ? [eq(automationRun.id, runId)] : [])))
      .orderBy(asc(automationRun.createdAt))
      .limit(1)
      .for('update', { skipLocked: true });
    if (!r) return null;
    await tx
      .update(automationRun)
      .set({ leaseUntil: new Date(now.getTime() + AUTOMATION_LIMITS.leaseMinutes * 60_000), updatedAt: sql`now()` })
      .where(eq(automationRun.id, r.id));
    return r;
  });
}

async function finish(db: Db, run: RunRow, status: 'done' | 'stopped' | 'failed' | 'skipped', detail: string | null, now: Date, progress: Partial<RunRow> = {}): Promise<void> {
  await db
    .update(automationRun)
    .set({ ...progress, status, detail, finishedAt: now, leaseUntil: null, updatedAt: sql`now()` })
    // Only if still running: someone may have pressed Stop while this slice was going.
    .where(and(eq(automationRun.id, run.id), eq(automationRun.status, 'running')));
  await db
    .update(automation)
    .set({
      lastRunAt: now,
      ...(status === 'done' ? { consecutiveFailures: 0 } : status === 'failed' ? { consecutiveFailures: sql`${automation.consecutiveFailures} + 1` } : {}),
      updatedAt: sql`now()`,
    })
    .where(eq(automation.id, run.automationId));
  if (status === 'failed') {
    await db
      .update(automation)
      .set({ status: 'paused', nextRunAt: null, pausedReason: `Paused after ${AUTOMATION_LIMITS.failuresBeforePause} failed runs in a row.` })
      .where(and(eq(automation.id, run.automationId), eq(automation.status, 'active'), sql`${automation.consecutiveFailures} >= ${AUTOMATION_LIMITS.failuresBeforePause}`));
  }
}

/** One slice of one run. */
async function advance(db: Db, a: AutomationRow, run: RunRow, actor: Actor, deps: RunnerDeps, now: Date): Promise<void> {
  const runner = AUTOMATION_RUNNERS[a.kind as AutomationKind];
  if (!runner) return finish(db, run, 'failed', 'This kind of automation is not available.', now);
  let contactIds = (Array.isArray(run.contactIds) ? run.contactIds : []) as string[];

  if (run.cursor === 0 && contactIds.length === 0) {
    const who = await runner.people(db, actor, a.spec, deps);
    if ('stop' in who) return finish(db, run, 'skipped', who.stop, now);
    if (!who.contactIds.length) return finish(db, run, 'done', 'Nobody on the list could receive it this time.', now, { skipped: who.skipped });
    contactIds = who.contactIds;
    await db.update(automationRun).set({ contactIds, skipped: who.skipped, updatedAt: sql`now()` }).where(eq(automationRun.id, run.id));
    run = { ...run, contactIds, skipped: who.skipped };
  }

  const size = runner.chunkSize(deps);
  const slice = contactIds.slice(run.cursor, run.cursor + size);
  const r = await runner.send(db, actor, a.spec, slice, deps, now);
  const progress = { cursor: run.cursor + slice.length, sent: run.sent + r.sent, failed: run.failed + r.failed, skipped: run.skipped + r.skipped };
  if (r.stop) return finish(db, run, 'stopped', r.stop, now, progress);
  if (progress.cursor >= contactIds.length) return finish(db, run, 'done', null, now, progress);
  await db
    .update(automationRun)
    .set({ ...progress, leaseUntil: null, updatedAt: sql`now()` })
    .where(and(eq(automationRun.id, run.id), eq(automationRun.status, 'running')));
}

async function advanceOne(db: Db, deps: RunnerDeps, now: Date, runId?: string): Promise<boolean> {
  const run = await claimRun(db, now, runId);
  if (!run) return false;
  const [a] = await db.select().from(automation).where(eq(automation.id, run.automationId)).limit(1);
  if (!a) return true;
  try {
    const actor = await activeMemberActor(db, a.userId, a.agencyId);
    if (!actor) {
      await finish(db, run, 'skipped', OWNER_LEFT, now);
      await db.update(automation).set({ status: 'paused', nextRunAt: null, pausedReason: OWNER_LEFT }).where(and(eq(automation.id, a.id), eq(automation.status, 'active')));
      return true;
    }
    if (!(await isSkillOnForChat(db, actor, a.skillKey as SkillKey))) {
      await finish(db, run, 'skipped', skillOffMessage(a.skillKey as SkillKey, holderOf(actor.membershipRole)), now);
      return true;
    }
    await advance(db, a, run, actor, deps, now);
  } catch (err) {
    console.error('[automations] run failed', err instanceof Error ? err.message : 'unknown');
    await finish(db, run, 'failed', 'This run could not finish.', now).catch(() => undefined);
  }
  return true;
}

/** The minute tick: make what is due, then move what is running on by a few slices. */
export async function runAutomationTick(db: Db, deps: RunnerDeps, now: Date, slices: number): Promise<{ made: number; advanced: number }> {
  const made = await claimDueAutomations(db, now);
  let advanced = 0;
  for (let i = 0; i < slices; i++) {
    if (!(await advanceOne(db, deps, now))) break;
    advanced += 1;
  }
  return { made, advanced };
}

/** Carry one run on by hand, up to `slices`. What is left, the minute tick finishes. */
export async function driveAutomationRun(db: Db, deps: RunnerDeps, runId: string, now = new Date(), slices = 10): Promise<void> {
  for (let i = 0; i < slices; i++) {
    if (!(await advanceOne(db, deps, now, runId))) return;
  }
}

/** "Run now" from the Automations tab: the same run, off the clock, and the clock does not move. */
export async function runAutomationNow(db: Db, actor: Actor, id: string, now = new Date()): Promise<{ runId: string }> {
  if (!actor.agencyId || !/^[0-9a-f-]{36}$/i.test(id)) throw new AutomationError('not_found', 'That automation was not found');
  const [a] = await db.select().from(automation).where(and(eq(automation.id, id), eq(automation.agencyId, actor.agencyId))).limit(1);
  if (!a || !can(actor, 'automation:read', { type: 'automation', id: a.id, agencyId: a.agencyId, ownerId: a.userId })) throw new AutomationError('not_found', 'That automation was not found');
  if (!can(actor, 'automation:manage', { type: 'automation', id: a.id, agencyId: a.agencyId, ownerId: a.userId })) throw new AutomationError('forbidden', 'Only its owner or an admin can run this');
  if (a.status === 'archived') throw new AutomationError('conflict', 'This automation has been removed');
  const [busy] = await db.select({ id: automationRun.id }).from(automationRun).where(and(eq(automationRun.automationId, a.id), eq(automationRun.status, 'running'))).limit(1);
  if (busy) throw new AutomationError('conflict', 'A run of this automation is still going');
  const [run] = await db.insert(automationRun).values({ automationId: a.id, agencyId: a.agencyId, userId: a.userId, trigger: 'manual', scheduledFor: now }).returning({ id: automationRun.id });
  return { runId: run!.id };
}
