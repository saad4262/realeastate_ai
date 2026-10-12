import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  agency,
  membership,
  notification,
  teamMessage,
  teamThread,
  teamThreadMember,
  user,
  type Db,
  type DbOrTx,
} from '@repo/db';
import { can, type Actor, type MembershipRole, type Resource } from '../permissions';
import { buildTeamMessageEmail, type EmailTransport, type SenderIdentity } from '../email';
import { noticeMailFromEnv } from '../email/resend-transport';
import { snippet, stripQuotedReply } from '../mail/body';
import { teamReplyAddress, type MailConfig } from '../mail/address';
import { replyInputSchema, teamMessageStartSchema } from '../mail/mail-schema';

/**
 * Team messages (ADR 0035 §3): members of one agency writing to each other.
 *
 * Their own tables, never `mail_thread`: nothing here can reach the buyer
 * portal, a contact's timeline or the contact inbox. Only the people ON a
 * conversation read it — `team_message:read` has no admin exception, as an
 * assistant conversation is its author's alone.
 *
 * Writing is recorded in a transaction; the emails to the others and their
 * bell notifications follow it (`deliverTeamMessage`) — a network call never
 * runs inside a transaction (CLAUDE.md).
 */

export class TeamMessageError extends Error {
  readonly code: 'forbidden' | 'not_found' | 'invalid';
  constructor(code: TeamMessageError['code'], message: string) {
    super(message);
    this.name = 'TeamMessageError';
    this.code = code;
  }
}

const NOT_FOUND = () => new TeamMessageError('not_found', 'That conversation was not found');
const UUID = /^[0-9a-f-]{36}$/i;

const ROLE_LABELS: Record<MembershipRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  agent: 'Agent',
  assistant: 'Assistant',
  property_manager: 'Property manager',
  read_only: 'Read-only',
};

function page(actor: Actor): Resource {
  return { type: 'team_thread', agencyId: actor.agencyId ?? undefined };
}

function nameOf(u: { name: string | null; email: string }): string {
  return u.name?.trim() || u.email;
}

// ── Who you can write to ───────────────────────────────────────────────────

export type Colleague = { userId: string; name: string; email: string; role: MembershipRole; roleLabel: string };

/** Every other ACTIVE member of your agency, by name. One statement. */
export async function listColleagues(db: DbOrTx, actor: Actor): Promise<Colleague[]> {
  if (!actor.agencyId || !can(actor, 'team_message:read', page(actor))) return [];
  const rows = await db
    .select({ userId: user.id, name: user.name, email: user.email, role: membership.role })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(and(eq(membership.agencyId, actor.agencyId), eq(membership.status, 'active'), ne(membership.userId, actor.userId)))
    .orderBy(asc(sql`lower(coalesce(nullif(${user.name}, ''), ${user.email}))`));
  return rows.map((r) => {
    const role = r.role as MembershipRole;
    return { userId: r.userId, name: nameOf(r), email: r.email, role, roleLabel: ROLE_LABELS[role] ?? role };
  });
}

// ── The list ───────────────────────────────────────────────────────────────

export type TeamThreadRow = {
  id: string;
  subject: string;
  /** Everyone else on it, by name. */
  others: string[];
  preview: string;
  lastFromMe: boolean;
  lastMessageAt: Date;
  unread: boolean;
};

export type TeamThreadPage = { rows: TeamThreadRow[]; unread: number; maySend: boolean };

