import { mailThread, type Db, type DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';
import { loadContactHead } from '../contacts/get-contact';
import { contactResource } from '../contacts/visibility';
import { recordActivity } from '../contacts/write-contacts';
import { checkEmailLimits, devAllowlistProblem, emailLimitsFromEnv, type EmailLimitCheck, type EmailLimits } from '../email/limits';
import { composeInputSchema, type ComposeInput } from './mail-schema';
import { deliverOutbound, DIRECT_EMAIL_KIND, recordOutbound, type MailDeps } from './send';
import { resolveSender, senderLine } from './sender';
import { MailError } from './threads';

/**
 * A NEW email to a contact (ADR 0035 §1) — until now a conversation could
 * only start with the contact writing to us, or with an invitation.
 *
 * Who: `mail:compose` — the contact's assignee or an owner/admin, never a
 * read-only member; the same person who may answer that contact's mail.
 * What is refused, with the reason: no address, archived, unsubscribed, the
 * development allowlist, today's sending limits. Every check is made again at
 * send; the preview is for the eyes, never a token.
 *
 * It opens a conversation with no lead, so the contact's reply lands in it,
 * and the buyer sees it on the website at an address they proved. The message
 * is recorded queued in a transaction and sent after it (CLAUDE.md), from the
 * author's Gmail when they connected one (ADR 0026), with the contact's
 * unsubscribe link (`deliverOutbound`).
 */

export type ComposeTarget = {
  contact: { id: string; agencyId: string; name: string; email: string | null };
  /** Why it cannot be sent, or null. */
  problem: string | null;
};

export type ComposePreview = ComposeTarget & {
  limits: EmailLimitCheck;
  /** "Sent from your Gmail (…)" / "…LocalAgentHub" — decided as it would be at Send (ADR 0026 §2). */
  sendFrom: string;
};

const NOT_FOUND = () => new MailError('not_found', 'That contact was not found');

/** The contact and every rule that is not about today's numbers. One statement. */
export async function loadComposeTarget(
  db: DbOrTx,
  actor: Actor,
  contactId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ComposeTarget> {
  const head = await loadContactHead(db, actor, contactId);
  if (!head || head.row.mergedIntoId) throw NOT_FOUND();
  const resource = contactResource(head.facts);
  if (!can(actor, 'contact:read', resource)) throw NOT_FOUND();
  const c = head.row;
  const contact = { id: c.id, agencyId: c.agencyId, name: c.name, email: c.email };
  const problem = !can(actor, 'mail:compose', resource)
    ? 'Only the agent this contact is assigned to, or an admin, may email them.'
    : c.archivedAt
      ? 'This contact is archived. Restore them first.'
      : !c.email
        ? 'This contact has no email address.'
        : c.emailOptOutAt
          ? 'They unsubscribed from the agency’s email, so a new email cannot be sent. You can still answer a conversation they start.'
          : devAllowlistProblem(c.email, env);
  return { contact, problem };
}

export async function previewContactEmail(
  db: Db,
  actor: Actor,
  contactId: string,
  limits: EmailLimits = emailLimitsFromEnv(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<ComposePreview> {
  const target = await loadComposeTarget(db, actor, contactId, env);
  const check = await checkEmailLimits(db, { agencyId: target.contact.agencyId, userId: actor.userId }, limits);
  return {
    ...target,
    problem: target.problem ?? check.reason,
    limits: check,
    sendFrom: senderLine(await resolveSender(db, actor)),
  };
}

/**
 * Open the conversation and record the message, queued, in the caller's
 * transaction — the assistant's card runs this inside its claim, a screen
 * inside its own. Every check is made here. Nothing is sent: the caller
 * delivers after the commit.
 */
export async function recordContactEmail(
  tx: DbOrTx,
  deps: MailDeps,
  actor: Actor,
  contactId: string,
  input: unknown,
  opts: { limits?: EmailLimits; env?: NodeJS.ProcessEnv; via?: 'assistant' } = {},
): Promise<{ threadId: string; messageId: string }> {
  const parsed = composeInputSchema.safeParse(input);
  if (!parsed.success) throw new MailError('invalid', parsed.error.issues[0]?.message ?? 'Write a subject and a message');
  const env = opts.env ?? deps.env ?? process.env;
  const target = await loadComposeTarget(tx, actor, contactId, env);
  if (target.problem) throw new MailError('forbidden', target.problem);
  if (!deps.unsubscribe) {
    throw new MailError('invalid', 'A new email must carry an unsubscribe link, and ALERT_UNSUBSCRIBE_SECRET is not set on this server.');
  }
  const check = await checkEmailLimits(tx, { agencyId: target.contact.agencyId, userId: actor.userId }, opts.limits ?? emailLimitsFromEnv(env));
  if (!check.ok) throw new MailError('forbidden', check.reason ?? 'Today’s email limit has been reached.');

  const { subject, body } = parsed.data as ComposeInput;
  const [thread] = await tx
    .insert(mailThread)
    .values({
      agencyId: target.contact.agencyId,
      contactId: target.contact.id,
      subject,
      contactEmail: target.contact.email!.toLowerCase(),
      contactName: target.contact.name,
    })
    .returning({ id: mailThread.id });
  const messageId = await recordOutbound(tx as Db, deps, {
    threadId: thread!.id,
    agencyId: target.contact.agencyId,
    subject,
    to: target.contact.email!,
    body,
    sentBy: actor.userId,
    channel: 'console',
    kind: DIRECT_EMAIL_KIND,
    opening: true,
  });
  // The subject only: the timeline is read by everyone who may see the contact.
  await recordActivity(tx, actor, target.contact.agencyId, target.contact.id, 'email_sent', {
    threadId: thread!.id,
    subject,
    ...(opts.via ? { via: opts.via } : {}),
  });
  return { threadId: thread!.id, messageId };
}

/** The screen's Send: record in one transaction, deliver after it. A failed send stays in the conversation with a Retry. */
export async function sendContactEmail(
  db: Db,
  deps: MailDeps,
  actor: Actor,
  contactId: string,
  input: unknown,
  opts: { limits?: EmailLimits } = {},
): Promise<{ threadId: string; status: 'sent' | 'failed'; error: string | null }> {
  const { threadId, messageId } = await db.transaction((tx) => recordContactEmail(tx, deps, actor, contactId, input, opts));
  const outcome = await deliverOutbound(db, deps, messageId);
  return { threadId, status: outcome.status, error: outcome.error };
}
