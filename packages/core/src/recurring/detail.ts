import { and, asc, desc, eq, inArray, isNotNull, isNull, notInArray } from 'drizzle-orm';
import { assistantTask, proposedAction, type Db } from '@repo/db';
import type { ProposalCard } from '../assistant/schema';
import { can, type Actor } from '../permissions';
import { SMS_SKIP_REASON_LABELS } from '../phone/sms-rules';
import { listSkillRuns } from '../skills/skills';
import { getBatch } from '../template-email/batches';
import { SKIP_REASON_LABELS } from '../template-email/schema';
import { TemplateEmailError } from '../template-email/templates';
import { workflowRuns } from '../workflows/manage';
import { AUTOMATION_KEY, CHAT_ACTION_KEY, readableSendError, type AutomationDetail, type ChatActionDetail, type RunProgress } from './detail-types';
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

/** Cards that went ahead. Proposed, rejected, expired and cancelled ones did nothing, so the panel leaves them out. */
const WENT_AHEAD = ['approved', 'scheduled', 'running', 'done', 'failed'] as const;
/** These make an automation, which the panel already shows as itself. */
const MAKES_AUTOMATION = ['plan_task', 'set_up_skill', 'create_workflow'];

/**
 * What one of this person's chats has made or done, for the panel beside it: its automations, then the things approved once
 * (the user, 2026-11-23), newest first. A task's steps are its task's, not cards of their own here.
 */
export async function automationsOfChat(db: Db, actor: Actor, conversationId: string): Promise<Pick<AutomationRow, 'key' | 'name' | 'state'>[]> {
  if (!actor.agencyId || !/^[0-9a-f-]{36}$/i.test(conversationId)) return [];
  const [automations, actions] = await Promise.all([
    listEveryAutomation(db, actor),
    db
      .select({ id: proposedAction.id, card: proposedAction.card, status: proposedAction.status })
      .from(proposedAction)
      .where(
        and(
          eq(proposedAction.conversationId, conversationId),
          eq(proposedAction.userId, actor.userId),
          eq(proposedAction.agencyId, actor.agencyId),
          inArray(proposedAction.status, [...WENT_AHEAD]),
          notInArray(proposedAction.tool, MAKES_AUTOMATION),
          isNull(proposedAction.taskId),
        ),
      )
      .orderBy(desc(proposedAction.createdAt))
      .limit(20),
  ]);
  return [
    ...automations.filter((r) => r.mine && r.conversationId === conversationId).map((r) => ({ key: r.key, name: r.name, state: r.state })),
    ...actions.map((a) => ({ key: `action:${a.id}`, name: (a.card as ProposalCard).title || 'Done in this chat', state: a.status === 'done' || a.status === 'failed' ? ('finished' as const) : ('active' as const) })),
  ];
}

/** One thing approved in a chat, with who a send reached. Null: not found, or not this person's to see. */
export async function chatActionDetail(db: Db, actor: Actor, key: string): Promise<ChatActionDetail | null> {
  if (!actor.agencyId || !CHAT_ACTION_KEY.test(key)) return null;
  const id = key.slice('action:'.length);
  const [row] = await db.select().from(proposedAction).where(and(eq(proposedAction.id, id), eq(proposedAction.agencyId, actor.agencyId))).limit(1);
  if (!row || !can(actor, 'proposed_action:read', { type: 'proposed_action', id: row.id, agencyId: row.agencyId, ownerId: row.userId })) return null;
  const card = row.card as ProposalCard;
  const args = row.args as { tool: string; batchId?: string };
  const base: ChatActionDetail = { key, tool: row.tool, name: card.title, status: row.status, lines: card.lines ?? [], decidedAt: iso(row.decidedAt), runAt: iso(row.runAt), finishedAt: iso(row.finishedAt), error: row.error, send: null };
  if ((args.tool !== 'send_template_email' && args.tool !== 'send_template_sms') || !args.batchId) return base;

  const channel = args.tool === 'send_template_sms' ? 'sms' : 'email';
  // The batch has its own can(); a batch this person may not read leaves the card without its people.
  const b = await getBatch(db, actor, args.batchId, new Date(), { channel }).catch((e) => (e instanceof TemplateEmailError ? null : Promise.reject(e)));
  if (!b) return base;
  const reasons: Readonly<Record<string, string>> = channel === 'sms' ? SMS_SKIP_REASON_LABELS : SKIP_REASON_LABELS;
  const c = b.counts;
  return {
    ...base,
    send: {
      channel,
      batchId: b.id,
      total: c.total,
      sent: c.sent,
      failed: c.failed,
      skipped: c.skipped,
      left: c.toSend + c.sending,
      people: b.recipients.map((r) => ({ name: r.name, to: channel === 'sms' ? r.phone : r.email, status: r.status, why: r.status === 'failed' ? readableSendError(r.error) : r.skipReason ? (reasons[r.skipReason] ?? r.skipReason) : null, at: iso(r.sentAt) })),
    },
  };
}
