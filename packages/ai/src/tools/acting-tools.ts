import { z } from 'zod';
import { AU_STATES, PROPERTY_TYPES } from '@repo/core/listings';
import { describeTaskInput, signTaskProposal, TASK_SECTION_TEXT, TASK_SECTIONS, taskInputSchema } from '@repo/core/tasks';
import { automationInputSchema, describeAutomation, signAutomationProposal } from '@repo/core/automation';
import type { ToolContext, ToolOutcome } from './context';

/**
 * C8 in the guide (ADR 0080, decision 12): three tools that PROPOSE and never act. Each returns a card — a message the
 * visitor edits and sends, a task or an automation they Accept — described by the server, signed, and saved or sent
 * only when they press the button. The model is told so in every result.
 */

const AU_ZONES = new Set(['Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Australia/Adelaide', 'Australia/Darwin', 'Australia/Perth', 'Australia/Hobart']);
const zone = (z_: string | undefined) => (z_ && AU_ZONES.has(z_) ? z_ : 'Australia/Sydney');
const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
};

export const draftMessageInput = z.object({ listingId: z.string().uuid() }).strip();

export async function runDraftMessage(input: z.infer<typeof draftMessageInput>, ctx: ToolContext): Promise<ToolOutcome> {
  const label = 'Drafting your message…';
  const draft = await ctx.draftMessage(input.listingId);
  if ('error' in draft) return { label, isError: true, result: { error: draft.error, instruction: 'Tell the visitor this in one sentence.' } };
  return {
    label,
    result: {
      drafted: true,
      to: draft.agencyName,
      about: draft.address,
      sentToday: draft.sentToday,
      perDay: draft.perDay,
      instruction: `The draft is on the visitor's screen in a card. Say in one or two sentences that you have drafted it, that they can change anything, and that nothing goes to ${draft.agencyName} until they press Send. Do NOT repeat the message, and never say it was sent.`,
    },
    actingDraft: { kind: 'message', token: draft.token, title: `To ${draft.agencyName} about ${draft.address}`, lines: [], text: draft.text, to: draft.agencyName, listingId: draft.listingId, sentToday: draft.sentToday, perDay: draft.perDay },
  };
}

export const draftTaskInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    suburb: z.string().trim().min(1).max(80).optional(),
    state: z.enum(AU_STATES).optional(),
    channel: z.enum(['sale', 'rent']).optional(),
    priceTo: z.number().int().positive().max(100_000_000).optional(),
    bedrooms: z.number().int().min(0).max(20).optional(),
    propertyType: z.enum(PROPERTY_TYPES).optional(),
    sections: z.array(z.enum(TASK_SECTIONS)).min(1).max(4),
    cadence: z.enum(['once', 'daily', 'weekly']),
    atTime: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time like 07:00'),
    weekday: z.number().int().min(0).max(6).optional(),
    timezone: z.string().max(64).optional(),
  })
  .strip();

export async function runDraftTask(input: z.infer<typeof draftTaskInput>, ctx: ToolContext): Promise<ToolOutcome> {
  const label = 'Setting up a task for you to check…';
  if (!ctx.proposalSecret) return { label, isError: true, result: { error: 'Tasks cannot be set up on this site just now.' } };
  const parsed = taskInputSchema.safeParse({
    name: input.name,
    area: { ...(input.suburb ? { suburb: input.suburb } : {}), ...(input.state ? { state: input.state } : {}), channel: input.channel ?? 'sale', ...(input.priceTo ? { priceTo: input.priceTo } : {}), ...(input.bedrooms !== undefined ? { bedrooms: input.bedrooms } : {}), ...(input.propertyType ? { propertyType: input.propertyType } : {}) },
    sections: input.sections,
    cadence: input.cadence,
    sendAtMinute: minutes(input.atTime),
    ...(input.weekday !== undefined ? { sendOnWeekday: input.weekday } : {}),
    timezone: zone(input.timezone),
  });
  if (!parsed.success) return { label, isError: true, result: { error: parsed.error.issues[0]?.message ?? 'That task does not fit.', instruction: 'Ask the visitor for what is missing, then try again.' } };
  const card = describeTaskInput(parsed.data);
  return {
    label,
    result: { proposed: true, name: card.name, when: card.when, instruction: 'The task is on screen as a card. Say that it starts only when they press Accept, and never that it is running.' },
    actingDraft: { kind: 'task', token: signTaskProposal(parsed.data, ctx.proposalSecret), title: card.name, lines: [card.when, card.area, ...card.sections.map((s) => TASK_SECTION_TEXT[s].pick)] },
  };
}

export const draftAutomationInput = z
  .object({
    trigger: z.enum(['price_reduced', 'open_home_added', 'under_offer', 'sold', 'not_advertised', 'listed']),
    scope: z.enum(['shortlist', 'watched', 'both']),
    action: z.enum(['tell', 'shortlist_add', 'shortlist_remove']),
    delivery: z.enum(['daily', 'instant']).optional(),
    timezone: z.string().max(64).optional(),
  })
  .strip();

export async function runDraftAutomation(input: z.infer<typeof draftAutomationInput>, ctx: ToolContext): Promise<ToolOutcome> {
  const label = 'Setting up an automation for you to check…';
  if (!ctx.proposalSecret) return { label, isError: true, result: { error: 'Automations cannot be set up on this site just now.' } };
  const parsed = automationInputSchema.safeParse({ trigger: input.trigger, scope: input.scope, action: input.action, delivery: input.delivery ?? 'daily', timeZone: zone(input.timezone) });
  if (!parsed.success) return { label, isError: true, result: { error: parsed.error.issues[0]?.message ?? 'That automation does not fit.', instruction: 'Explain in one sentence what can be automated: telling them, or adding to or taking off their own shortlist. Nothing can write to an agent.' } };
  const words = describeAutomation(parsed.data);
  return {
    label,
    result: { proposed: true, when: words.when, then: words.then, instruction: 'The automation is on screen as a card. Say that it starts only when they press Accept, and never that it is running.' },
    actingDraft: { kind: 'automation', token: signAutomationProposal(parsed.data, ctx.proposalSecret), title: `${words.when} → ${words.then.split(' · ')[0]}`, lines: [words.then.split(' · ')[1] ?? ''] },
  };
}
