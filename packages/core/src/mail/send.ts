import { and, desc, eq, sql } from 'drizzle-orm';
import { agency, agentProfile, mailMessage, mailThread, user, type Db } from '@repo/db';
import {
  buildConversationEmail,
  replySubject,
  type EmailTransport,
  type SenderIdentity,
} from '../email';
import type { Actor } from '../permissions';
import { threadReplyAddress, type MailConfig } from './address';
import { conversationLink, verifySecretFromEnv } from './verify-email';
import { noticeMailFromEnv } from '../email/resend-transport';
import { mailConfigFromEnv } from './address';
import { replyInputSchema } from './mail-schema';
import {
  loadThreadAccess,
  MailError,
  mayReadThread,
  maySendOnThread,
  THREAD_NOT_FOUND,
} from './threads';

/**
 * Sending on a conversation (docs/adr/0016).
 *
 * Always two steps, and the order is the point:
 *  1. the message is RECORDED, `queued`, in a transaction with the thread's
 *     timestamp — so a send can never happen without a row;
 *  2. it is sent AFTER that transaction, and the row is marked `sent` or
 *     `failed`. A network call never runs inside a transaction (CLAUDE.md), and
 *     a Resend outage leaves a visible failed message rather than a lost one.
 */

export type MailDeps = {
  mailer: { sender: SenderIdentity; transport: EmailTransport };
  /** Null while inbound is not set up: replies then go to the agent's own address. */
  config: MailConfig | null;
  /**
   * The public site, so a reply can carry "View this conversation on the
   * website" — a link that also proves the buyer's mailbox (verify-email.ts).
   * Absent: the email simply has no such link.
   */
  site?: { webUrl: string; verifySecret: string | null };
};

/**
 * Everything sending needs, from the environment: the mailer, inbound config
 * (or null), and the site link. Null only when mail itself is not configured.
 */
export function mailDepsFromEnv(env: NodeJS.ProcessEnv = process.env): MailDeps | null {
  const notice = noticeMailFromEnv(env);
  if (!notice) return null;
  return {
    mailer: notice.mailer,
    config: mailConfigFromEnv(env),
    site: { webUrl: notice.urls.webUrl, verifySecret: verifySecretFromEnv(env) },
  };
}

export type SendOutcome = { messageId: string; status: 'sent' | 'failed'; error: string | null };

/** A display name that cannot break the From header it is put in. */
function headerSafe(name: string): string {
  return name.replace(/["<>,;\\\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Reply on a thread from the console.
 *
 * `mail:send` is decided here, against the thread as the database holds it now;
 * the composer having been drawn is a courtesy, not a permission.
 */
export async function sendThreadReply(
  db: Db,
  deps: MailDeps,
  actor: Actor,
  threadId: string,
  input: unknown,
): Promise<SendOutcome> {
  const parsed = replyInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new MailError('invalid', parsed.error.issues[0]?.message ?? 'Write a message first');
  }

  const head = await loadThreadAccess(db, actor, threadId);
  // Somebody who may not even see it learns nothing about whether it exists.
  if (!head || !mayReadThread(actor, head.facts)) throw THREAD_NOT_FOUND();
  if (!maySendOnThread(actor, head.facts)) {
    throw new MailError('forbidden', 'You can read this conversation but not reply on it');
  }

  const messageId = await recordOutbound(db, deps, {
    threadId: head.row.id,
    agencyId: head.row.agencyId,
    subject: head.row.subject,
    to: head.row.contactEmail,
    body: parsed.data.body,
    sentBy: actor.userId,
    channel: 'console',
  });

  return deliverOutbound(db, deps, messageId);
}

/**
 * Write the queued row and move the thread's clock, together.
 *
 * Exported for the inbound relay (an agent answering from Gmail), which records
 * the same kind of row with `channel: 'email'`.
 */
export async function recordOutbound(
  db: Db,
  deps: MailDeps,
  m: {
    threadId: string;
    agencyId: string;
    subject: string;
    to: string;
    body: string;
    sentBy: string;
    channel: 'console' | 'email';
    providerId?: string;
    rfcMessageId?: string | null;
    /** A platform-composed email's kind (`mail_message.kind`); counts against the sending limits. */
    kind?: string;
  },
): Promise<string> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(mailMessage)
      .values({
        threadId: m.threadId,
        agencyId: m.agencyId,
        direction: 'out',
        channel: m.channel,
        status: 'queued',
        fromEmail: deps.mailer.sender.from.email,
        toEmails: [m.to],
        subject: replySubject(m.subject),
        text: m.body,
        sentBy: m.sentBy,
        ...(m.providerId ? { providerId: m.providerId } : {}),
        ...(m.rfcMessageId ? { rfcMessageId: m.rfcMessageId } : {}),
        ...(m.kind ? { kind: m.kind } : {}),
      })
      .returning({ id: mailMessage.id });
    if (!row) throw new MailError('invalid', 'Could not record the message');

    await tx
      .update(mailThread)
      .set({ lastMessageAt: sql`clock_timestamp()`, updatedAt: sql`now()` })
      .where(eq(mailThread.id, m.threadId));

    return row.id;
  });
}

/**
 * Send one queued outbound message and record how it went.
 *
 * Everything the email needs is read here in one statement — the thread, the
 * agency, the author, and the buyer's latest Message-ID to thread under — so
 * the console path and the relay path cannot build it differently.
 */
