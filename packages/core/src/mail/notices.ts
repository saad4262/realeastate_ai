import { and, eq, sql } from 'drizzle-orm';
import { lead, listingAgent, mailMessage, mailThread, membership, user, type Db } from '@repo/db';
import { buildReplyNoticeEmail } from '../email';
import { can, type Actor, type MembershipRole } from '../permissions';
import type { LeadKind } from '../leads/list-leads';
import { loadLeadContext } from '../leads/lead-context';
import { threadReplyAddress } from './address';
import { stripQuotedReply } from './body';
import type { MailDeps } from './send';
import { mayReadThread, type ThreadAccessFacts } from './threads';

/**
 * "They wrote back" — to the people working the conversation.
 *
 * Who, in order: the lead's assignee; else the active agents named on its
 * listing; else whoever may read the whole inbox (owners and admins). Mail to
 * the agency's own address goes to that last group. The same fallback as a
 * new enquiry's notice, so a reply never lands where nobody hears about it.
 *
 * Every candidate is then asked `mayReadThread` — the console's own question —
 * so an email never shows a conversation the screen would refuse. The notice
 * carries the thread's signed Reply-To: answering it from Gmail answers the
 * buyer (see inbound.ts).
 */

export type ThreadNoticeDeps = MailDeps & {
  /** Origins of the two console hosts, and the public site for property links. */
  urls: { agentUrl: string; agencyUrl: string; webUrl?: string };
};

export async function notifyThreadReply(
  db: Db,
  deps: ThreadNoticeDeps,
  threadId: string,
  messageId: string,
): Promise<{ sent: number; failed: number }> {
  const [facts] = await db
    .select({
      id: mailThread.id,
      agencyId: mailThread.agencyId,
      leadId: mailThread.leadId,
      leadKind: lead.kind,
      assignedTo: lead.assignedTo,
      listingId: lead.listingId,
      subject: mailThread.subject,
      contactName: mailThread.contactName,
      contactEmail: mailThread.contactEmail,
      text: mailMessage.text,
    })
    .from(mailMessage)
    .innerJoin(mailThread, eq(mailThread.id, mailMessage.threadId))
    .leftJoin(lead, eq(lead.id, mailThread.leadId))
    .where(and(eq(mailMessage.id, messageId), eq(mailMessage.threadId, threadId)))
    .limit(1);
  if (!facts) return { sent: 0, failed: 0 };

  const thread: ThreadAccessFacts = {
    id: facts.id,
    agencyId: facts.agencyId,
    leadId: facts.leadId,
    leadKind: (facts.leadKind as LeadKind | null) ?? null,
    assignedTo: facts.assignedTo,
    listingId: facts.listingId,
  };

  // Every active member, once, with whether they are on the listing. A small
  // set, and one statement; who among them hears is decided below by can().
  const members = await db
    .select({
      userId: user.id,
      email: user.email,
      name: user.name,
      role: membership.role,
      onListing: thread.listingId
        ? sql<boolean>`exists (
            select 1 from ${listingAgent}
            where ${listingAgent.listingId} = ${thread.listingId}
              and ${listingAgent.userId} = ${user.id}
          )`
        : sql<boolean>`false`,
    })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(and(eq(membership.agencyId, thread.agencyId), eq(membership.status, 'active')));

  const people = members.map((m) => {
    const onListing = m.onListing === true || (m.onListing as unknown) === 't';
    const actor: Actor = {
      userId: m.userId,
      agencyId: thread.agencyId,
      membershipRole: m.role as MembershipRole,
      ...(onListing && thread.listingId ? { listingAgentOf: [thread.listingId] } : {}),
    };
    return { ...m, onListing, actor };
  });

  const inbox = { type: 'mail_thread', agencyId: thread.agencyId };
  const admins = people.filter((p) => can(p.actor, 'lead:read_all', inbox));
  const assigned = thread.leadId ? people.filter((p) => p.userId === thread.assignedTo) : [];
  const onListing = thread.leadId ? people.filter((p) => p.onListing) : [];

  const chosen = assigned.length > 0 ? assigned : onListing.length > 0 ? onListing : admins;
  const recipients = chosen.filter((p) => mayReadThread(p.actor, thread));

  const { sender, transport } = deps.mailer;
  const replyTo = deps.config
    ? { email: threadReplyAddress(thread.id, deps.config), name: facts.contactName || facts.contactEmail }
    : null;
  const body = stripQuotedReply(facts.text) || '(no text)';

  // What the lead is about, under the reply — one more read, only when there
  // is somebody to tell.
  const context = recipients.length > 0 && thread.leadId ? await loadLeadContext(db, thread.leadId) : null;
  const web = deps.urls.webUrl;
  const details = context
    ? {
        ...context,
        propertyUrl: web
          ? context.listing && context.kind !== 'offer'
            ? `${web}/listing/${context.listing.id}`
            : `${web}/property/${context.propertyId}`
          : null,
      }
    : undefined;

  const outcome = { sent: 0, failed: 0 };
  for (const person of recipients) {
    const threadUrl = can(person.actor, 'lead:read_all', inbox)
      ? `${deps.urls.agencyUrl}/inbox?thread=${thread.id}`
      : `${deps.urls.agentUrl}/my-inbox?thread=${thread.id}`;
    const result = await transport.send(
      buildReplyNoticeEmail({
        to: { email: person.email, ...(person.name ? { name: person.name } : {}) },
        from: sender.from,
        replyTo,
        postalAddress: sender.postalAddress,
        subject: facts.subject,
        writer: facts.contactName || facts.contactEmail,
        body,
        threadUrl,
        ...(details ? { details } : {}),
      }),
    );
    if (result.ok) outcome.sent += 1;
    else {
      outcome.failed += 1;
      console.error(`[mail] reply notice for thread ${thread.id} not sent: ${result.error}`);
    }
  }
  return outcome;
}
