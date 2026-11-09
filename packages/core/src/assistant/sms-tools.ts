import type { z } from 'zod';
import { can } from '../permissions';
import { SMS_SKIP_REASON_LABELS } from '../phone/sms-rules';
import { cancelBatch, getBatch } from '../template-email/batches';
import { prepareSmsBatch } from '../template-email/sms-batches';
import { TemplateEmailError } from '../template-email/templates';
import { propose, type FrozenArgs } from './actions';
import { resolveHandle } from './handles';
import type { ProposalCard, sendTemplateSmsInput } from './schema';
import type { ToolContext, ToolOutcome } from './tools';
import { NOTHING_YET, refused, UNKNOWN_REF } from './write-tools';

/**
 * A bulk text from the Bulk SMS chat (ADR 0088): the screen's own Prepare, a card with every name, and the
 * screen's own Approve. Every SMS rule is the batch's, and is checked again per person when it is sent.
 */
export async function proposeSendTemplateSms(ctx: ToolContext, input: z.infer<typeof sendTemplateSmsInput>, label: string): Promise<ToolOutcome> {
  const { actor, db } = ctx;
  if (!actor.agencyId || !can(actor, 'email_batch:create', { type: 'email_batch', agencyId: actor.agencyId })) {
    return refused('This person cannot send bulk SMS.', label);
  }
  const templateId = resolveHandle(ctx.handles, input.template, 'template');
  if (!templateId) return refused(UNKNOWN_REF, label);

  let target: { filterId: string } | { contactIds: string[] };
  if (input.list) {
    const filterId = resolveHandle(ctx.handles, input.list, 'filter');
    if (!filterId) return refused(UNKNOWN_REF, label);
    target = { filterId };
  } else {
    const contactIds: string[] = [];
    for (const ref of input.recipients ?? []) {
      const id = resolveHandle(ctx.handles, ref, 'contact');
      if (!id) return refused(`${ref}: ${UNKNOWN_REF}`, label);
      contactIds.push(id);
    }
    target = { contactIds: [...new Set(contactIds)] };
  }

  let prepared: { id: string; notFound: number };
  try {
    prepared = await prepareSmsBatch(db, actor, { templateId, ...target }, ctx.now);
  } catch (err) {
    if (err instanceof TemplateEmailError) return refused(err.message, label);
    throw err;
  }

  const batch = await getBatch(db, actor, prepared.id, ctx.now, { channel: 'sms' });
  const reasons = SMS_SKIP_REASON_LABELS as Readonly<Record<string, string>>;
  const people = batch.recipients.map((r) => ({
    name: r.name,
    email: r.phone ?? null,
    willReceive: r.status === 'queued',
    reason: r.skipReason ? (reasons[r.skipReason] ?? r.skipReason) : null,
  }));

  if (batch.counts.toSend === 0) {
    await cancelBatch(db, actor, batch.id).catch(() => undefined);
    return { label, result: { proposed: false, tell_the_user: 'Nobody on that list can receive this text right now, so nothing was proposed.', skipped: people.map((p) => ({ name: p.name, why: p.reason })) } };
  }

  const first = batch.recipients.find((r) => r.status === 'queued')!;
  const n = batch.counts.toSend;
  const card: ProposalCard = {
    title: `Text “${batch.template.name}” to ${n} ${n === 1 ? 'person' : 'people'}`,
    contact: { id: first.contactId, name: first.name },
    lines: [
      { label: 'Template', value: batch.template.name },
      { label: 'Recipients', value: `${n} will receive it${batch.counts.skipped ? ` · ${batch.counts.skipped} skipped (see below)` : ''}` },
      { label: 'Sent from', value: 'Each contact’s agent’s number, in sending hours' },
    ],
    text: { label: `Text to ${first.name} (each person gets their own name)`, value: batch.preview?.body ?? batch.template.body },
    people,
    notes: [
      NOTHING_YET,
      'At the moment of sending, consent, STOP replies, the sending hours and today’s limits are checked again. Anyone who no longer qualifies is skipped and shown on Bulk SMS.',
      ...(prepared.notFound ? [`${prepared.notFound} of the people asked for could not be found for you and are not on the list.`] : []),
    ],
  };
  const args: FrozenArgs = { tool: 'send_template_sms', batchId: batch.id, templateId: batch.template.templateId, contactIds: batch.recipients.map((r) => r.contactId) };
  return propose(ctx, label, { tool: 'send_template_sms', args, card, contactId: first.contactId });
}
