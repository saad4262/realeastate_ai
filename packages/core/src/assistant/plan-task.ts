import { and, eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { assistantTask, proposedAction } from '@repo/db';
import { localDateTimeToInstant } from '../time/local-input';
import { issueHandle } from './handles';
import { propose, type FrozenArgs } from './actions';
import { NOTHING_YET, refused, when } from './write-tools';
import { ASSISTANT_LIMITS, remindStepInput, TASK_LIMITS, type AssistantWriteTool, type planTaskInput, type ProposalCard } from './schema';
import { runAssistantTool, type ToolContext, type ToolOutcome } from './tools';

/**
 * plan_task (ADR 0040 §2): the model writes a plan; the server makes it safe.
 * Each step is checked and resolved by THAT tool's own propose function in
 * plan mode (`ctx.plan`) — the same references, permission checks, "Connect X
 * first" and card text as a single card — and any refusal refuses the whole
 * plan, naming the step. Nothing is half-made.
 *
 * Stored: the task (`proposed`), each step as a `blocked` proposed_action, and
 * ONE plan card listing every step in words with the exact text of anything
 * that reaches another person. Approving the card starts the task.
 */
export type TaskStep = { tool: AssistantWriteTool | 'remind'; args: FrozenArgs; card: ProposalCard; contactId: string | null; at: Date | null };
type Step = TaskStep;

/**
 * Before any task is planned: inside a conversation, within this answer's cards and the
 * person's active tasks — or the card this same tool call already made (a retried request).
 */
export async function taskGate(ctx: ToolContext, label: string): Promise<{ stop: ToolOutcome } | { key: string }> {
  const { db, actor, proposal } = ctx;
  if (!proposal || !actor.agencyId) return { stop: refused('A plan can only be made inside a conversation.', label) };
  if (proposal.made.count >= ASSISTANT_LIMITS.proposalsPerTurn) {
    return { stop: refused(`You have already proposed ${ASSISTANT_LIMITS.proposalsPerTurn} changes in this answer. Ask the person to deal with those cards first.`, label) };
  }
  const key = `${proposal.conversationId}:${proposal.toolUseId}`;
  const [again] = await db.select({ id: proposedAction.id, args: proposedAction.args }).from(proposedAction).where(eq(proposedAction.idempotencyKey, key)).limit(1);
  if (again) {
    const taskId = (again.args as { taskId?: string }).taskId;
    return { stop: { label, frame: { kind: 'proposal', id: again.id, tool: 'plan_task' }, result: { proposed: true, status: 'waiting for the person', ...(taskId ? { task: issueHandle(ctx.handles, 'K', taskId) } : {}) } } };
  }
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(assistantTask)
    .where(and(eq(assistantTask.userId, actor.userId), inArray(assistantTask.status, ['proposed', 'active'])));
  if (n >= TASK_LIMITS.activePerPerson) {
    return { stop: refused(`You already have ${TASK_LIMITS.activePerPerson} tasks planned or running. Let one finish or cancel one first.`, label) };
  }
  return { key };
}

/** The latest a task may run: TASK_LIMITS.days from now. */
export function taskEnd(now: Date): Date {
  return new Date(now.getTime() + TASK_LIMITS.days * 86_400_000);
}

/**
 * Store the task (`proposed`), each step as a `blocked` proposed_action, and ONE card for the
 * whole of it — approving the card starts the task (`activateTask`).
 */
export async function storeTask(
  ctx: ToolContext,
  label: string,
  key: string,
  task: { title: string; steps: TaskStep[]; card: ProposalCard; contactId?: string | null },
): Promise<ToolOutcome> {
  const { db, actor, proposal } = ctx;
  const latest = taskEnd(ctx.now);
  const taskId = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(assistantTask)
      .values({ agencyId: actor.agencyId!, userId: actor.userId, conversationId: proposal!.conversationId, title: task.title, status: 'proposed', endsAt: latest })
      .returning({ id: assistantTask.id });
    for (const [i, s] of task.steps.entries()) {
      await tx.insert(proposedAction).values({
        agencyId: actor.agencyId!,
        userId: actor.userId,
        conversationId: proposal!.conversationId,
        turnId: proposal!.turnId,
        contactId: s.contactId,
        tool: s.tool,
        args: s.args,
        card: s.card,
        status: 'blocked',
        idempotencyKey: `${key}:step${i + 1}`,
        expiresAt: latest,
        runAt: s.at,
        taskId: row!.id,
        taskSeq: i + 1,
      });
    }
    return row!.id;
  });
  const out = await propose(ctx, label, { tool: 'plan_task', args: { tool: 'plan_task', taskId }, card: task.card, contactId: task.contactId ?? null });
  return { ...out, result: { ...(out.result as Record<string, unknown>), task: issueHandle(ctx.handles, 'K', taskId), steps: task.steps.length } };
}

