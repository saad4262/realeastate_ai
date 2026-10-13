import { and, eq } from 'drizzle-orm';
import { listing, listingAgent, membership, type DbOrTx } from '@repo/db';
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
  // The listings they are named on, as the console's own actor carries them (apps/console
  // lib/load-actor.ts): without them, work run later judged "a lead on my listing" more
  // narrowly than the screen does (found by ADR 0040's task smoke).
  const links = await db
    .select({ listingId: listingAgent.listingId })
    .from(listingAgent)
    .innerJoin(listing, eq(listing.id, listingAgent.listingId))
    .where(and(eq(listingAgent.userId, userId), eq(listing.agencyId, agencyId)));
  return { userId, agencyId, membershipRole: m.role as MembershipRole, listingAgentOf: links.map((l) => l.listingId) };
}
