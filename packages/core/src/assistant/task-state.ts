import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { appointment, assistantTask, contact, lead, note, notification, proposedAction, type DbOrTx } from '@repo/db';
import { AssistantError } from './conversations';

/**
 * An assistant task's state (ADR 0040). A task is a plan of up to 10 steps the
 * person approved once; every step is a `proposed_action` row (`task_id`,
 * `task_seq`) that waits `blocked` until the step before it is done, then is
 * `scheduled` at its own time and run by the minute tick exactly as a delayed
 * card is — as the approver, as they are then, every check repeated.
 *
 * These functions move the rows; they never run a step. They take the
 * caller's transaction, so a step's outcome and the next step's release
 * commit together.
 */

/** Approve the plan: the task is active; its first step is due at its time (or now); every step is decided by the approver. */
export async function activateTask(tx: DbOrTx, taskId: string, approverId: string, now: Date): Promise<{ steps: number }> {
  const [t] = await tx
    .update(assistantTask)
    .set({ status: 'active', updatedAt: sql`now()` })
    .where(and(eq(assistantTask.id, taskId), eq(assistantTask.status, 'proposed'), gt(assistantTask.endsAt, now)))
    .returning({ id: assistantTask.id });
  if (!t) throw new AssistantError('conflict', 'This plan can no longer start — it was cancelled or has run past its 30 days. Ask the assistant again.');
  const steps = await tx
    .update(proposedAction)
    .set({ decidedAt: now, decidedBy: approverId, updatedAt: sql`now()` })
    .where(and(eq(proposedAction.taskId, taskId), eq(proposedAction.status, 'blocked')))
    .returning({ id: proposedAction.id });
  await releaseNext(tx, taskId, now);
  return { steps: steps.length };
}

/** The first blocked step becomes due: at its own time, or now if that has passed or it has none. */
async function releaseNext(tx: DbOrTx, taskId: string, now: Date): Promise<boolean> {
  const [next] = await tx
    .select({ id: proposedAction.id, runAt: proposedAction.runAt })
    .from(proposedAction)
    .where(and(eq(proposedAction.taskId, taskId), eq(proposedAction.status, 'blocked')))
    .orderBy(asc(proposedAction.taskSeq))
    .limit(1);
  if (!next) return false;
  const at = next.runAt && new Date(next.runAt).getTime() > now.getTime() ? new Date(next.runAt) : now;
  await tx
    .update(proposedAction)
    .set({ status: 'scheduled', runAt: at, updatedAt: sql`now()` })
    .where(and(eq(proposedAction.id, next.id), eq(proposedAction.status, 'blocked')));
  return true;
}

/**
 * After a step ran (inside the same transaction as its done/failed): a done
 * step releases the next, and the last one finishes the task; a failed step
 * stops the task — every step not yet run is cancelled, the reason kept.
 */
export async function advanceTask(tx: DbOrTx, taskId: string, outcome: { ok: true } | { ok: false; error: string }, now: Date): Promise<void> {
  if (outcome.ok) {
    const released = await releaseNext(tx, taskId, now);
    if (!released) {
      await tx
        .update(assistantTask)
        .set({ status: 'done', finishedAt: now, updatedAt: sql`now()` })
        .where(and(eq(assistantTask.id, taskId), eq(assistantTask.status, 'active')));
    }
    return;
  }
  await cancelRemainingSteps(tx, taskId);
  await tx
    .update(assistantTask)
    .set({ status: 'failed', error: outcome.error.slice(0, 500), finishedAt: now, updatedAt: sql`now()` })
    .where(and(eq(assistantTask.id, taskId), eq(assistantTask.status, 'active')));
}

/** Every step not yet run, cancelled. */
export async function cancelRemainingSteps(tx: DbOrTx, taskId: string): Promise<number> {
  const gone = await tx
    .update(proposedAction)
    .set({ status: 'cancelled', updatedAt: sql`now()` })
    .where(and(eq(proposedAction.taskId, taskId), inArray(proposedAction.status, ['blocked', 'scheduled'])))
    .returning({ id: proposedAction.id });
  return gone.length;
}

/** The plan was rejected, cancelled or expired, or the task is cancelled: nothing more of it runs. */
export async function endTask(tx: DbOrTx, taskId: string, status: 'cancelled' | 'expired', now: Date): Promise<number> {
  const n = await cancelRemainingSteps(tx, taskId);
  await tx
    .update(assistantTask)
    .set({ status, finishedAt: now, updatedAt: sql`now()` })
    .where(and(eq(assistantTask.id, taskId), inArray(assistantTask.status, ['proposed', 'active'])));
  return n;
}

/** May this step still run? Its task active and within its 30 days. */
export async function taskAllowsRun(tx: DbOrTx, taskId: string, now: Date): Promise<string | null> {
  const [t] = await tx.select({ status: assistantTask.status, endsAt: assistantTask.endsAt }).from(assistantTask).where(eq(assistantTask.id, taskId)).limit(1);
  if (!t || t.status !== 'active') return 'Its task is no longer running.';
  if (new Date(t.endsAt).getTime() <= now.getTime()) return 'Its task ran past its 30 days, so this step did not run.';
  return null;
}

/**
 * The read-back (ADR 0040 §4): after a step runs, inside its savepoint, look
 * at what it says it made. Disagreement throws — the savepoint undoes the
 * step and the card says it could not be confirmed. Tools not listed here are
 * confirmed by their own core function's return.
 */
export async function verifyExecuted(
  tx: DbOrTx,
  args: { tool: string } & Record<string, unknown>,
  result: Record<string, unknown>,
): Promise<void> {
  const fail = () => {
    throw new AssistantError('conflict', 'The change could not be confirmed afterwards, so it was undone. Try again.');
  };
  const one = async (q: Promise<unknown[]>) => ((await q).length === 1 ? undefined : fail());
  switch (args.tool) {
    case 'add_note':
      return one(tx.select({ id: note.id }).from(note).where(and(eq(note.id, String(result.noteId)), eq(note.contactId, String(args.contactId)))).limit(1));
    case 'set_lead_status':
      return one(tx.select({ id: lead.id }).from(lead).where(and(eq(lead.id, String(args.leadId)), eq(lead.status, String(args.status) as never))).limit(1));
    case 'assign_lead':
      return one(tx.select({ id: lead.id }).from(lead).where(and(eq(lead.id, String(args.leadId)), eq(lead.assignedTo, String(args.to)))).limit(1));
    case 'create_lead':
      return one(tx.select({ id: lead.id }).from(lead).where(and(eq(lead.id, String(result.leadId)), eq(lead.source, 'manual'))).limit(1));
    case 'create_contact':
      return one(tx.select({ id: contact.id }).from(contact).where(eq(contact.id, String(result.contactId))).limit(1));
    case 'remind':
      return one(tx.select({ id: notification.id }).from(notification).where(eq(notification.id, String(result.notificationId))).limit(1));
    case 'schedule_appointment':
    case 'schedule_team_meeting':
      return one(
        tx
          .select({ id: appointment.id })
          .from(appointment)
          .where(and(eq(appointment.id, String(result.appointmentId)), eq(appointment.startsAt, new Date(String(args.startsAt)))))
          .limit(1),
      );
    default:
      return;
  }
}
