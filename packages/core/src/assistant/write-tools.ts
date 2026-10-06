import { can } from '../permissions';
import { loadContactHead } from '../contacts/get-contact';
import { contactResource } from '../contacts/visibility';
import { formatInZone, localDateTimeToInstant } from '../time/local-input';
import { propose, type FrozenArgs } from './actions';
import { resolveHandle } from './handles';
import type { ProposalCard } from './schema';
import type { addNoteInput, setNextActionInput } from './schema';
import type { ToolContext, ToolOutcome } from './tools';
import type { z } from 'zod';

/**
 * The assistant's WRITE tools (ADR 0025 §8; Phase B: notes and next action).
 * Each one only PROPOSES: it resolves the model's
 * references through the conversation's own map, asks can() as the person,
 * builds the card from the database, and stores the frozen, resolved
 * arguments. The same core function a screen uses runs it later — only when
 * the person presses Approve — and asks can() again.
 */

const UNKNOWN_REF = 'That reference is not one you were given in this conversation. Use a reference from an earlier result.';
const NO_CONTACT = 'That contact is not available to this person.';

function refused(message: string, label: string): ToolOutcome {
  return { result: { error: message }, isError: true, label };
}

/** The contact behind a reference, if this person may see it now. */
async function visibleContact(ctx: ToolContext, ref: string) {
  const id = resolveHandle(ctx.handles, ref, 'contact');
  if (!id) return { error: UNKNOWN_REF } as const;
  const head = await loadContactHead(ctx.db, ctx.actor, id);
  if (!head || head.row.mergedIntoId) return { error: NO_CONTACT } as const;
  const resource = contactResource(head.facts);
  if (!can(ctx.actor, 'contact:read', resource)) return { error: NO_CONTACT } as const;
  return { head, resource } as const;
}

function when(instant: Date, tz: string): string {
  return formatInZone(instant, tz);
}

const NOTHING_YET = 'Nothing happens until you press Approve.';

export async function proposeAddNote(ctx: ToolContext, input: z.infer<typeof addNoteInput>, label: string): Promise<ToolOutcome> {
  const c = await visibleContact(ctx, input.contact);
  if ('error' in c) return refused(c.error!, label);
  if (!can(ctx.actor, 'note:create', c.resource)) return refused('This person can read that contact but not add notes to it.', label);
  const name = c.head.row.name;
  const card: ProposalCard = {
    title: `Add a ${input.private ? 'private ' : ''}note to ${name}`,
    contact: { id: c.head.row.id, name },
    lines: [
      { label: 'Contact', value: name },
      { label: 'Who can read it', value: input.private ? 'Only you and the agency’s owners and admins (private)' : 'Everyone who can see this contact' },
    ],
    text: { label: 'Note', value: input.body },
    notes: [NOTHING_YET],
  };
  const args: FrozenArgs = { tool: 'add_note', contactId: c.head.row.id, body: input.body, private: input.private };
  return propose(ctx, label, { tool: 'add_note', args, card, contactId: c.head.row.id });
}

export async function proposeSetNextAction(ctx: ToolContext, input: z.infer<typeof setNextActionInput>, label: string): Promise<ToolOutcome> {
  const c = await visibleContact(ctx, input.contact);
  if ('error' in c) return refused(c.error!, label);
  if (!can(ctx.actor, 'contact:update', c.resource)) {
    return refused('Only the agent this contact is assigned to, or an admin, may change its next action.', label);
  }
  let at: Date | null = null;
  if (input.date) {
    at = localDateTimeToInstant(input.date, input.time ?? '09:00', ctx.timeZone);
    if (!at) return refused('That date or time is not valid.', label);
  }
  const row = c.head.row;
  const current = row.nextAction
    ? `${row.nextAction}${row.nextActionAt ? ` (due ${when(new Date(row.nextActionAt), ctx.timeZone)})` : ''}`
    : 'None';
  const card: ProposalCard = {
    title: input.text ? `Set the next action for ${row.name}` : `Clear the next action for ${row.name}`,
    contact: { id: row.id, name: row.name },
    lines: [
      { label: 'Contact', value: row.name },
      { label: 'Now', value: current },
      { label: 'Due', value: at ? when(at, ctx.timeZone) : 'No date' },
    ],
    text: { label: 'New next action', value: input.text || '(cleared)' },
    notes: [NOTHING_YET],
  };
  const args: FrozenArgs = {
    tool: 'set_next_action',
    contactId: row.id,
    nextAction: input.text || null,
    nextActionAt: at ? at.toISOString() : null,
  };
  return propose(ctx, label, { tool: 'set_next_action', args, card, contactId: row.id });
}
