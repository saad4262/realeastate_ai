import { and, asc, desc, eq, or, sql } from 'drizzle-orm';
import { replyInputSchema } from './mail-schema';
import { agency, integrationAccount, lead, mailCustomerRead, mailMessage, mailThread, type Db } from '@repo/db';
import { can } from '../permissions';
import { snippet, stripQuotedReply } from './body';
import { MailError } from './threads';
import { provenAddress } from './verify-email';
import { sentViaLabel } from './sender';

/**
 * A buyer's own conversations, on the website (docs/adr/0016).
 *
 * ## Whose they are
 *
 * A thread is theirs when its lead was made by their account (a private
 * offer records the user), or when its contact address is one they have
 * PROVED they receive mail at (`user.verified_email`, see verify-email.ts).
 * Not merely their sign-in address: sign-up does not confirm an email here,
 * so anybody could register with somebody else's and read their mail.
 *
 * ## What they see
 *
 * Only what passed between them and the agency: what the agency SENT them, and
 * what they wrote themselves. Not a failed or queued send (that never reached
 * them), not a refused relay, not a third party's mail on the same thread.
 * Their opening message is the lead's, as on the console.
 */

export type CustomerIdentity = { userId: string; email: string };

/** The ownership test, as SQL. Used by the list and the single read alike. */
function mine(who: CustomerIdentity, proved: string | null) {
  return proved
    ? or(eq(mailThread.contactEmail, proved), eq(lead.userId, who.userId))!
    : eq(lead.userId, who.userId);
}

/** The messages a buyer may see on a thread, as SQL. */
const visibleToContact = sql`(
  (${mailMessage.direction} = 'out' and ${mailMessage.status} = 'sent')
  or (${mailMessage.direction} = 'in' and ${mailMessage.fromEmail} = ${mailThread.contactEmail})
)`;

export type CustomerThreadRow = {
  id: string;
  subject: string;
  agencyName: string;
  preview: string;
  /** How many times the agency has written back. */
  replies: number;
  lastActivityAt: Date;
  /** The agency wrote since they last opened it (ADR 0035 §2). */
  unread: boolean;
};

function assertOwner(who: CustomerIdentity) {
  // Ownership is the SQL predicate above; this is the rule saying so (#2).
  if (!can({ userId: who.userId }, 'mail:read_own', { type: 'mail_thread', ownerId: who.userId })) {
    throw new MailError('forbidden', 'Sign in to see your messages');
  }
}

export type CustomerThreadList = {
  rows: CustomerThreadRow[];
  /** False until they open the link sent to their address; the page offers it. */
  addressProved: boolean;
  /** Conversations with something new from the agency. */
  unread: number;
};

/** "The agency wrote since you last looked": a sent message newer than their read mark. */
const customerUnread = sql<boolean>`exists (
  select 1 from mail_message u
  where u.thread_id = ${mailThread.id} and u.direction = 'out' and u.status = 'sent'
    and u.created_at > coalesce(${mailCustomerRead.lastReadAt}, '-infinity'::timestamptz)
)`;

