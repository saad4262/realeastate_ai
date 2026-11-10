import type { z } from 'zod';
import { checkEmailLimits, emailLimitsFromEnv } from '../email/limits';
import { loadSmsRules } from '../phone/sms-rules';
import { can } from '../permissions';
import { AUTOMATION_LIMITS, automationWords, type AutomationDraft } from '../recurring/kinds';
import { classifyRecipients, mergeValuesFor } from '../template-email/batches';
import { classifySmsRecipients } from '../template-email/sms-batches';
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

  const isSms = ctx.chatScope === 'sms';
  let c;
  try {
    c = isSms
      ? await classifySmsRecipients(db, actor, { templateId, filterId, maxPeople: AUTOMATION_LIMITS.peoplePerRun })
      : await classifyRecipients(db, actor, { templateId, filterId }, { ...emailLimitsFromEnv(), perBatch: AUTOMATION_LIMITS.peoplePerRun });
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
  const kind = isSms ? 'bulk_sms' : 'bulk_email';
  const draft: AutomationDraft = { kind, name: input.name, spec, ...schedule, conversationId: ctx.proposal?.conversationId ?? null };

  const going = c.recipients.filter((r) => r.status === 'queued');

  // One run must fit in a day's limit: told plainly here, never found out by a run that stops (the user, 2026-11-10).
  let limitLine: { label: string; value: string };
  if (isSms) {
    const rules = await loadSmsRules(db, actor.agencyId);
    const perNumber = new Map<string, number>();
    for (const r of going) {
      const id = (r as { phoneNumberId?: string | null }).phoneNumberId ?? 'none';
      perNumber.set(id, (perNumber.get(id) ?? 0) + 1);
    }
    const most = Math.max(0, ...perNumber.values());
    if (most > rules.perNumber) {
      return { label, result: { proposed: false, tell_the_user: `Each run would send ${most} texts from one number, more than its daily limit of ${rules.perNumber}. Nothing was set up. Suggest a smaller list, or ask an owner to raise the limit in Missed calls → Settings.` } };
    }
    limitLine = { label: 'Daily limit', value: `Each run uses up to ${most} of a number’s ${rules.perNumber} texts a day` };
  } else {
    const limits = emailLimitsFromEnv(ctx.env);
    const n = going.length;
    if (n > limits.perAgentDay || n > limits.perAgencyDay) {
      const which = n > limits.perAgentDay ? `your daily limit of ${limits.perAgentDay}` : `the agency’s daily limit of ${limits.perAgencyDay}`;
      return { label, result: { proposed: false, tell_the_user: `Each run would send ${n} emails, more than ${which} (yours is ${limits.perAgentDay} a day, the agency’s ${limits.perAgencyDay}). Nothing was set up. Suggest a smaller list, or ask an owner to raise the limit.` } };
    }
    const today = await checkEmailLimits(db, { agencyId: actor.agencyId, userId: actor.userId }, limits, 0);
    limitLine = { label: 'Daily limit', value: `Each run uses ${n} of your ${limits.perAgentDay} emails a day · ${today.agentUsed} sent so far today. Other sends that day count against it too` };
  }
  const first = going[0];
  const values = first ? (await mergeValuesFor(db, { agencyId: c.agencyId, userId: actor.userId }))(first.name) : null;
  const card: ProposalCard = {
    title: `Set up the automation “${input.name}”`,
    contact: { id: '', name: '' },
    lines: [
      { label: 'What it does', value: automationWords(kind, spec) },
      { label: 'When', value: scheduleWords(schedule) },
      { label: 'Who today', value: `${going.length} could receive it today · ${c.recipients.length - going.length} could not` },
      limitLine,
      ...('subject' in c.template ? [{ label: 'Subject', value: values ? renderMerge(c.template.subject, values) : c.template.subject }] : []),
    ],
    ...(values && first ? { text: { label: `${isSms ? 'Text' : 'Email'} to ${first.name} (each person gets their own name)`, value: renderMerge(c.template.body, values) } } : {}),
    notes: [
      NOTHING_YET,
      'Once you approve this, it sends by itself every time, with no further click from you.',
      isSms
        ? 'Every run checks everyone again: consent, STOP replies and the day’s limits. Texts only go in sending hours.'
        : 'Every run checks everyone again: consent, unsubscribes, archiving and the day’s email limits. A run that reaches a limit stops there and says so.',
      'Turn it off any time in Skills, on the Automations tab.',
    ],
  };
  const args: FrozenArgs = { tool: 'create_workflow', automation: draft };
  return propose(ctx, label, { tool: 'create_workflow', args, card, contactId: null });
}
