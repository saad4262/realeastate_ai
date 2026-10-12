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
import { contactUnsubscribeUrl } from '../email/unsubscribe';
import { devAllowlistProblem } from '../email/limits';
import { mailConfigFromEnv } from './address';
import { replyInputSchema } from './mail-schema';
import { resolveSender } from './sender';
import { activeMemberActor } from '../team/member-actor';
import { tokenKeysFromEnv, type TokenKeys } from '../integrations/crypto';
import { withAccessToken } from '../integrations/tokens';
import { IntegrationError } from '../integrations/accounts';
import { isStubToken, stubEnabled } from '../integrations/oauth';
import { ProviderError, type Fetch } from '../integrations/provider-http';
import { buildMime, gmailApi, stubGmailApi, type GmailApi } from '../integrations/gmail';
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
  /** For the development allowlist; defaults to process.env. A test seam. */
  env?: NodeJS.ProcessEnv;
  /**
   * Sending through a connected Gmail (ADR 0026). Absent: every message goes
   * from the platform sender. `api` is the test seam (a fake Gmail).
   */
  gmail?: { keys: TokenKeys; api?: GmailApi; fetch?: Fetch; now?: () => Date };
  /**
   * The public site and the unsubscribe secret, for the opt-out link a NEW
   * email to a contact carries (ADR 0035 §1). Absent: such an email is not sent.
   */
  unsubscribe?: { baseUrl: string; secret: string };
};

/** A new email to a contact, written by a person or approved on an assistant card (ADR 0035 §1). */
export const DIRECT_EMAIL_KIND = 'direct_email';

/**
 * Which messages may leave through a person's Gmail (ADR 0026 §4): their own
 * conversation reply typed in the console, and an appointment invitation —
 * one-to-one mail. Bulk template email, and the inbound relay, never do.
 */
const GMAIL_KINDS = new Set<string | null>([null, 'appointment_invitation', DIRECT_EMAIL_KIND]);

/**
 * Everything sending needs, from the environment: the mailer, inbound config
 * (or null), and the site link. Null only when mail itself is not configured.
 */