/** Their conversations, newest activity first. Two statements: the proof, then the list. */
export async function listCustomerThreads(
  db: Db,
  who: CustomerIdentity,
  opts: { limit?: number } = {},
): Promise<CustomerThreadList> {
  assertOwner(who);
  const proved = await provenAddress(db, who);

  const latest = sql<string | null>`(
    select m.text from mail_message m
    where m.thread_id = ${mailThread.id}
      and ((m.direction = 'out' and m.status = 'sent')
        or (m.direction = 'in' and m.from_email = ${mailThread.contactEmail}))
    order by m.created_at desc, m.id desc limit 1
  )`;
  const lastAt = sql<Date | null>`(
    select max(m.created_at) from mail_message m
    where m.thread_id = ${mailThread.id}
      and ((m.direction = 'out' and m.status = 'sent')
        or (m.direction = 'in' and m.from_email = ${mailThread.contactEmail}))
  )`;

  const rows = await db
    .select({
      id: mailThread.id,
      subject: mailThread.subject,
      agencyName: agency.name,
      leadMessage: lead.message,
      createdAt: mailThread.createdAt,
      latest,
      lastAt,
      replies: sql<number>`(
        select count(*) from mail_message m
        where m.thread_id = ${mailThread.id} and m.direction = 'out' and m.status = 'sent'
      )`,
      unread: customerUnread,
      unreadCount: sql<number>`count(*) filter (where ${customerUnread}) over()`,
    })
    .from(mailThread)
    .innerJoin(agency, eq(agency.id, mailThread.agencyId))
    .leftJoin(lead, eq(lead.id, mailThread.leadId))
    .leftJoin(mailCustomerRead, and(eq(mailCustomerRead.threadId, mailThread.id), eq(mailCustomerRead.userId, who.userId)))
    .where(mine(who, proved))
    // Their own last visible activity, not the agency's internal clock — a
    // refused relay must not float a thread to the top of the buyer's list.
    .orderBy(sql`coalesce(${lastAt}, ${mailThread.createdAt}) desc`, desc(mailThread.id))
    .limit(opts.limit ?? 50);

  return {
    addressProved: proved !== null,
    unread: Number(rows[0]?.unreadCount ?? 0),
    rows: rows.map((r) => ({
      id: r.id,
      subject: r.subject,
      agencyName: r.agencyName,
      preview: snippet(r.latest ?? r.leadMessage ?? ''),
      replies: Number(r.replies ?? 0),
      lastActivityAt: new Date(r.lastAt ?? r.createdAt),
      unread: r.unread === true || (r.unread as unknown) === 't',
    })),
  };
}

export type CustomerMessage = {
  id: string;
  /** Written by the buyer themselves. */
  byYou: boolean;
  /** "You", or the agency's name — never an agent's address. */
  from: string;
  text: string;
  /** On the agency's messages: how it left — the same words as in the console (ADR 0026, decided Q5). */
  sentVia: string | null;
  createdAt: Date;
};

export type CustomerThreadView = {
  id: string;
  subject: string;
  agencyName: string;
  opening: { text: string; createdAt: Date } | null;
  messages: CustomerMessage[];
};

/** One of their conversations. A thread that is not theirs is "not found". */
export async function getCustomerThread(
  db: Db,
  who: CustomerIdentity,
  threadId: string,
): Promise<CustomerThreadView> {
  assertOwner(who);
  const notFound = new MailError('not_found', 'That conversation was not found');
  if (!/^[0-9a-f-]{36}$/i.test(threadId)) throw notFound;
  const proved = await provenAddress(db, who);

  const [thread] = await db
    .select({
      id: mailThread.id,
      subject: mailThread.subject,
      agencyName: agency.name,
      leadMessage: lead.message,
      leadCreatedAt: lead.createdAt,
    })
    .from(mailThread)
    .innerJoin(agency, eq(agency.id, mailThread.agencyId))
    .leftJoin(lead, eq(lead.id, mailThread.leadId))
    .where(and(eq(mailThread.id, threadId), mine(who, proved)))
    .limit(1);
  if (!thread) throw notFound;

  const messages = await db
    .select({
      id: mailMessage.id,
      direction: mailMessage.direction,
      text: mailMessage.text,
      sentVia: mailMessage.sentVia,
      senderOwnerType: integrationAccount.ownerType,
      createdAt: mailMessage.createdAt,
    })
    .from(mailMessage)
    .innerJoin(mailThread, eq(mailThread.id, mailMessage.threadId))
    .leftJoin(integrationAccount, eq(integrationAccount.id, mailMessage.senderAccountId))
    .where(and(eq(mailMessage.threadId, thread.id), visibleToContact))
    .orderBy(asc(mailMessage.createdAt), asc(mailMessage.id));

  return {
    id: thread.id,
    subject: thread.subject,
    agencyName: thread.agencyName,
    opening:
      thread.leadMessage && thread.leadCreatedAt
        ? { text: thread.leadMessage, createdAt: new Date(thread.leadCreatedAt) }
        : null,
    messages: messages.map((m) => ({
      id: m.id,
      byYou: m.direction === 'in',
      from: m.direction === 'in' ? 'You' : thread.agencyName,
      // Their own replies come from a mail client with our message quoted
      // under them; show what they actually wrote.
      text: m.direction === 'in' ? stripQuotedReply(m.text) : m.text,
      sentVia: m.direction === 'out' && m.sentVia ? sentViaLabel(m) : null,
      createdAt: new Date(m.createdAt),
    })),
  };
}

