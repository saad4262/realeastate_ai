import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { emailTemplate, type Db, type DbOrTx } from '@repo/db';
import { can } from '../permissions';
import { createTemplate, TemplateEmailError } from '../template-email/templates';
import { MERGE_FIELDS, templateInputSchema } from '../template-email/schema';
import { propose, type FrozenArgs } from './actions';
import { AssistantError } from './conversations';
import { figuresIn, NOTHING_YET, refused, WRITTEN_BY_ASSISTANT } from './write-tools';
import type { createTemplateInput, ProposalCard } from './schema';
import type { ToolContext, ToolOutcome } from './tools';

/**
 * A template written in the chat (ADR 0048). The card shows the exact name, subject and body and every
 * figure in them; Approve saves it through the Bulk email screen's own `createTemplate` (ADR 0043: an
 * owner's or admin's is the agency's, an agent's their own), which asks can() again. What the person
 * approved is what a workflow or a bulk send will use — a human has read every word first.
 */

export function templateCard(input: z.infer<typeof createTemplateInput>, agencyWide: boolean): ProposalCard {
  const figures = figuresIn(`${input.subject}\n${input.body}`);
  return {
    title: `Save the email template “${input.name}”`,
    contact: { id: '', name: '' },
    lines: [
      { label: 'Name', value: input.name },
      { label: 'For', value: agencyWide ? 'The whole agency — anyone in it may send it' : 'Only you' },
      { label: 'Subject', value: input.subject },
    ],
    text: { label: 'Email', value: input.body },
    ...(figures.length ? { figures } : {}),
    notes: [
      NOTHING_YET,
      WRITTEN_BY_ASSISTANT,
      `${MERGE_FIELDS.map((f) => `{{${f}}}`).join(', ')} are filled in for each person when it is sent.`,
      'Saving sends nothing. It is ready to use at once (no approval step); each email carries an unsubscribe link and goes only to people who may receive it.',
    ],
  };
}

export async function proposeCreateTemplate(ctx: ToolContext, input: z.infer<typeof createTemplateInput>, label: string): Promise<ToolOutcome> {
  const agencyId = ctx.actor.agencyId;
  if (!agencyId || !can(ctx.actor, 'email_template:draft', { type: 'email_template', agencyId })) {
    return refused('This person may not write email templates. Nothing was proposed.', label);
  }
  const v = templateInputSchema.safeParse(input);
  if (!v.success) return refused(`${v.error.issues[0]?.message ?? 'Check the template'}. Nothing was proposed.`, label);
  const agencyWide = can(ctx.actor, 'email_template:manage', { type: 'email_template', agencyId });
  const args: FrozenArgs = { tool: 'create_template', name: v.data.name, subject: v.data.subject, body: v.data.body };
  return propose(ctx, label, { tool: 'create_template', args, card: templateCard(v.data, agencyWide), contactId: null });
}

export async function runTemplateAction(tx: Db, actor: Parameters<typeof createTemplate>[1], args: Extract<FrozenArgs, { tool: 'create_template' }>): Promise<{ result: Record<string, unknown> }> {
  try {
    const { id } = await createTemplate(tx, actor, { name: args.name, subject: args.subject, body: args.body });
    return { result: { templateId: id } };
  } catch (err) {
    if (err instanceof TemplateEmailError) throw new AssistantError(err.code === 'forbidden' ? 'forbidden' : 'conflict', err.message);
    throw err;
  }
}

export async function verifyTemplateAction(tx: DbOrTx, args: Record<string, unknown>, result: Record<string, unknown>): Promise<boolean> {
  const [t] = await tx
    .select({ id: emailTemplate.id })
    .from(emailTemplate)
    .where(and(eq(emailTemplate.id, String(result.templateId ?? '')), eq(emailTemplate.name, String(args.name ?? '')), eq(emailTemplate.status, 'approved')))
    .limit(1);
  return Boolean(t);
}