export async function proposePlanTask(ctx: ToolContext, input: z.infer<typeof planTaskInput>, label: string): Promise<ToolOutcome> {
  const gate = await taskGate(ctx, label);
  if ('stop' in gate) return gate.stop;

  const latest = taskEnd(ctx.now);
  const steps: Step[] = [];
  for (const [i, step] of input.steps.entries()) {
    const name = `Step ${i + 1} (${step.tool})`;
    let at: Date | null = null;
    if (step.date) {
      at = localDateTimeToInstant(step.date, step.time ?? '09:00', ctx.timeZone);
      if (!at) return refused(`${name}: that date or time is not valid.`, label);
      if (at.getTime() <= ctx.now.getTime()) return refused(`${name}: that time has already passed.`, label);
      if (at.getTime() > latest.getTime()) return refused(`${name}: a task can run for at most ${TASK_LIMITS.days} days.`, label);
    }
    if (step.tool === 'remind') {
      const r = remindStepInput.safeParse(step.input);
      if (!r.success) return refused(`${name}: ${r.error.issues[0]?.message ?? 'give the reminder text'}`, label);
      steps.push({
        tool: 'remind',
        args: { tool: 'remind', text: r.data.text, email: r.data.mail_me },
        card: {
          title: `Remind you: ${r.data.text}`,
          contact: { id: '', name: '' },
          lines: [{ label: 'By email', value: r.data.mail_me ? 'Yes, to your own address — and the bell' : 'No — the bell only' }],
          notes: [],
        },
        contactId: null,
        at,
      });
      continue;
    }
    // The tool's own path, in plan mode: parse, permission gates, references, card — collected, not stored.
    const collected: Omit<Step, 'at'>[] = [];
    const out = await runAssistantTool({ ...ctx, plan: { collect: (s) => collected.push(s) } }, step.tool, step.input);
    const said = out.result as { error?: string; tell_the_user?: string; proposed?: boolean; needs_connection?: unknown };
    if (out.isError || said.proposed === false) {
      const no = refused(`${name}: ${said.error ?? said.tell_the_user ?? 'it could not be planned'}`, label);
      // "Connect X first" for a step keeps its shape and its Connect button (ADR 0040 part 2 §1).
      if (said.needs_connection) return { ...no, result: { ...(no.result as object), needs_connection: said.needs_connection }, ...(out.frame ? { frame: out.frame } : {}) };
      return no;
    }
    if (collected.length !== 1) return refused(`${name}: it could not be planned as one step.`, label);
    steps.push({ ...collected[0]!, at });
  }

  const whenText = (s: Step, i: number) => (s.at ? when(s.at, ctx.timeZone) : i === 0 ? 'As soon as you approve' : 'Right after the step before');
  const lines: ProposalCard['lines'] = [];
  steps.forEach((s, i) => {
    lines.push({ label: `Step ${i + 1} · ${whenText(s, i)}`, value: s.card.title });
    // Everything the step's own card would show — with the exact text of anything that reaches another person.
    for (const l of s.card.lines) lines.push({ label: `   ${l.label}`, value: l.value });
    if (s.card.text) lines.push({ label: `   ${s.card.text.label}`, value: s.card.text.value });
  });
  const card: ProposalCard = {
    title: `Plan: ${input.title}`,
    contact: { id: '', name: '' },
    lines,
    notes: [
      NOTHING_YET,
      'Each step runs in order, as you, with your permissions checked again when it runs. If a step cannot be done, the rest stop and you are told.',
      'Emails go only to people who may receive them then — consent and opt-outs are checked when each one is sent.',
      `Cancel the task at any time; it ends after ${TASK_LIMITS.days} days at the latest.`,
    ],
  };

  return storeTask(ctx, label, gate.key, { title: input.title, steps, card });
}
