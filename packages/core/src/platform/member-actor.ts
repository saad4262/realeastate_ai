import { desc, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '@repo/db';
import { agency, membership, user } from '@repo/db/schema';
import type { Actor, MembershipRole } from '../permissions';
import { accessBlock, type AccessBlock } from './access';

/**
 * Who a console user is, in ONE statement (V1-PERFORMANCE-PLAN steps 3–4):
 * - their membership (the active one wins: a removed member keeps a suspended row, ADR 0030);
 * - the agency's status, name and sends pause;
 * - their name;
 * - their listing links.
 *
 * No header counts: those are the chrome's alone. Polls, the bell and every server action used to pay for seven
 * count sub-queries they threw away.
 *
 * Shut out by the platform (ADR 0050), or no active membership: the actor has no agency, so every can() refuses,
 * and `blocked` says why.
 */
export type MemberContext = {
  actor: Actor;
  blocked: AccessBlock | null;
  agencyName: string | null;
  agencySlug: string | null;
  /** The agency's clock (never null in an agency), so a page needs no lookup of its own (step 5). */
  agencyTimeZone: string | null;
  userName: string | null;
  sendsPaused: { reason: string | null } | null;
};

export async function memberContext(db: DbOrTx, userId: string): Promise<MemberContext> {
  const [mem] = await db
    .select({
      agencyId: membership.agencyId,
      role: membership.role,
      status: membership.status,
      removedAt: membership.removedAt,
      agencyStatus: agency.status,
      agencyName: agency.name,
      agencySlug: agency.slug,
      agencyTimeZone: agency.timeZone,
      sendsPausedAt: agency.sendsPausedAt,
      sendsPausedReason: agency.sendsPausedReason,
      userName: user.name,
      links: sql<string[]>`coalesce((select json_agg(la.listing_id) from listing_agent la where la.user_id = ${userId}), '[]'::json)`,
    })
    .from(membership)
    .leftJoin(agency, eq(agency.id, membership.agencyId))
    .leftJoin(user, eq(user.id, membership.userId))
    .where(eq(membership.userId, userId))
    .orderBy(sql`(${membership.status} = 'active') desc`, desc(membership.updatedAt))
    .limit(1);

  const blocked = mem ? accessBlock({ membershipStatus: mem.status, removedAt: mem.removedAt, agencyStatus: mem.agencyStatus }) : null;
  if (!mem || mem.status !== 'active' || blocked) {
    return { actor: { userId }, blocked, agencyName: null, agencySlug: null, agencyTimeZone: null, userName: null, sendsPaused: null };
  }
  return {
    actor: { userId, agencyId: mem.agencyId, membershipRole: mem.role as MembershipRole, listingAgentOf: mem.links ?? [] },
    blocked: null,
    agencyName: mem.agencyName,
    agencySlug: mem.agencySlug,
    agencyTimeZone: mem.agencyTimeZone,
    userName: mem.userName,
    sendsPaused: mem.sendsPausedAt ? { reason: mem.sendsPausedReason } : null,
  };
}