/** The conversations you are on, newest first, with the unread count. One statement. */
export async function listTeamThreads(db: Db, actor: Actor, opts: { limit?: number } = {}): Promise<TeamThreadPage> {
  if (!actor.agencyId || !can(actor, 'team_message:read', page(actor))) {
    throw new TeamMessageError('forbidden', 'You do not have permission to view team messages');
  }
  const unreadSql = sql<boolean>`exists (
    select 1 from ${teamMessage} x
    where x.thread_id = ${teamThread.id}
      and x.sender_id is distinct from ${actor.userId}
      and x.created_at > coalesce(${teamThreadMember.lastReadAt}, '-infinity'::timestamptz)
  )`;
  const rows = await db
    .select({
      id: teamThread.id,
      subject: teamThread.subject,
      lastMessageAt: teamThread.lastMessageAt,
      others: sql<string[] | null>`(
        select array_agg(coalesce(nullif(u.name, ''), u.email) order by lower(coalesce(nullif(u.name, ''), u.email)))
        from team_thread_member o join "user" u on u.id = o.user_id
        where o.thread_id = ${teamThread.id} and o.user_id <> ${actor.userId}
      )`,
      lastText: sql<string | null>`(
        select m.text from team_message m where m.thread_id = ${teamThread.id}
        order by m.created_at desc, m.id desc limit 1
      )`,
      lastSender: sql<string | null>`(
        select m.sender_id from team_message m where m.thread_id = ${teamThread.id}
        order by m.created_at desc, m.id desc limit 1
      )`,
      unread: unreadSql,
      unreadCount: sql<number>`count(*) filter (where ${unreadSql}) over()`,
    })
    .from(teamThread)
    .innerJoin(teamThreadMember, and(eq(teamThreadMember.threadId, teamThread.id), eq(teamThreadMember.userId, actor.userId)))
    .where(eq(teamThread.agencyId, actor.agencyId))
    .orderBy(desc(teamThread.lastMessageAt), desc(teamThread.id))
    .limit(Math.min(opts.limit ?? 50, 100));

  return {
    rows: rows.map((r) => ({
      id: r.id,
      subject: r.subject,
      others: r.others ?? [],
      preview: snippet(r.lastText ?? ''),
      lastFromMe: r.lastSender === actor.userId,
      lastMessageAt: new Date(r.lastMessageAt),
      unread: r.unread === true || (r.unread as unknown) === 't',
    })),
    unread: Number(rows[0]?.unreadCount ?? 0),
    maySend: can(actor, 'team_message:send', page(actor)),
  };
}

