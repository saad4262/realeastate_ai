import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  agency,
  lead,
  listingAgent,
  mailMessage,
  mailThread,
  membership,
  user,
  type Db,
} from '@repo/db';
import type { Actor, MembershipRole } from '../permissions';
import type { LeadKind } from '../leads/list-leads';
import {
  bareAddress,
  displayName,
  parseAgencyMailAddress,
  parseTeamReplyAddress,
  parseThreadReplyAddress,
  type MailConfig,
} from './address';
import { ingestTeamReply } from '../team-messages/messages';
import { decodeHtmlField, htmlToText, stripQuotedReply } from './body';
import { receivedEmailSchema, type AttachmentNote, type ReceivedEmail } from './mail-schema';
import { recordOutbound, type MailDeps } from './send';
import {
  maySendOnThread,
  threadContactColumns,
  threadContactFacts,
  type ThreadAccessFacts,
} from './threads';

/**
 * Mail arriving at MAIL_INBOUND_DOMAIN (docs/adr/0016).
 *
 * ## Where it goes
 *
 * Only two things route a message, and both are addresses WE minted:
 *  1. a signed reply address `t+<thread>.<sig>@…` → that thread;
 *  2. an agency's own address `<slug>@…` → a conversation with no lead,
 *     which only that agency's admins see.
 * Headers like `In-Reply-To` route nothing: anybody can write one.
 * Anything else is dropped as `unrouted`.
 *
 * ## Who wrote it
 *
 * On a thread, the sender is one of three people:
 *  - the contact → stored as received; the people on the lead are told;
 *  - an active member of the agency who may send on this thread, and whose
 *    mail passed DMARC → their reply is RELAYED to the contact, quoted history
 *    cut. This is what keeps Gmail in step: an agent answers the notice from
 *    their phone and the buyer gets it, and the console shows it;
 *  - anybody else, or a member whose mail could not be verified → stored as
 *    received and NOT relayed, with the reason on the row. A From header is
 *    trivially forged; only DMARC says the domain stood behind it.
 */

export type IngestOutcome =
  | { kind: 'duplicate' }
  | { kind: 'unrouted' }
  | { kind: 'stored'; threadId: string; messageId: string; notify: boolean }
  | { kind: 'relay'; threadId: string; messageId: string }
  /** A colleague answering a team message from their mail (ADR 0035 §3): tell the others. */
  | { kind: 'team'; threadId: string; messageId: string }
  /** Mail to a team address that was not accepted — never stored. */
  | { kind: 'dropped' };

const RESEND_RECEIVING = 'https://api.resend.com/emails/receiving';

/**
 * The full received email. The webhook carries only routing facts, never the
 * body, so this is one GET — made BEFORE any transaction opens.
 */
