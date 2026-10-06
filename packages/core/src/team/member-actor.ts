import { and, eq } from 'drizzle-orm';
import { membership, type DbOrTx } from '@repo/db';
import type { Actor, MembershipRole } from '../permissions';

/**
 * The actor for work that runs without a request — an import chunk on the
 * cron tick, a scheduled assistant action — rebuilt from the membership AS IT
 * IS NOW. Null when the person is no longer an active member of that agency:
 * the job then stops rather than acting for someone who has left.
 */
export async function activeMemberActor(db: DbOrTx, userId: string, agencyId: string): Promise<Actor | null> {
  const [m] = await db
    .select({ role: membership.role, status: membership.status })
    .from(membership)
    .where(and(eq(membership.userId, userId), eq(membership.agencyId, agencyId)))
    .limit(1);
  if (!m || m.status !== 'active') return null;
  return { userId, agencyId, membershipRole: m.role as MembershipRole };
}
