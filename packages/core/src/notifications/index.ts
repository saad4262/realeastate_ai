import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { notification, type DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';

/**
 * The console bell (ADR 0032 §4): a member's own notifications — today only
 * "your meeting starts soon", written by the reminder tick. Only the person a
 * row is for reads it or marks it read; the query is narrowed to them, and
 * can() is asked for the list as a whole.
 */

export type NotificationView = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  href: string | null;
  joinUrl: string | null;
  createdAt: Date;
  readAt: Date | null;
};

export type NotificationList = { rows: NotificationView[]; unread: number };

const LIST_LIMIT = 20;

function mine(actor: Actor) {
  return { type: 'notification', agencyId: actor.agencyId ?? undefined, ownerId: actor.userId };
}

/** The latest 20, newest first, and how many are unread in all. One statement. */
export async function listNotifications(db: DbOrTx, actor: Actor): Promise<NotificationList> {
  if (!actor.agencyId || !can(actor, 'notification:read', mine(actor))) return { rows: [], unread: 0 };
  const rows = await db
    .select({
      id: notification.id,
      kind: notification.kind,
      title: notification.title,
      body: notification.body,
      href: notification.href,
      joinUrl: notification.joinUrl,
      createdAt: notification.createdAt,
      readAt: notification.readAt,
      unread: sql<number>`(select count(*)::int from ${notification} n where n.user_id = ${actor.userId} and n.agency_id = ${actor.agencyId} and n.read_at is null)`,
    })
    .from(notification)
    .where(and(eq(notification.userId, actor.userId), eq(notification.agencyId, actor.agencyId)))
    .orderBy(desc(notification.createdAt), desc(notification.id))
    .limit(LIST_LIMIT);
  return { rows: rows.map(({ unread: _u, ...r }) => r), unread: rows[0]?.unread ?? 0 };
}

const idsSchema = z.array(z.string().uuid()).max(LIST_LIMIT);

/** Mark some of MY notifications read — or all of them, with `'all'`. Others' ids are ignored. */
export async function markNotificationsRead(db: DbOrTx, actor: Actor, ids: string[] | 'all'): Promise<number> {
  if (!actor.agencyId || !can(actor, 'notification:update', mine(actor))) return 0;
  const which = ids === 'all' ? null : idsSchema.safeParse(ids);
  if (which && (!which.success || !which.data.length)) return 0;
  const done = await db
    .update(notification)
    .set({ readAt: sql`now()` })
    .where(
      and(
        eq(notification.userId, actor.userId),
        eq(notification.agencyId, actor.agencyId),
        isNull(notification.readAt),
        ...(which ? [inArray(notification.id, which.data!)] : []),
      ),
    )
    .returning({ id: notification.id });
  return done.length;
}