/**
 * The buyer answers from the website instead of their mail app.
 *
 * Recorded exactly as if their email had arrived — `in`, from the thread's
 * contact address — so the console, the unread flag and the reply notice treat
 * it the same; `channel: 'website'` says where it was written. Only on a
 * thread `getCustomerThread` would show them (the same ownership test, in the
 * WHERE). Nothing is emailed TO the buyer; the caller notifies the agency.
 */
export async function replyAsCustomer(
  db: Db,
  who: CustomerIdentity,
  threadId: string,
  input: unknown,
): Promise<{ threadId: string; messageId: string }> {
  assertOwner(who);
  const parsed = replyInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new MailError('invalid', parsed.error.issues[0]?.message ?? 'Write a message first');
  }
  const notFound = new MailError('not_found', 'That conversation was not found');
  if (!/^[0-9a-f-]{36}$/i.test(threadId)) throw notFound;
  const proved = await provenAddress(db, who);

  const [thread] = await db
    .select({
      id: mailThread.id,
      agencyId: mailThread.agencyId,
      subject: mailThread.subject,
      contactEmail: mailThread.contactEmail,
      contactName: mailThread.contactName,
    })
    .from(mailThread)
    .leftJoin(lead, eq(lead.id, mailThread.leadId))
    .where(and(eq(mailThread.id, threadId), mine(who, proved)))
    .limit(1);
  if (!thread) throw notFound;

  const messageId = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(mailMessage)
      .values({
        threadId: thread.id,
        agencyId: thread.agencyId,
        direction: 'in',
        channel: 'website',
        status: 'received',
        fromEmail: thread.contactEmail,
        fromName: thread.contactName,
        subject: /^re:/i.test(thread.subject) ? thread.subject : `Re: ${thread.subject}`,
        text: parsed.data.body,
      })
      .returning({ id: mailMessage.id });
    await tx
      .update(mailThread)
      .set({
        lastMessageAt: sql`clock_timestamp()`,
        lastInboundAt: sql`clock_timestamp()`,
        updatedAt: sql`now()`,
      })
      .where(eq(mailThread.id, thread.id));
    return row!.id;
  });
  return { threadId: thread.id, messageId };
}

/**
 * "I have read this" — the buyer opened one of their conversations (ADR 0035
 * §2). Only on a thread `getCustomerThread` would show them; upserted.
 */
export async function markCustomerThreadRead(db: Db, who: CustomerIdentity, threadId: string): Promise<void> {
  assertOwner(who);
  if (!/^[0-9a-f-]{36}$/i.test(threadId)) return;
  const proved = await provenAddress(db, who);
  const [thread] = await db
    .select({ id: mailThread.id })
    .from(mailThread)
    .leftJoin(lead, eq(lead.id, mailThread.leadId))
    .where(and(eq(mailThread.id, threadId), mine(who, proved)))
    .limit(1);
  if (!thread) return;
  await db
    .insert(mailCustomerRead)
    .values({ threadId: thread.id, userId: who.userId, lastReadAt: sql`clock_timestamp()` })
    .onConflictDoUpdate({ target: [mailCustomerRead.threadId, mailCustomerRead.userId], set: { lastReadAt: sql`clock_timestamp()` } });
}
