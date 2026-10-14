import { eq } from 'drizzle-orm';
import { agency, notification, proposedAction, user, type Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import { loadComposeTarget } from '../mail/compose';
import { MailError } from '../mail/threads';
import { resolveSender, senderLine } from '../mail/sender';
import { checkEmailLimits, emailLimitsFromEnv } from '../email/limits';
import { figuresIn } from '../assistant/write-tools';
import type { FrozenArgs } from '../assistant/actions';
import type { ProposalCard } from '../assistant/schema';
import { WORKFLOW_LIMITS } from './catalog';

/**
 * A workflow's email, written by the AI (ADR 0041 D1): ALWAYS a draft. It becomes an ordinary
 * `send_email` card for the workflow's owner — the exact words, every figure listed — which only
 * their one click sends, through `recordContactEmail` with every check. It waits in "Waiting for
 * you" and on the bell, and expires after WORKFLOW_LIMITS.draftDays.
 *
 * The model is called here, AFTER the step's transaction — never inside one — through the writer
 * packages/ai hands in (the LLM is never called outside packages/ai). It is given the workflow's
 * instructions and facts the database holds about the contact; never a number to make up.
 */

export type DraftFacts = { contactName: string; contactFirstName: string; listingAddress: string | null; agentName: string; agencyName: string };
export type DraftWriter = (input: { instructions: string; facts: DraftFacts; workflowName: string; agencyId: string; userId: string }) => Promise<{ subject: string; body: string }>;

/** Where the owner finds drafts — their console's Workflows page. */
const waitingHref = (actor: Actor) => (can(actor, 'console:agency', { type: 'console', agencyId: actor.agencyId ?? '' }) ? '/workflows?tab=waiting' : '/my-workflows?tab=waiting');

export async function createWorkflowDraft(
  db: Db,
  actor: Actor,
  stepId: string,
  input: { contactId: string; instructions: string; workflowName: string },
  writer: DraftWriter | null,
  now = new Date(),
): Promise<{ draftId: string } | { draftError: string }> {
  let target;
  try {
    target = await loadComposeTarget(db, actor, input.contactId);
  } catch (err) {
    if (err instanceof MailError) return { draftError: 'That contact is no longer one you can email.' };
    throw err;
  }
  // Refusals a send would give are given now: no draft that could never be sent.
  if (target.problem) return { draftError: `${target.problem} No draft was written.` };
  if (!writer) return { draftError: 'Email drafting is not set up on this server, so no draft was written.' };

  const [who] = await db
    .select({ agent: user.name, agentEmail: user.email, agencyName: agency.name })
    .from(user)
    .innerJoin(agency, eq(agency.id, actor.agencyId ?? ''))
    .where(eq(user.id, actor.userId))
    .limit(1);
  const facts: DraftFacts = {
    contactName: target.contact.name,
    contactFirstName: target.contact.name.trim().split(/\s+/)[0] ?? target.contact.name,
    listingAddress: null,
    agentName: who?.agent || who?.agentEmail || 'your agent',
    agencyName: who?.agencyName || 'the agency',
  };
  const written = await writer({ instructions: input.instructions, facts, workflowName: input.workflowName, agencyId: actor.agencyId ?? '', userId: actor.userId });
  const subject = written.subject.trim().slice(0, 200);
  const body = written.body.trim().slice(0, 5000);
  if (!subject || !body) return { draftError: 'The draft came back empty. Nothing was sent.' };

  const limits = await checkEmailLimits(db, { agencyId: target.contact.agencyId, userId: actor.userId }, emailLimitsFromEnv());
  const figures = figuresIn(`${subject}\n${body}`);
  const card: ProposalCard = {
    title: `Email ${target.contact.name} — a draft from your workflow “${input.workflowName}”`,
    contact: { id: target.contact.id, name: target.contact.name },
    lines: [
      { label: 'To', value: `${target.contact.name} · ${target.contact.email}` },
      { label: 'From', value: senderLine(await resolveSender(db, actor)) },
      { label: 'Subject', value: subject },
      ...(limits.ok ? [] : [{ label: 'Today', value: limits.reason ?? 'Today’s email limit is reached — it can be sent tomorrow' }]),
    ],
    text: { label: 'Email', value: body },
    ...(figures.length ? { figures } : {}),
    notes: [
      'Nothing is sent until you press Approve. A workflow never sends an email the AI wrote.',
      'Written by the assistant. Read every word — names, dates and figures — before you approve; what you approve is what is sent.',
      `This draft goes away after ${WORKFLOW_LIMITS.draftDays} days if you leave it.`,
    ],
  };
  const args: FrozenArgs = { tool: 'send_email', contactId: target.contact.id, subject, body };
  const expiresAt = new Date(now.getTime() + WORKFLOW_LIMITS.draftDays * 86_400_000);
  const id = await db.transaction(async (tx) => {
    const [made] = await tx
      .insert(proposedAction)
      .values({ agencyId: target.contact.agencyId, userId: actor.userId, contactId: target.contact.id, tool: 'send_email', args, card, origin: 'workflow', idempotencyKey: `wfdraft:${stepId}`, expiresAt })
      .onConflictDoNothing({ target: proposedAction.idempotencyKey })
      .returning({ id: proposedAction.id });
    const draftId = made?.id ?? (await tx.select({ id: proposedAction.id }).from(proposedAction).where(eq(proposedAction.idempotencyKey, `wfdraft:${stepId}`)).limit(1))[0]!.id;
    await tx
      .insert(notification)
      .values({ userId: actor.userId, agencyId: target.contact.agencyId, kind: 'workflow_draft', title: `A draft email to ${target.contact.name} is waiting for you`.slice(0, 300), href: waitingHref(actor), dedupeKey: `wfdraft:${stepId}` })
      .onConflictDoNothing();
    return draftId;
  });
  return { draftId: id };
}
