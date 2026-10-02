import { cache } from 'react';
import { eq, sql } from 'drizzle-orm';
import { agency, listingAgent, membership, user } from '@repo/db/schema';
import { can, type Actor, type MembershipRole } from '@repo/core/permissions';
import { getConsoleDb } from './db';

/**
 * Build a can() actor from the membership row.
 *
 * Deliberately does NOT load listing_agent links: they are only consulted by
 * listing:edit / listing:publish, and fetching them on every page cost a
 * round trip to the database region on navigations that never ask. Anything
 * deciding on a specific listing must use loadListingActor instead — an actor
 * without links fails those checks closed.
 */
export type ActorContext = {
  actor: Actor;
  /** For chrome only — never a permission input; those stay in can(). */
  agencyName: string | null;
  agencySlug: string | null;
  /** Our own mirror of the name, so the chrome never needs the auth service. */
  userName: string | null;
  /**
   * Counts for the console header. Sub-selected in the same statement so the
   * chrome still costs one round trip, and every figure comes from SQL —
   * the header used to show invented market stats.
   */
  summary: {
    members: number;
    liveListings: number;
    pendingInvites: number;
    /**
     * Unactioned private offers, and ZERO for anyone who may not read one.
     *
     * Counted in SQL for everybody and zeroed below by can(), rather than
     * conditionally selected — the query shape stays fixed at one statement,
     * and the disclosure decision stays in permissions.ts where #2 requires it.
     * A badge saying 3 to an assistant would disclose most of what
     * `lead:read_offer` exists to withhold.
     */
    newOffers: number;
  };
};

/**
 * Actor plus the agency's display name, in a single query.
 *
 * The name is joined here rather than fetched by the shell so the console
 * chrome costs one round trip, not two — the database is a region away and
 * every navigation pays it.
 */
async function queryActorContext(userId: string): Promise<ActorContext | null> {
  const url = process.env.DATABASE_URL;
  if (!url || url.includes('YOUR_PASSWORD')) return null;

  const db = getConsoleDb();
  const [mem] = await db
    .select({
      agencyId: membership.agencyId,
      role: membership.role,
      status: membership.status,
      agencyName: agency.name,
      agencySlug: agency.slug,
      userName: user.name,
      members: sql<number>`(
        select count(*) from membership m2
        where m2.agency_id = ${membership.agencyId} and m2.status = 'active'
      )`,
      liveListings: sql<number>`(
        select count(*) from listing l
        where l.agency_id = ${membership.agencyId} and l.status = 'live'
      )`,
      pendingInvites: sql<number>`(
        select count(*) from agent_invite i
        where i.agency_id = ${membership.agencyId}
          and i.status = 'pending' and i.expires_at > now()
      )`,
      newOffers: sql<number>`(
        select count(*) from lead l
        where l.agency_id = ${membership.agencyId}
          and l.kind = 'offer' and l.status = 'new'
      )`,
    })
    .from(membership)
    .leftJoin(agency, eq(agency.id, membership.agencyId))
    .leftJoin(user, eq(user.id, membership.userId))
    .where(eq(membership.userId, userId))
    .limit(1);

  const empty = { members: 0, liveListings: 0, pendingInvites: 0, newOffers: 0 };

  if (!mem || mem.status !== 'active') {
    return {
      actor: { userId },
      agencyName: null,
      agencySlug: null,
      userName: null,
      summary: empty,
    };
  }

  const actor: Actor = {
    userId,
    agencyId: mem.agencyId,
    membershipRole: mem.role as MembershipRole,
  };

  // The same question the inbox asks. Asked here too so the chrome cannot
  // disclose by counting what the screen would refuse to show.
  const maySeeOffers = can(actor, 'lead:read_offer', {
    type: 'lead',
    agencyId: mem.agencyId,
  });

  return {
    actor,
    agencyName: mem.agencyName,
    agencySlug: mem.agencySlug,
    userName: mem.userName,
    summary: {
      members: Number(mem.members ?? 0),
      liveListings: Number(mem.liveListings ?? 0),
      pendingInvites: Number(mem.pendingInvites ?? 0),
      newOffers: maySeeOffers ? Number(mem.newOffers ?? 0) : 0,
    },
  };
}

/**
 * Cached for the life of one request.
 *
 * The chrome (agency name, header counts) and the permission gate both need
 * this context, and they now run as two separate components so the shell can
 * paint before either finishes. Without the cache that split would have turned
 * one round trip to a database a region away into two.
 */
export const loadActorContext = cache(queryActorContext);

export async function loadActor(userId: string): Promise<Actor | null> {
  return (await loadActorContext(userId))?.actor ?? null;
}

/**
 * The same actor plus its listing_agent links, for pages that decide on a
 * specific listing. Kept separate so the console chrome does not pay for it.
 */
export async function loadListingActor(userId: string): Promise<Actor | null> {
  const actor = await loadActor(userId);
  if (!actor?.agencyId) return actor;

  const db = getConsoleDb();
  const links = await db
    .select({ listingId: listingAgent.listingId })
    .from(listingAgent)
    .where(eq(listingAgent.userId, userId));

  return { ...actor, listingAgentOf: links.map((l) => l.listingId) };
}