export async function fetchReceivedEmail(
  emailId: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReceivedEmail> {
  const response = await fetchImpl(`${RESEND_RECEIVING}/${encodeURIComponent(emailId)}`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Resend ${response.status} fetching received email ${emailId}`);
  }
  return receivedEmailSchema.parse(await response.json());
}

/** Every address the message was delivered for, de-duplicated. */
function recipientsOf(email: ReceivedEmail): string[] {
  return [...new Set([...email.to, ...email.cc, ...email.received_for].map(bareAddress))];
}

/** A signed thread address wins over an agency address on the same message. */
export function routeRecipients(
  recipients: string[],
  config: MailConfig,
): { threadId: string } | { teamThreadId: string } | { agencySlug: string } | null {
  for (const address of recipients) {
    const threadId = parseThreadReplyAddress(address, config);
    if (threadId) return { threadId };
  }
  for (const address of recipients) {
    const teamThreadId = parseTeamReplyAddress(address, config);
    if (teamThreadId) return { teamThreadId };
  }
  for (const address of recipients) {
    const agencySlug = parseAgencyMailAddress(address, config);
    if (agencySlug) return { agencySlug };
  }
  return null;
}

function headerValue(email: ReceivedEmail, name: string): string | null {
  const value = email.headers?.[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

function attachmentNotes(email: ReceivedEmail): AttachmentNote[] {
  return (email.attachments ?? []).map((a) => ({
    filename: a.filename || 'attachment',
    contentType: a.content_type ?? null,
    size: typeof a.size === 'number' ? a.size : null,
  }));
}

/** "Re: Fwd: Hello" → "hello": how a second email on one subject finds the first. */
function subjectKey(subject: string): string {
  return subject.replace(/^((re|fwd?|aw)\s*:\s*)+/i, '').trim().toLowerCase();
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

type ThreadFacts = ThreadAccessFacts & {
  contactEmail: string;
  subject: string;
  /** A conversation with no row yet — made with its first message. */
  isNew?: boolean;
};

async function threadFacts(db: Db, threadId: string): Promise<ThreadFacts | null> {
  const [row] = await db
    .select({
      id: mailThread.id,
      agencyId: mailThread.agencyId,
      leadId: mailThread.leadId,
      leadKind: lead.kind,
      assignedTo: lead.assignedTo,
      listingId: lead.listingId,
      contactEmail: mailThread.contactEmail,
      subject: mailThread.subject,
      ...threadContactColumns(),
    })
    .from(mailThread)
    .leftJoin(lead, eq(lead.id, mailThread.leadId))
    .where(eq(mailThread.id, threadId))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    agencyId: row.agencyId,
    leadId: row.leadId,
    leadKind: (row.leadKind as LeadKind | null) ?? null,
    assignedTo: row.assignedTo,
    listingId: row.listingId,
    contactEmail: row.contactEmail,
    subject: row.subject,
    contact: threadContactFacts(row),
  };
}

/**
 * The agency's conversation with this sender about this subject, or a new one.
 * Mail to the agency address has no lead; a second email on the same subject
 * joins the first rather than opening another.
 */
async function generalThreadFor(
  db: Db,
  agencySlug: string,
  from: string,
  fromName: string | null,
  subject: string,
): Promise<ThreadFacts | null> {
  const [found] = await db
    .select({ id: agency.id })
    .from(agency)
    .where(eq(agency.slug, agencySlug))
    .limit(1);
  if (!found) return null;

  const key = subjectKey(subject);
  const candidates = await db
    .select({ id: mailThread.id, subject: mailThread.subject })
    .from(mailThread)
    .where(
      and(
        eq(mailThread.agencyId, found.id),
        isNull(mailThread.leadId),
        eq(mailThread.contactEmail, from),
      ),
    )
    .orderBy(desc(mailThread.lastMessageAt))
    .limit(20);
  const match = candidates.find((c) => subjectKey(c.subject) === key);
  if (match) {
    return {
      id: match.id,
      agencyId: found.id,
      leadId: null,
      leadKind: null,
      assignedTo: null,
      listingId: null,
      contactEmail: from,
      subject: match.subject,
    };
  }

  // Not written here: the new thread is inserted in the same transaction as
  // its first message, so a failure cannot leave an empty conversation behind.
  return {
    id: '',
    agencyId: found.id,
    leadId: null,
    leadKind: null,
    assignedTo: null,
    listingId: null,
    contactEmail: from,
    subject: subject.trim() || '(no subject)',
    isNew: true,
  };
}

/** An active member of this agency with this address, as can() would see them on this thread. */
async function memberBehind(db: Db, thread: ThreadFacts, from: string): Promise<Actor | null> {
  const [row] = await db
    .select({
      userId: user.id,
      role: membership.role,
      onListing: thread.listingId
        ? sql<boolean>`exists (
            select 1 from ${listingAgent}
            where ${listingAgent.listingId} = ${thread.listingId}
              and ${listingAgent.userId} = ${user.id}
          )`
        : sql<boolean>`false`,
    })
    .from(user)
    .innerJoin(
      membership,
      and(
        eq(membership.userId, user.id),
        eq(membership.agencyId, thread.agencyId),
        eq(membership.status, 'active'),
      ),
    )
    .where(sql`lower(${user.email}) = ${from}`)
    .limit(1);
  if (!row) return null;
  const onListing = row.onListing === true || (row.onListing as unknown) === 't';
  return {
    userId: row.userId,
    agencyId: thread.agencyId,
    membershipRole: row.role as MembershipRole,
    ...(onListing && thread.listingId ? { listingAgentOf: [thread.listingId] } : {}),
  };
}

/** DMARC passing is the only thing that says the From domain stood behind this message. */
function senderVerified(email: ReceivedEmail): boolean {
  return email.authentication?.dmarc?.toLowerCase() === 'pass';
}

/**
 * Record one received email. Returns what happened, so the caller can send
 * (relay, notices) AFTER — never inside this function's writes.
 */
export async function ingestReceivedEmail(
  db: Db,
  deps: MailDeps & { config: MailConfig },
  email: ReceivedEmail,
): Promise<IngestOutcome> {
  // Delivered twice (a webhook retry): the first one already did the work.
  const [seen] = await db
    .select({ id: mailMessage.id })
    .from(mailMessage)
    .where(eq(mailMessage.providerId, email.id))
    .limit(1);
  if (seen) return { kind: 'duplicate' };

  const route = routeRecipients(recipientsOf(email), deps.config);
  if (!route) return { kind: 'unrouted' };

  const from = bareAddress(email.from);
  const fromName = displayName(email.from);
  const subject = (email.subject ?? '').trim();

  // A team conversation (ADR 0035 §3): its own tables, its own rules.
  if ('teamThreadId' in route) {
    const html = decodeHtmlField(email.html);
    const text = email.text?.trim() ? email.text : html ? htmlToText(html) : '';
    const outcome = await ingestTeamReply(db, { id: email.id, from, text, dmarcPass: senderVerified(email) }, route.teamThreadId);
    if (outcome.kind === 'dropped') {
      // The email id and the reason only — never an address; this reaches logs.
      console.warn(`[mail] team reply ${email.id} dropped: ${outcome.reason}`);
      return { kind: 'dropped' };
    }
    return outcome;
  }

  const thread =
    'threadId' in route
      ? await threadFacts(db, route.threadId)
      : await generalThreadFor(db, route.agencySlug, from, fromName, subject);
  if (!thread) return { kind: 'unrouted' };

  const html = decodeHtmlField(email.html);
  const text = email.text?.trim() ? email.text : html ? htmlToText(html) : '';
  const rfcMessageId = email.message_id ?? headerValue(email, 'message-id');

  // ── An agent answering from their own mail ──────────────────────────────
  let refusal: string | null = null;
  if (from !== thread.contactEmail && !thread.isNew) {
    const member = await memberBehind(db, thread, from);
    if (member) {
      if (!senderVerified(email)) {
        refusal = 'Not sent on: your email could not be verified (DMARC). Reply from the console instead.';
      } else if (!maySendOnThread(member, thread)) {
        refusal = 'Not sent on: you may read this conversation but not reply on it.';
      } else {
        const body = stripQuotedReply(text);
        if (!body) {
          refusal = 'Not sent on: the reply was empty once the quoted email was removed.';
        } else {
          try {
            const messageId = await recordOutbound(db, deps, {
              threadId: thread.id,
              agencyId: thread.agencyId,
              subject: thread.subject,
              to: thread.contactEmail,
              body,
              sentBy: member.userId,
              channel: 'email',
              providerId: email.id,
              rfcMessageId,
            });
            return { kind: 'relay', threadId: thread.id, messageId };
          } catch (err) {
            if (isUniqueViolation(err)) return { kind: 'duplicate' };
            throw err;
          }
        }
      }
    }
  }

  // ── Everything else is stored as received ───────────────────────────────
  try {
    const stored = await db.transaction(async (tx) => {
      let threadId = thread.id;
      if (thread.isNew) {
        const [created] = await tx
          .insert(mailThread)
          .values({
            agencyId: thread.agencyId,
            subject: thread.subject,
            contactEmail: from,
            contactName: fromName,
          })
          .returning({ id: mailThread.id });
        threadId = created!.id;
      }
      const [row] = await tx
        .insert(mailMessage)
        .values({
          threadId,
          agencyId: thread.agencyId,
          direction: 'in',
          status: 'received',
          fromEmail: from,
          fromName,
          toEmails: recipientsOf(email),
          subject: subject || thread.subject,
          text,
          html,
          providerId: email.id,
          rfcMessageId,
          attachments: attachmentNotes(email),
          error: refusal,
        })
        .returning({ id: mailMessage.id });
      await tx
        .update(mailThread)
        // clock_timestamp(), not now(): now() is the transaction's START, and
        // "read" vs "arrived since" is a comparison of two moments — it must
        // not depend on how the writes happen to be grouped into transactions.
        .set({
          lastMessageAt: sql`clock_timestamp()`,
          lastInboundAt: sql`clock_timestamp()`,
          updatedAt: sql`now()`,
        })
        .where(eq(mailThread.id, threadId));
      return { threadId, messageId: row!.id };
    });
    // The people on the thread hear about the contact writing back, and about
    // new mail to the agency address. Not about a refused relay — that agent
    // already knows they sent it — nor a stranger's mail on a lead thread.
    const notify = from === thread.contactEmail || (!thread.leadId && refusal === null);
    return { kind: 'stored', threadId: stored.threadId, messageId: stored.messageId, notify };
  } catch (err) {
    if (isUniqueViolation(err)) return { kind: 'duplicate' };
    throw err;
  }
}