export function mailDepsFromEnv(env: NodeJS.ProcessEnv = process.env): MailDeps | null {
  const notice = noticeMailFromEnv(env);
  if (!notice) return null;
  let keys: TokenKeys | null = null;
  try {
    keys = tokenKeysFromEnv(env);
  } catch {
    keys = null; // a malformed key is refused at startup; here it means "platform sender only"
  }
  const unsubscribeSecret = env.ALERT_UNSUBSCRIBE_SECRET?.trim();
  return {
    mailer: notice.mailer,
    config: mailConfigFromEnv(env),
    site: { webUrl: notice.urls.webUrl, verifySecret: verifySecretFromEnv(env) },
    ...(keys ? { gmail: { keys } } : {}),
    ...(unsubscribeSecret ? { unsubscribe: { baseUrl: notice.urls.webUrl, secret: unsubscribeSecret } } : {}),
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
    /** The first message of a conversation we started: its subject as written, no "Re:". */
    opening?: boolean;
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
        subject: m.opening ? m.subject.trim() : replySubject(m.subject),
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
  opts: {
    unsubscribeUrl?: string;
    /** The person pressed "Send from the platform address instead" (ADR 0026 §7): never Gmail. */
    platformOnly?: boolean;
  } = {},
): Promise<SendOutcome> {
  const [m] = await db
    .select({
      id: mailMessage.id,
      threadId: mailMessage.threadId,
      status: mailMessage.status,
      kind: mailMessage.kind,
      channel: mailMessage.channel,
      sentBy: mailMessage.sentBy,
      agencyId: mailThread.agencyId,
      text: mailMessage.text,
      subject: mailThread.subject,
      contactEmail: mailThread.contactEmail,
      contactName: mailThread.contactName,
      contactId: mailThread.contactId,
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

  // The shared guard for platform-composed email (a `kind`: template email,
  // appointment invitation, anything the assistant sends): outside production
  // only the dev allowlist receives it. Callers check first and show the
  // reason; this is the backstop no new sender can forget. A person's own
  // typed reply (no kind) is theirs to send and is not stopped here.
  const blocked = m.kind ? devAllowlistProblem(m.contactEmail, deps.env ?? process.env) : null;
  if (blocked) {
    await db
      .update(mailMessage)
      .set({ status: 'failed', error: blocked, updatedAt: sql`now()` })
      .where(and(eq(mailMessage.id, messageId), eq(mailMessage.status, 'queued')));
    return { messageId, status: 'failed', error: blocked };
  }

  // A new email to a contact carries their opt-out link (ADR 0035 §1). No
  // secret, no link — and then it is not sent, rather than sent without one.
  const opening = m.kind === DIRECT_EMAIL_KIND;
  const optOutUrl = opening && deps.unsubscribe && m.contactId
    ? contactUnsubscribeUrl(deps.unsubscribe.baseUrl, m.contactId, deps.unsubscribe.secret)
    : null;
  if (opening && !optOutUrl) {
    const reason = 'Not sent: a new email must carry an unsubscribe link, and ALERT_UNSUBSCRIBE_SECRET is not set on this server.';
    await db
      .update(mailMessage)
      .set({ status: 'failed', error: reason, updatedAt: sql`now()` })
      .where(and(eq(mailMessage.id, messageId), eq(mailMessage.status, 'queued')));
    return { messageId, status: 'failed', error: reason };
  }

  const { sender, transport } = deps.mailer;
  const author = headerSafe(m.authorDisplay || m.authorName || m.agencyName);
  const agencyName = headerSafe(m.agencyName);

  const replyTo = deps.config
    ? { email: threadReplyAddress(m.threadId, deps.config), name: `${author} · ${agencyName}` }
    : m.authorEmail
      ? { email: m.authorEmail, name: author }
      : { email: sender.from.email, name: agencyName };

  // Gmail or the platform, decided now, AFTER the transaction that recorded the row.
  const gmail = await gmailRoute(db, deps, m, opts);

  let result: Awaited<ReturnType<EmailTransport['send']>>;
  try {
    const email = buildConversationEmail({
      to: { email: m.contactEmail, ...(m.contactName ? { name: headerSafe(m.contactName) } : {}) },
      from: {
        email: gmail ? gmail.choice.address : sender.from.email,
        name: author === agencyName ? agencyName : `${author} · ${agencyName}`,
      },
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
      ...(optOutUrl ? { opening: { optOutUrl } } : {}),
    });
    result = gmail ? await sendViaGmail(db, deps, gmail, email) : await transport.send(email);
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : 'Could not build the email', retryable: false };
  }

  // How it left (or tried to): shown on the message, and what decides the
  // "Send from the platform address instead" button. Never switched silently.
  const via = gmail
    ? { sentVia: 'gmail', senderAccountId: gmail.choice.accountId, fromEmail: gmail.choice.address }
    : { sentVia: 'resend', senderAccountId: null, fromEmail: sender.from.email };

  if (result.ok) {
    await db
      .update(mailMessage)
      .set({ status: 'sent', providerId: result.id, error: null, ...via, updatedAt: sql`now()` })
      // Still queued: two deliveries racing on one row send once and record once.
      .where(and(eq(mailMessage.id, messageId), eq(mailMessage.status, 'queued')));
    return { messageId, status: 'sent', error: null };
  }

  // The thread id, never an address: this reaches logs.
  console.error(`[mail] message ${messageId} on thread ${m.threadId} not sent: ${result.error}`);
  await db
    .update(mailMessage)
    .set({ status: 'failed', error: result.error.slice(0, 500), ...via, updatedAt: sql`now()` })
    .where(and(eq(mailMessage.id, messageId), eq(mailMessage.status, 'queued')));
  return { messageId, status: 'failed', error: result.error };
}

type GmailRoute = { actor: Actor; choice: Extract<Awaited<ReturnType<typeof resolveSender>>, { via: 'gmail' }> };

/**
 * Whether this message goes through a Gmail, and whose — or null for the
 * platform sender. Only one-to-one mail written by a person who is still an
 * active member, and only when that person may use the account.
 */
async function gmailRoute(
  db: Db,
  deps: MailDeps,
  m: { kind: string | null; channel: string | null; sentBy: string | null; agencyId: string },
  opts: { unsubscribeUrl?: string; platformOnly?: boolean },
): Promise<GmailRoute | null> {
  if (!deps.gmail || opts.platformOnly || opts.unsubscribeUrl || !m.sentBy) return null;
  if (m.channel !== 'console' || !GMAIL_KINDS.has(m.kind)) return null;
  const actor = await activeMemberActor(db, m.sentBy, m.agencyId);
  if (!actor) return null;
  const choice = await resolveSender(db, actor);
  return choice.via === 'gmail' ? { actor, choice } : null;
}

/** One send through Gmail, as the author; every failure becomes a sentence with what to do next. */
async function sendViaGmail(
  db: Db,
  deps: MailDeps,
  route: GmailRoute,
  email: Parameters<EmailTransport['send']>[0],
): Promise<Awaited<ReturnType<EmailTransport['send']>>> {
  const g = deps.gmail!;
  const env = deps.env ?? process.env;
  const raw = buildMime(email);
  try {
    const sent = await withAccessToken(db, g.keys, route.actor, route.choice.accountId, { env, ...(g.fetch ? { fetch: g.fetch } : {}), ...(g.now ? { now: g.now } : {}) }, (token) => {
      const api = g.api ?? (isStubToken(token) ? (stubEnabled(env) ? stubGmailApi() : null) : gmailApi(g.fetch ?? fetch));
      if (!api) throw new ProviderError('failed', 'The pretend provider is off on this server');
      return api.send(token, raw);
    });
    // Namespaced: provider_id is unique across both transports.
    return { ok: true, id: `gmail:${sent.id}` };
  } catch (err) {
    const after = ' — retry, or send from the platform address instead';
    if (err instanceof IntegrationError && err.code === 'expired') {
      return { ok: false, error: 'Your Gmail connection expired — reconnect it, or send from the platform address', retryable: false };
    }
    if (err instanceof ProviderError && err.kind === 'rate_limited') {
      return { ok: false, error: `Gmail's sending limit was reached${after}`, retryable: true };
    }
    const why = err instanceof ProviderError || err instanceof IntegrationError ? err.message : 'Gmail could not be reached';
    return { ok: false, error: `Gmail did not send it (${why})${after}`, retryable: true };
  }
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
  /** "Send from the platform address instead" (ADR 0026 §7): the person's explicit choice. */
  opts: { platformOnly?: boolean } = {},
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

  return deliverOutbound(db, deps, messageId, opts.platformOnly ? { platformOnly: true } : {});
}