/** How many of your conversations have something new — for a nav badge. One statement. */
export async function countUnreadTeamThreads(db: DbOrTx, actor: Actor): Promise<number> {
  if (!actor.agencyId || !can(actor, 'team_message:read', page(actor))) return 0;
  const [row] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n
    from team_thread_member me
    join team_thread t on t.id = me.thread_id and t.agency_id = ${actor.agencyId}
    where me.user_id = ${actor.userId}
      and exists (
        select 1 from team_message x
        where x.thread_id = t.id and x.sender_id is distinct from ${actor.userId}
          and x.created_at > coalesce(me.last_read_at, '-infinity'::timestamptz)
      )`);
  return Number(row?.n ?? 0);
}

// ── One conversation ───────────────────────────────────────────────────────

/** The thread and who is on it, in one statement; null when it is not in your agency. */
async function loadHead(db: DbOrTx, actor: Actor, threadId: string) {
  if (!actor.agencyId || !UUID.test(threadId)) return null;
  const [row] = await db
    .select({
      id: teamThread.id,
      agencyId: teamThread.agencyId,
      subject: teamThread.subject,
      // `team_thread.id`, written out: in a select with no join Drizzle renders
      // `${teamThread.id}` as a bare "id", which inside this subquery is
      // "user".id — the thread then had nobody on it and never opened.
      people: sql<{ userId: string; name: string | null; email: string; active: boolean }[] | null>`(
        select json_agg(json_build_object(
          'userId', u.id, 'name', u.name, 'email', u.email,
          'active', exists (select 1 from membership ms where ms.user_id = u.id and ms.agency_id = team_thread.agency_id and ms.status = 'active')
        ) order by lower(coalesce(nullif(u.name, ''), u.email)))
        from team_thread_member p join "user" u on u.id = p.user_id
        where p.thread_id = team_thread.id
      )`,
    })
    .from(teamThread)
    .where(and(eq(teamThread.id, threadId), eq(teamThread.agencyId, actor.agencyId)))
    .limit(1);
  if (!row) return null;
  const people = row.people ?? [];
  const resource: Resource = { type: 'team_thread', id: row.id, agencyId: row.agencyId, participantIds: people.map((p) => p.userId) };
  return { row, people, resource };
}

export type TeamMessageView = {
  id: string;
  senderId: string | null;
  senderName: string;
  mine: boolean;
  text: string;
  /** `email` when it was answered from a mail client. */
  channel: string;
  createdAt: Date;
};

export type TeamThreadView = {
  id: string;
  subject: string;
  people: { userId: string; name: string; email: string; you: boolean; active: boolean }[];
  messages: TeamMessageView[];
  maySend: boolean;
};

/** One conversation, oldest message first. Two statements; the second only once the first said you may. */
export async function getTeamThread(db: Db, actor: Actor, threadId: string): Promise<TeamThreadView> {
  const head = await loadHead(db, actor, threadId);
  if (!head || !can(actor, 'team_message:read', head.resource)) throw NOT_FOUND();
  const messages = await db
    .select({
      id: teamMessage.id,
      senderId: teamMessage.senderId,
      senderName: user.name,
      senderEmail: user.email,
      text: teamMessage.text,
      channel: teamMessage.channel,
      createdAt: teamMessage.createdAt,
    })
    .from(teamMessage)
    .leftJoin(user, eq(user.id, teamMessage.senderId))
    .where(eq(teamMessage.threadId, head.row.id))
    .orderBy(asc(teamMessage.createdAt), asc(teamMessage.id));
  return {
    id: head.row.id,
    subject: head.row.subject,
    people: head.people.map((p) => ({ userId: p.userId, name: nameOf(p), email: p.email, you: p.userId === actor.userId, active: p.active })),
    messages: messages.map((m) => ({
      id: m.id,
      senderId: m.senderId,
      senderName: m.senderEmail ? nameOf({ name: m.senderName, email: m.senderEmail }) : 'A former member',
      mine: m.senderId === actor.userId,
      text: m.text,
      channel: m.channel,
      createdAt: new Date(m.createdAt),
    })),
    maySend: can(actor, 'team_message:send', head.resource),
  };
}

/** "I have seen this." Only your own row on a conversation you are on. */
export async function markTeamThreadRead(db: DbOrTx, actor: Actor, threadId: string): Promise<void> {
  const head = await loadHead(db, actor, threadId);
  if (!head || !can(actor, 'team_message:read', head.resource)) throw NOT_FOUND();
  await db
    .update(teamThreadMember)
    .set({ lastReadAt: sql`clock_timestamp()` })
    .where(and(eq(teamThreadMember.threadId, head.row.id), eq(teamThreadMember.userId, actor.userId)));
}

// ── Writing ────────────────────────────────────────────────────────────────

/**
 * Start a conversation: you and 1–10 other ACTIVE members of your agency.
 * Recorded in the caller's transaction; deliver after it commits.
 */
export async function startTeamThread(
  tx: DbOrTx,
  actor: Actor,
  input: unknown,
): Promise<{ threadId: string; messageId: string }> {
  const parsed = teamMessageStartSchema.safeParse(input);
  if (!parsed.success) throw new TeamMessageError('invalid', parsed.error.issues[0]?.message ?? 'Choose who to write to, a subject and a message');
  if (!actor.agencyId || !can(actor, 'team_message:send', page(actor))) {
    throw new TeamMessageError('forbidden', 'You may read team messages but not write them.');
  }
  const to = [...new Set(parsed.data.to)].filter((id) => id !== actor.userId);
  if (!to.length) throw new TeamMessageError('invalid', 'Choose at least one colleague — not only yourself.');
  const active = await tx
    .select({ userId: membership.userId })
    .from(membership)
    .where(and(eq(membership.agencyId, actor.agencyId), eq(membership.status, 'active'), inArray(membership.userId, to)));
  if (active.length !== to.length) {
    throw new TeamMessageError('invalid', 'Someone you chose is no longer an active member of the agency. Choose again.');
  }

  const [thread] = await tx
    .insert(teamThread)
    .values({ agencyId: actor.agencyId, subject: parsed.data.subject, createdBy: actor.userId, lastMessageAt: sql`clock_timestamp()` })
    .returning({ id: teamThread.id });
  await tx.insert(teamThreadMember).values([
    // Your own first message is read by you.
    { threadId: thread!.id, userId: actor.userId, lastReadAt: sql`clock_timestamp()` },
    ...to.map((userId) => ({ threadId: thread!.id, userId })),
  ]);
  const [message] = await tx
    .insert(teamMessage)
    // clock_timestamp(), not now(): two messages written in one transaction must still sort in order.
    .values({ threadId: thread!.id, agencyId: actor.agencyId, senderId: actor.userId, text: parsed.data.body, createdAt: sql`clock_timestamp()` })
    .returning({ id: teamMessage.id });
  return { threadId: thread!.id, messageId: message!.id };
}

/** Write on a conversation you are on. Recorded in the caller's transaction. */
export async function replyTeamThread(
  tx: DbOrTx,
  actor: Actor,
  threadId: string,
  input: unknown,
  opts: { channel?: 'console' | 'email'; providerId?: string } = {},
): Promise<{ messageId: string }> {
  const parsed = replyInputSchema.safeParse(input);
  if (!parsed.success) throw new TeamMessageError('invalid', parsed.error.issues[0]?.message ?? 'Write a message first');
  const head = await loadHead(tx, actor, threadId);
  if (!head || !can(actor, 'team_message:read', head.resource)) throw NOT_FOUND();
  if (!can(actor, 'team_message:send', head.resource)) throw new TeamMessageError('forbidden', 'You may read this conversation but not write on it.');

  const [message] = await tx
    .insert(teamMessage)
    .values({
      threadId: head.row.id,
      agencyId: head.row.agencyId,
      createdAt: sql`clock_timestamp()`,
      senderId: actor.userId,
      text: parsed.data.body,
      channel: opts.channel ?? 'console',
      ...(opts.providerId ? { providerId: opts.providerId } : {}),
    })
    .returning({ id: teamMessage.id });
  await tx.update(teamThread).set({ lastMessageAt: sql`clock_timestamp()`, updatedAt: sql`now()` }).where(eq(teamThread.id, head.row.id));
  await tx
    .update(teamThreadMember)
    .set({ lastReadAt: sql`clock_timestamp()` })
    .where(and(eq(teamThreadMember.threadId, head.row.id), eq(teamThreadMember.userId, actor.userId)));
  return { messageId: message!.id };
}

// ── After the commit: the bell and the email ───────────────────────────────

export type TeamMessageDeps = {
  mailer: { sender: SenderIdentity; transport: EmailTransport };
  /** Inbound mail; null while it is off — the email then says to answer in the console. */
  config: MailConfig | null;
  urls: { agentUrl: string; agencyUrl: string };
};

export function teamMessageDepsFromEnv(env: NodeJS.ProcessEnv = process.env): TeamMessageDeps | null {
  const notice = noticeMailFromEnv(env);
  return notice ? { mailer: notice.mailer, config: notice.config, urls: notice.urls } : null;
}

/** The console path of the team messages page for this person: the agency's for an owner/admin. */
export function teamMessagesPath(role: MembershipRole, agencyId: string): '/messages' | '/my-messages' {
  return can({ userId: '', agencyId, membershipRole: role }, 'console:agency', { type: 'console' }) ? '/messages' : '/my-messages';
}

/**
 * Tell everyone else on the conversation who is still an active member: a bell
 * notification (deduped per message) and an email with the message in full.
 * Without email deps, the bell only. Never throws for one failed email.
 */
export async function deliverTeamMessage(
  db: Db,
  deps: TeamMessageDeps | null,
  messageId: string,
): Promise<{ notified: number; emailed: number; failed: number }> {
  const [m] = await db
    .select({
      id: teamMessage.id,
      threadId: teamMessage.threadId,
      agencyId: teamMessage.agencyId,
      senderId: teamMessage.senderId,
      text: teamMessage.text,
      subject: teamThread.subject,
      agencyName: agency.name,
      senderName: user.name,
      senderEmail: user.email,
    })
    .from(teamMessage)
    .innerJoin(teamThread, eq(teamThread.id, teamMessage.threadId))
    .innerJoin(agency, eq(agency.id, teamMessage.agencyId))
    .leftJoin(user, eq(user.id, teamMessage.senderId))
    .where(eq(teamMessage.id, messageId))
    .limit(1);
  if (!m) return { notified: 0, emailed: 0, failed: 0 };

  const people = await db
    .select({ userId: user.id, name: user.name, email: user.email, role: membership.role })
    .from(teamThreadMember)
    .innerJoin(user, eq(user.id, teamThreadMember.userId))
    .innerJoin(membership, and(eq(membership.userId, user.id), eq(membership.agencyId, m.agencyId), eq(membership.status, 'active')))
    .where(eq(teamThreadMember.threadId, m.threadId));
  const writer = m.senderEmail ? nameOf({ name: m.senderName, email: m.senderEmail }) : 'A colleague';
  const recipients = people.filter((p) => p.userId !== m.senderId);
  if (!recipients.length) return { notified: 0, emailed: 0, failed: 0 };

  const preview = snippet(m.text);
  await db
    .insert(notification)
    .values(
      recipients.map((p) => ({
        userId: p.userId,
        agencyId: m.agencyId,
        kind: 'team_message',
        title: `${writer}: ${m.subject}`.slice(0, 200),
        body: preview,
        href: `${teamMessagesPath(p.role as MembershipRole, m.agencyId)}?thread=${m.threadId}`,
        dedupeKey: `team_message:${m.id}`,
      })),
    )
    .onConflictDoNothing();

  const out = { notified: recipients.length, emailed: 0, failed: 0 };
  if (!deps) return out;
  const { sender, transport } = deps.mailer;
  for (const p of recipients) {
    const path = teamMessagesPath(p.role as MembershipRole, m.agencyId);
    const base = path === '/messages' ? deps.urls.agencyUrl : deps.urls.agentUrl;
    const others = people.filter((o) => o.userId !== p.userId && o.userId !== m.senderId).map((o) => nameOf(o));
    try {
      const result = await transport.send(
        buildTeamMessageEmail({
          to: { email: p.email, ...(p.name ? { name: p.name } : {}) },
          from: sender.from,
          replyTo: deps.config ? { email: teamReplyAddress(m.threadId, deps.config), name: m.subject.slice(0, 60) } : null,
          postalAddress: sender.postalAddress,
          agencyName: m.agencyName,
          writer,
          subject: m.subject,
          body: m.text,
          others,
          threadUrl: `${base}${path}?thread=${m.threadId}`,
        }),
      );
      if (result.ok) out.emailed += 1;
      else {
        out.failed += 1;
        console.error(`[team] message ${m.id} email not sent: ${result.error}`);
      }
    } catch (err) {
      out.failed += 1;
      console.error(`[team] message ${m.id} email not sent:`, err instanceof Error ? err.message : err);
    }
  }
  return out;
}

// ── An answer from a mail client ───────────────────────────────────────────

export type TeamInboundOutcome = { kind: 'team'; threadId: string; messageId: string } | { kind: 'dropped'; reason: string } | { kind: 'duplicate' };

/**
 * A reply to a team message's email (`m+<thread>.<sig>@…`). Accepted only
 * from an active member who is on the conversation, whose mail passed DMARC;
 * anything else is dropped and never stored — a stranger's words must not
 * appear in the team's conversation. The quoted email under the answer is cut.
 */
export async function ingestTeamReply(
  db: Db,
  email: { id: string; from: string; text: string; dmarcPass: boolean },
  threadId: string,
): Promise<TeamInboundOutcome> {
  const [seen] = await db.select({ id: teamMessage.id }).from(teamMessage).where(eq(teamMessage.providerId, email.id)).limit(1);
  if (seen) return { kind: 'duplicate' };
  const [t] = await db.select({ agencyId: teamThread.agencyId }).from(teamThread).where(eq(teamThread.id, threadId)).limit(1);
  if (!t) return { kind: 'dropped', reason: 'no such conversation' };
  // The member behind the From address, active in THIS agency.
  const [member] = await db
    .select({ userId: user.id, role: membership.role })
    .from(user)
    .innerJoin(membership, and(eq(membership.userId, user.id), eq(membership.agencyId, t.agencyId), eq(membership.status, 'active')))
    .where(sql`lower(${user.email}) = ${email.from}`)
    .limit(1);
  if (!member) return { kind: 'dropped', reason: 'not an active member of the agency' };
  if (!email.dmarcPass) return { kind: 'dropped', reason: 'the sender could not be verified (DMARC)' };
  const body = stripQuotedReply(email.text);
  if (!body) return { kind: 'dropped', reason: 'empty once the quoted email was removed' };
  const actor: Actor = { userId: member.userId, agencyId: t.agencyId, membershipRole: member.role as MembershipRole };
  try {
    const { messageId } = await db.transaction((tx) => replyTeamThread(tx, actor, threadId, { body }, { channel: 'email', providerId: email.id }));
    return { kind: 'team', threadId, messageId };
  } catch (err) {
    if (err instanceof TeamMessageError) return { kind: 'dropped', reason: err.message };
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') return { kind: 'duplicate' };
    throw err;
  }
}
