import { and, eq, sql } from 'drizzle-orm';
import { lead, mailThread, type DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';
import { threadScopeFilters } from './threads';

/**
 * "Has anything arrived for me?" — for an open console to refresh itself the
 * moment the webhook stores an email (ADR 0035, instant delivery).
 *
 * The inbox used to refresh only when ITS OWN pull from Resend stored
 * something; once the webhook stores mail first, that pull finds nothing new
 * and the screen would sit stale. This asks the database instead.
 *
 * A stamp, not data: the newest activity on the conversations this person may
 * see (the inbox's own scope, `threadScopeFilters`), on the team conversations
 * they are on, and in their bell. It changes when any of them does; the
 * browser compares it with the last one and refreshes. It says nothing a
 * screen would not — no ids, no text. One statement.
 */
export async function consoleLiveStamp(db: DbOrTx, actor: Actor): Promise<string> {
  if (!actor.agencyId || !actor.membershipRole) return '';
  const agencyId = actor.agencyId;
  const team = sql<string | null>`(
    select max(x.created_at)::text from team_message x
    join team_thread_member me on me.thread_id = x.thread_id and me.user_id = ${actor.userId}
    where x.agency_id = ${agencyId}
  )`;
  const bell = sql<string | null>`(
    select max(n.created_at)::text from notification n
    where n.user_id = ${actor.userId} and n.agency_id = ${agencyId}
  )`;

  if (!can(actor, 'mail:read', { type: 'mail_thread', agencyId })) {
    const [row] = await db.execute<{ team: string | null; bell: string | null }>(sql`select ${team} as team, ${bell} as bell`);
    return `-|${row?.team ?? ''}|${row?.bell ?? ''}`;
  }
  const [row] = await db
    .select({
      mail: sql<string | null>`max(${mailThread.lastMessageAt})::text`,
      threads: sql<number>`count(*)::int`,
      team,
      bell,
    })
    .from(mailThread)
    .leftJoin(lead, eq(lead.id, mailThread.leadId))
    .where(and(...threadScopeFilters(db, actor)));
  return `${row?.mail ?? ''}:${row?.threads ?? 0}|${row?.team ?? ''}|${row?.bell ?? ''}`;
}
