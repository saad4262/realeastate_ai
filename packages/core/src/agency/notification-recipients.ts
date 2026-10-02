import { and, eq, inArray } from 'drizzle-orm';
import { membership, user, type Db } from '@repo/db';

export type NotificationRecipient = {
  userId: string;
  email: string;
  name: string | null;
};

/**
 * Who at an agency should hear about something that just arrived.
 *
 * `agency` has no email column, deliberately — a shared inbox nobody owns is
 * where leads go to die. So the recipients are people: the agency's active
 * owners and admins, resolved through `membership` to `user.email`.
 *
 * Owners and admins only, not every member. A private offer on a past sale is
 * commercially sensitive and goes to whoever runs the agency, who can pass it to
 * the agent who handled the sale. Widening this to `agent` would mail an offer to
 * everyone who has ever had a login there.
 *
 * `status = 'active'` matters as much: a membership that was revoked is somebody
 * who has left, and they must stop receiving the agency's mail the moment they
 * do.
 *
 * One query. The tempting shape — list the memberships, then look up each user —
 * is an N+1 that grows with the size of the agency, and `query-count.test.ts`
 * holds this to its number.
 */
export async function agencyNotificationRecipients(
  db: Db,
  agencyId: string,
): Promise<NotificationRecipient[]> {
  const rows = await db
    .select({ userId: user.id, email: user.email, name: user.name })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(
      and(
        eq(membership.agencyId, agencyId),
        eq(membership.status, 'active'),
        inArray(membership.role, ['owner', 'admin']),
      ),
    );

  return rows;
}
