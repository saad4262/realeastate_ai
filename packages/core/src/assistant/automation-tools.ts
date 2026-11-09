import type { z } from 'zod';
import { emailLimitsFromEnv } from '../email/limits';
import { can } from '../permissions';
import { AUTOMATION_LIMITS, automationWords, type AutomationDraft } from '../recurring/kinds';
import { classifyRecipients, mergeValuesFor } from '../template-email/batches';
import { renderMerge } from '../template-email/schema';
import { TemplateEmailError } from '../template-email/templates';
import { propose, type FrozenArgs } from './actions';
import { resolveHandle } from './handles';
import type { createAutomationInput, ProposalCard } from './schema';
import { scheduleWords } from './skill-tools';
import type { ToolContext, ToolOutcome } from './tools';
import { NOTHING_YET, refused, UNKNOWN_REF } from './write-tools';

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/**
 * A repeating bulk email, from the Bulk email chat (ADR 0089). The card shows the template, the list and the schedule; the person
 * approves once and it runs by itself. Every run checks everyone again, so this only says who could receive it today.
 */
export async function proposeCreateAutomation(ctx: ToolContext, input: z.infer<typeof createAutomationInput>, label: string): Promise<ToolOutcome> {
  const { actor, db } = ctx;
  if (!actor.agencyId || !can(actor, 'automation:create', { type: 'automation', agencyId: actor.agencyId, ownerId: actor.userId })) {
    return refused('This person cannot create automations.', label);
  }
  const templateId = resolveHandle(ctx.handles, input.template, 'template');
  const filterId = resolveHandle(ctx.handles, input.list, 'filter');
  if (!templateId || !filterId) return refused(UNKNOWN_REF, label);

  let c;
  try {
    c = await classifyRecipients(db, actor, { templateId, filterId }, { ...emailLimitsFromEnv(), perBatch: AUTOMATION_LIMITS.peoplePerRun });
  } catch (err) {
    if (err instanceof TemplateEmailError) return refused(err.message, label);
    throw err;
  }
  if (!c.filter) return refused('That list could not be found.', label);

  const [h, m] = input.schedule.time.split(':').map(Number) as [number, number];
  const schedule = {
    cadence: input.schedule.cadence,
    sendAtMinute: h * 60 + m,
    sendOnWeekday: input.schedule.cadence === 'weekly' && input.schedule.weekday ? WEEKDAYS.indexOf(input.schedule.weekday) : null,
    intervalMinutes: input.schedule.cadence === 'interval' ? (input.schedule.every_minutes ?? null) : null,
    timezone: ctx.timeZone,
  };
  const spec = { templateId, templateName: c.template.name, filterId, listName: c.filter.name };
  const draft: AutomationDraft = { kind: 'bulk_email', name: input.name, spec, ...schedule, conversationId: ctx.proposal?.conversationId ?? null };

  const going = c.recipients.filter((r) => r.status === 'queued');
  const first = going[0];
  const values = first ? (await mergeValuesFor(db, { agencyId: c.agencyId, userId: actor.userId }))(first.name) : null;
  const card: ProposalCard = {
    title: `Set up the automation “${input.name}”`,
    contact: { id: '', name: '' },
    lines: [
      { label: 'What it does', value: automationWords('bulk_email', spec) },
      { label: 'When', value: scheduleWords(schedule) },
      { label: 'Who today', value: `${going.length} could receive it today · ${c.recipients.length - going.length} could not` },
      { label: 'Subject', value: values ? renderMerge(c.template.subject, values) : c.template.subject },
    ],
    ...(values && first ? { text: { label: `Email to ${first.name} (each person gets their own name)`, value: renderMerge(c.template.body, values) } } : {}),
    notes: [
      NOTHING_YET,
      'Once you approve this, it sends by itself every time, with no further click from you.',
      'Every run checks everyone again: consent, unsubscribes, archiving and the day’s email limits. A run that reaches a limit stops there and says so.',
      'Turn it off any time in Skills, on the Automations tab.',
    ],
  };
  const args: FrozenArgs = { tool: 'create_workflow', automation: draft };
  return propose(ctx, label, { tool: 'create_workflow', args, card, contactId: null });
}
