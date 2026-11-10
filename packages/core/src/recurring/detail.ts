import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { assistantTask, proposedAction, type Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import { listSkillRuns } from '../skills/skills';
import { workflowRuns } from '../workflows/manage';
import { AUTOMATION_KEY, type AutomationDetail, type RunProgress } from './detail-types';
import { listEveryAutomation, type AutomationRow } from './list';
import { listAutomationRuns } from './manage';

/**
 * One automation in full (the user, 2026-11-10): what it is, the run going now with what is left, and its history. Read from where it
 * already lives, as the Automations tab reads it, so the two never disagree. Null: not found, or not this person's to see.
 */

const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

export async function automationDetail(db: Db, actor: Actor, key: string): Promise<AutomationDetail | null> {
  if (!actor.agencyId || !AUTOMATION_KEY.test(key)) return null;
  const row = (await listEveryAutomation(db, actor)).find((r) => r.key === key);
  if (!row) return null;
  const base = { ...row, current: null, runs: [], steps: [], canStop: false } satisfies AutomationDetail;

  if (row.source === 'recurring') {
    const runs: RunProgress[] = (await listAutomationRuns(db, actor, row.id, 15)).map((r) => ({
      id: r.id,
      status: r.status,
      at: r.at.toISOString(),
      finishedAt: iso(r.finishedAt),
      total: r.total,
      sent: r.sent,
      failed: r.failed,
      skipped: r.skipped,
      remaining: Math.max(0, r.total - r.sent - r.failed),
      detail: r.detail,
      manual: r.trigger === 'manual',
    }));
    const current = runs.find((r) => r.status === 'running') ?? null;
    // canToggle is automation:manage for this row: the same people may stop a run of it.
    return { ...base, current, runs: runs.filter((r) => r !== current), canStop: Boolean(current) && row.canToggle };
  }

  if (row.source === 'workflow') {
    const runs = await workflowRuns(db, actor, row.id, 15);
    return {
      ...base,
      runs: runs.map((r) => {
        const done = r.steps.filter((s) => s.status === 'done').length;
        return { id: r.id, status: r.status, at: r.at.toISOString(), finishedAt: null, total: r.steps.length, sent: done, failed: r.steps.filter((s) => s.status === 'failed').length, skipped: 0, remaining: Math.max(0, r.steps.length - done), detail: r.error, manual: false };
      }),
    };
  }

  if (row.source === 'task') {
    const [t] = await db.select({ userId: assistantTask.userId, status: assistantTask.status }).from(assistantTask).where(eq(assistantTask.id, row.id)).limit(1);
    const steps = await db
      .select({ card: proposedAction.card, status: proposedAction.status, runAt: proposedAction.runAt, error: proposedAction.error })
      .from(proposedAction)
      .where(and(eq(proposedAction.taskId, row.id), isNotNull(proposedAction.taskSeq)))
      .orderBy(asc(proposedAction.taskSeq));
    return {
      ...base,
      steps: steps.map((s) => ({ title: (s.card as { title?: string }).title ?? 'A step', status: s.status, at: iso(s.runAt), error: s.error })),
      canStop: t?.status === 'active' && can(actor, 'proposed_action:cancel', { type: 'proposed_action', agencyId: actor.agencyId, ownerId: t.userId }),
    };
  }

  // A scheduled AI skill: only its owner may read its runs.
  if (!row.mine) return base;
  const runs = await listSkillRuns(db, actor, row.id, 15);
  return {
    ...base,
    runs: runs.map((r) => ({ id: r.id, status: r.status, at: r.startedAt.toISOString(), finishedAt: iso(r.finishedAt), total: r.itemsProcessed, sent: r.itemsProcessed, failed: 0, skipped: 0, remaining: 0, detail: r.error, manual: r.trigger === 'manual' })),
  };
}

/** The automations made in one of this person's chats, for the panel beside it. */
export async function automationsOfChat(db: Db, actor: Actor, conversationId: string): Promise<Pick<AutomationRow, 'key' | 'name' | 'state'>[]> {
  if (!actor.agencyId || !/^[0-9a-f-]{36}$/i.test(conversationId)) return [];
  return (await listEveryAutomation(db, actor)).filter((r) => r.mine && r.conversationId === conversationId).map((r) => ({ key: r.key, name: r.name, state: r.state }));
}