export async function deliverOutbound(
  db: Db,
  deps: MailDeps,
  messageId: string,
  /** Only for an approved template email (ADR 0022): makes it marketing, with the contact's unsubscribe link. */
  opts: { unsubscribeUrl?: string } = {},
): Promise<SendOutcome> {
  const [m] = await db
    .select({
      id: mailMessage.id,
      threadId: mailMessage.threadId,
      status: mailMessage.status,
      text: mailMessage.text,
      subject: mailThread.subject,
      contactEmail: mailThread.contactEmail,
      contactName: mailThread.contactName,
      agencyName: agency.name,
      authorName: user.name,
      authorEmail: user.email,
      authorDisplay: agentProfile.displayName,
      inReplyTo: sql<string | null>`(
        select x.rfc_message_id from mail_message x
        where x.thread_id = ${mailMessage.threadId}
          and x.direction = 'in' and x.rfc_message_id is not null
        order by x.created_at desc limit 1
      )`,
    })
    .from(mailMessage)
    .innerJoin(mailThread, eq(mailThread.id, mailMessage.threadId))
    .innerJoin(agency, eq(agency.id, mailThread.agencyId))
    .leftJoin(user, eq(user.id, mailMessage.sentBy))
    .leftJoin(agentProfile, eq(agentProfile.userId, mailMessage.sentBy))
    .where(eq(mailMessage.id, messageId))
    .limit(1);

  if (!m) throw new MailError('not_found', 'That message was not found');
  // Only a queued row is sent. A retry of something already sent would be a
  // duplicate email in a buyer's inbox.
  if (m.status !== 'queued') {
    return { messageId, status: m.status === 'sent' ? 'sent' : 'failed', error: null };
  }

  const { sender, transport } = deps.mailer;
  const author = headerSafe(m.authorDisplay || m.authorName || m.agencyName);
  const agencyName = headerSafe(m.agencyName);

  const replyTo = deps.config
    ? { email: threadReplyAddress(m.threadId, deps.config), name: `${author} · ${agencyName}` }
    : m.authorEmail
      ? { email: m.authorEmail, name: author }
      : { email: sender.from.email, name: agencyName };

  let result: Awaited<ReturnType<EmailTransport['send']>>;
  try {
    const email = buildConversationEmail({
      to: { email: m.contactEmail, ...(m.contactName ? { name: headerSafe(m.contactName) } : {}) },
      from: { email: sender.from.email, name: author === agencyName ? agencyName : `${author} · ${agencyName}` },
      replyTo,
      postalAddress: sender.postalAddress,
      subject: m.subject,
      body: m.text,
      authorName: author,
      agencyName,
      ...(deps.site?.verifySecret
        ? { viewUrl: conversationLink(deps.site.webUrl, m.threadId, m.contactEmail, deps.site.verifySecret) }
        : {}),
      ...(m.inReplyTo ? { threading: { inReplyTo: m.inReplyTo, references: [m.inReplyTo] } } : {}),
      ...(opts.unsubscribeUrl ? { unsubscribeUrl: opts.unsubscribeUrl } : {}),
    });
    result = await transport.send(email);
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : 'Could not build the email', retryable: false };
  }

  if (result.ok) {
    await db
      .update(mailMessage)
      .set({ status: 'sent', providerId: result.id, error: null, updatedAt: sql`now()` })
      // Still queued: two deliveries racing on one row send once and record once.
      .where(and(eq(mailMessage.id, messageId), eq(mailMessage.status, 'queued')));
    return { messageId, status: 'sent', error: null };
  }

  // The thread id, never an address: this reaches logs.
  console.error(`[mail] message ${messageId} on thread ${m.threadId} not sent: ${result.error}`);
  await db
    .update(mailMessage)
    .set({ status: 'failed', error: result.error.slice(0, 500), updatedAt: sql`now()` })
    .where(and(eq(mailMessage.id, messageId), eq(mailMessage.status, 'queued')));
  return { messageId, status: 'failed', error: result.error };
}

/**
 * Try a failed message again. Same permission as sending; the row goes back to
 * `queued` only if it is still `failed`, so two clicks send once.
 */
export async function retryFailedMessage(
  db: Db,
  deps: MailDeps,
  actor: Actor,
  messageId: string,
): Promise<SendOutcome> {
  if (!/^[0-9a-f-]{36}$/i.test(messageId)) throw THREAD_NOT_FOUND();
  const [m] = await db
    .select({ threadId: mailMessage.threadId })
    .from(mailMessage)
    .where(and(eq(mailMessage.id, messageId), eq(mailMessage.direction, 'out')))
    .orderBy(desc(mailMessage.createdAt))
    .limit(1);
  if (!m) throw THREAD_NOT_FOUND();

  const head = await loadThreadAccess(db, actor, m.threadId);
  if (!head || !mayReadThread(actor, head.facts)) throw THREAD_NOT_FOUND();
  if (!maySendOnThread(actor, head.facts)) {
    throw new MailError('forbidden', 'You can read this conversation but not reply on it');
  }

  const reset = await db
    .update(mailMessage)
    .set({ status: 'queued', error: null, updatedAt: sql`now()` })
    .where(and(eq(mailMessage.id, messageId), eq(mailMessage.status, 'failed')))
    .returning({ id: mailMessage.id });
  if (reset.length === 0) throw new MailError('invalid', 'That message is not waiting to be sent again');

  return deliverOutbound(db, deps, messageId);
}
