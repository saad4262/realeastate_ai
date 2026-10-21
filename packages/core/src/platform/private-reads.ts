import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { assistantConversation, assistantTurn, teamMessage, teamThread, user, type Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import { snippet } from '../mail/body';
import { PlatformError, requirePlatformView } from './admin';

/**
 * The two things an agency owner may NOT read, read by the admin console
 * (ADR 0049, the user's decision: the platform admin reads everything).
 *
 * Team conversations are their participants' and an assistant conversation is
 * its author's — `team_message:read` and `assistant_conversation:read` have no
 * admin exception on purpose (permissions.ts). So these readers are separate
 * from the agency's own and run only under a `platform` view: an owner's
 * actor, however it is built, gets `forbidden` here. Nothing in them writes —
 * no read marks, no "seen" — so a person's unread state is untouched by an
 * admin looking.
 */

const UUID = /^[0-9a-f-]{36}$/i;

function nameSql(alias: string) {
  return sql.raw(`coalesce(nullif(${alias}.name, ''), ${alias}.email)`);
}

// ── Team conversations ────────────────────────────────────────────────────

export type PlatformTeamThreadRow = {
  id: string;
  subject: string;
  people: string[];
  preview: string;
  messages: number;
  lastMessageAt: Date;
};

/**
 * The agency's team conversations, newest first. With a member's view, only
 * the ones they are on; with the agency's, every one. One statement.
 */
export async function listPlatformTeamThreads(db: Db, view: Actor, opts: { limit?: number } = {}): Promise<PlatformTeamThreadRow[]> {
  requirePlatformView(view);
  if (!can(view, 'team_message:read', { type: 'team_thread', agencyId: view.agencyId })) {
    throw new PlatformError('forbidden', 'Team messages are not readable here');
  }
  const memberOnly = view.userId !== view.viewerId;
  const rows = await db
    .select({
      id: teamThread.id,
      subject: teamThread.subject,
      lastMessageAt: teamThread.lastMessageAt,
      people: sql<string[] | null>`(
        select array_agg(${nameSql('u')} order by lower(${nameSql('u')}))
        from team_thread_member p join "user" u on u.id = p.user_id
        where p.thread_id = team_thread.id
      )`,
      lastText: sql<string | null>`(
        select m.text from team_message m where m.thread_id = team_thread.id
        order by m.created_at desc, m.id desc limit 1
      )`,
      messages: sql<number>`(select count(*)::int from team_message m where m.thread_id = team_thread.id)`,
    })
    .from(teamThread)
    .where(
      and(
        eq(teamThread.agencyId, view.agencyId),
        memberOnly
          ? sql`exists (select 1 from team_thread_member me where me.thread_id = team_thread.id and me.user_id = ${view.userId})`
          : undefined,
      ),
    )
    .orderBy(desc(teamThread.lastMessageAt), desc(teamThread.id))
    .limit(Math.min(opts.limit ?? 100, 200));
  return rows.map((r) => ({
    id: r.id,
    subject: r.subject,
    people: r.people ?? [],
    preview: snippet(r.lastText ?? ''),
    messages: Number(r.messages ?? 0),
    lastMessageAt: new Date(r.lastMessageAt),
  }));
}

export type PlatformTeamThread = {
  id: string;
  subject: string;
  people: string[];
  messages: { id: string; senderName: string; text: string; channel: string; createdAt: Date }[];
};

/** One team conversation in this agency, oldest message first. Two statements. */
export async function getPlatformTeamThread(db: Db, view: Actor, threadId: string): Promise<PlatformTeamThread> {
  requirePlatformView(view);
  const notFound = () => new PlatformError('not_found', 'That conversation was not found');
  if (!UUID.test(threadId) || !can(view, 'team_message:read', { type: 'team_thread', agencyId: view.agencyId })) throw notFound();
  const [head] = await db
    .select({
      id: teamThread.id,
      subject: teamThread.subject,
      people: sql<string[] | null>`(
        select array_agg(${nameSql('u')} order by lower(${nameSql('u')}))
        from team_thread_member p join "user" u on u.id = p.user_id
        where p.thread_id = team_thread.id
      )`,
    })
    .from(teamThread)
    .where(and(eq(teamThread.id, threadId), eq(teamThread.agencyId, view.agencyId)))
    .limit(1);
  if (!head) throw notFound();
  const messages = await db
    .select({
      id: teamMessage.id,
      senderName: user.name,
      senderEmail: user.email,
      text: teamMessage.text,
      channel: teamMessage.channel,
      createdAt: teamMessage.createdAt,
    })
    .from(teamMessage)
    .leftJoin(user, eq(user.id, teamMessage.senderId))
    .where(eq(teamMessage.threadId, head.id))
    .orderBy(asc(teamMessage.createdAt), asc(teamMessage.id));
  return {
    id: head.id,
    subject: head.subject,
    people: head.people ?? [],
    messages: messages.map((m) => ({
      id: m.id,
      senderName: m.senderEmail ? m.senderName?.trim() || m.senderEmail : 'A former member',
      text: m.text,
      channel: m.channel,
      createdAt: new Date(m.createdAt),
    })),
  };
}

// ── Assistant conversations ───────────────────────────────────────────────

export type PlatformChatRow = { id: string; title: string; surface: string; turnCount: number; lastTurnAt: Date };

/** One member's assistant conversations in this agency, newest first. One statement. */
export async function listPlatformAssistantChats(db: Db, view: Actor, opts: { limit?: number } = {}): Promise<PlatformChatRow[]> {
  requirePlatformView(view);
  if (view.userId === view.viewerId) {
    // The agency as a whole has no assistant conversations; a member does.
    throw new PlatformError('forbidden', 'Open a member to read their assistant conversations');
  }
  const rows = await db
    .select({
      id: assistantConversation.id,
      title: assistantConversation.title,
      surface: assistantConversation.surface,
      turnCount: assistantConversation.turnCount,
      lastTurnAt: assistantConversation.lastTurnAt,
    })
    .from(assistantConversation)
    .where(and(eq(assistantConversation.agencyId, view.agencyId), eq(assistantConversation.userId, view.userId)))
    .orderBy(desc(assistantConversation.lastTurnAt))
    .limit(Math.min(opts.limit ?? 50, 200));
  return rows.map((r) => ({ ...r, lastTurnAt: new Date(r.lastTurnAt) }));
}

export type PlatformChat = {
  id: string;
  title: string;
  turns: { seq: number; status: string; userText: string; answer: string; error: string | null; createdAt: Date }[];
};

/** One of this member's assistant conversations, turn by turn. Two statements. */
export async function getPlatformAssistantChat(db: Db, view: Actor, conversationId: string): Promise<PlatformChat> {
  requirePlatformView(view);
  const notFound = () => new PlatformError('not_found', 'That conversation was not found');
  if (!UUID.test(conversationId)) throw notFound();
  const [c] = await db
    .select({ id: assistantConversation.id, title: assistantConversation.title, agencyId: assistantConversation.agencyId, userId: assistantConversation.userId })
    .from(assistantConversation)
    .where(and(eq(assistantConversation.id, conversationId), eq(assistantConversation.agencyId, view.agencyId), eq(assistantConversation.userId, view.userId)))
    .limit(1);
  if (!c || !can(view, 'assistant_conversation:read', { type: 'assistant_conversation', id: c.id, agencyId: c.agencyId, ownerId: c.userId })) {
    throw notFound();
  }
  const turns = await db
    .select({
      seq: assistantTurn.seq,
      status: assistantTurn.status,
      userText: assistantTurn.userText,
      answer: assistantTurn.answer,
      error: assistantTurn.error,
      createdAt: assistantTurn.createdAt,
    })
    .from(assistantTurn)
    .where(eq(assistantTurn.conversationId, c.id))
    .orderBy(asc(assistantTurn.seq));
  return { id: c.id, title: c.title, turns: turns.map((t) => ({ ...t, createdAt: new Date(t.createdAt) })) };
}
