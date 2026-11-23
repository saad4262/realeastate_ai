import { cache } from 'react';
import { sql } from 'drizzle-orm';
import { can, mfaMark, type Actor } from '@repo/core/permissions';
import { narrowedContactIdsSql } from '@repo/core/contacts';
import { type AccessBlock } from '@repo/core/platform/access';
import { memberContext } from '@repo/core/platform/member-actor';
import { getConsoleDb } from './db';
import { sessionAuth } from './session-aal';

/**
 * Who the request is, for the gate, every page and every action: one light statement (memberContext). The header's
 * counts are NOT here (V1-PERFORMANCE-PLAN step 4): they are the chrome's alone (loadHeaderCounts). Polls, the bell
 * and every server action used to pay for seven count sub-queries they threw away.
 *
 * The actor carries no listing_agent links: they are only consulted by listing:edit / listing:publish, and anything
 * deciding on a specific listing uses loadListingActor, which takes them from the same statement. An actor without
 * links fails those checks closed.
 */
export type ActorContext = {
  actor: Actor;
  /** The actor's listing links, read in the same statement; only loadListingActor puts them on an actor. */
  listingAgentOf: string[];
  /** For chrome only — never a permission input; those stay in can(). */
  agencyName: string | null;
  agencySlug: string | null;
  /** The agency's clock, from the same statement (V1-PERFORMANCE-PLAN step 5). */
  agencyTimeZone: string | null;
  /** Our own mirror of the name, so the chrome never needs the auth service. */
  userName: string | null;
  /**
   * Set when the platform shut this person out (ADR 0050): their agency is
   * suspended, or their membership blocked. The actor then has no agency, so
   * every can() refuses; the gate uses this only to say why.
   */
  blocked?: AccessBlock;
  /**
   * PLATFORM-PLAN 3.7: the agency's sends are paused (a spike, or by hand). `mayResume` is can()'s answer for
   * this actor, so the banner offers the button only to whoever the server would let press it.
   */
  sendsPaused: { reason: string | null; mayResume: boolean } | null;
};

/** Counts for the console header, every figure from SQL — the header used to show invented market stats. */
export type HeaderCounts = {
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
  /**
   * Conversations with something this person has not opened (ADR 0016) —
   * the Inbox badge. Two counts come back from SQL, the whole agency's and
   * this member's own leads', and can() picks one below, the same way
   * `newOffers` is zeroed: the query shape stays fixed and the disclosure
   * decision stays in permissions.ts.
   */
  unreadMail: number;
  /** Team conversations (ADR 0035) with a message this person has not opened — only ones they are on. */
  unreadTeam: number;
};

export const NO_COUNTS: HeaderCounts = { members: 0, liveListings: 0, pendingInvites: 0, newOffers: 0, unreadMail: 0, unreadTeam: 0 };

async function queryActorContext(userId: string): Promise<ActorContext | null> {
  const url = process.env.DATABASE_URL;
  if (!url || url.includes('YOUR_PASSWORD')) return null;

  const m = await memberContext(getConsoleDb(), userId);
  // Suspended agency, blocked member or no active membership (ADR 0050): no agency on the actor, so nothing passes can().
  if (!m.actor.agencyId) {
    return { actor: { userId }, listingAgentOf: [], agencyName: null, agencySlug: null, agencyTimeZone: null, userName: null, sendsPaused: null, ...(m.blocked ? { blocked: m.blocked } : {}) };
  }
  const agencyId = m.actor.agencyId;
  const actor: Actor = { userId, agencyId, membershipRole: m.actor.membershipRole };
  // PLATFORM-PLAN 1.3: owners and admins without a second factor are marked, and can() keeps billing and team shut.
  Object.assign(actor, mfaMark(actor, await sessionAuth(userId)));
  return {
    actor,
    listingAgentOf: m.actor.listingAgentOf ?? [],
    agencyName: m.agencyName,
    agencySlug: m.agencySlug,
    agencyTimeZone: m.agencyTimeZone,
    userName: m.userName,
    sendsPaused: m.sendsPaused ? { reason: m.sendsPaused.reason, mayResume: can(actor, 'sends:resume', { type: 'agency', agencyId }) } : null,
  };
}

/**
 * Cached for the life of one request.
 *
 * The chrome (agency name, header counts) and the permission gate both need
 * this context, and they run as two separate components so the shell can
 * paint before either finishes. Without the cache that split would have turned
 * one round trip into two.
 */
export const loadActorContext = cache(queryActorContext);

export async function loadActor(userId: string): Promise<Actor | null> {
  return (await loadActorContext(userId))?.actor ?? null;
}

/**
 * The same actor plus its listing_agent links, for pages and actions that decide on a specific listing, and for
 * /api/live. From the request's cached context: no statement of its own on a page that already has the actor, one
 * light statement in a route (V1-PERFORMANCE-PLAN steps 3–4).
 */
export async function loadListingActor(userId: string): Promise<Actor | null> {
  const context = await loadActorContext(userId);
  if (!context) return null;
  if (!context.actor.agencyId) return context.actor;
  return { ...context.actor, listingAgentOf: context.listingAgentOf };
}

/**
 * The header's counts: the chrome's alone, one statement, after the actor (its can() answers narrow two of them).
 * Never awaited by the gate, a page or an action.
 */
async function queryHeaderCounts(userId: string): Promise<HeaderCounts> {
  const context = await loadActorContext(userId);
  const actor = context?.actor;
  if (!actor?.agencyId) return NO_COUNTS;
  const agencyId = actor.agencyId;

  const [row] = await getConsoleDb().execute<{
    members: number; live_listings: number; pending_invites: number; new_offers: number; unread_mail_all: number; unread_mail_mine: number; unread_team: number;
  }>(sql`
    select
      (select count(*) from membership m2 where m2.agency_id = ${agencyId} and m2.status = 'active') as members,
      (select count(*) from listing l where l.agency_id = ${agencyId} and l.status = 'live') as live_listings,
      (select count(*) from agent_invite i where i.agency_id = ${agencyId} and i.status = 'pending' and i.expires_at > now()) as pending_invites,
      (select count(*) from lead l where l.agency_id = ${agencyId} and l.kind = 'offer' and l.status = 'new') as new_offers,
      (select count(*) from mail_thread t
        left join mail_read r on r.thread_id = t.id and r.user_id = ${userId}
        where t.agency_id = ${agencyId}
          and t.last_inbound_at > coalesce(r.last_read_at, '-infinity'::timestamptz)) as unread_mail_all,
      -- The same threads /my-inbox lists: their leads' conversations, and mail to the agency address from a contact
      -- they may see (ADR 0018).
      (select count(*) from mail_thread t
        left join lead l on l.id = t.lead_id
        left join mail_read r on r.thread_id = t.id and r.user_id = ${userId}
        where t.agency_id = ${agencyId}
          and (
            (l.id is not null and l.kind <> 'offer'
              and (l.assigned_to = ${userId}
                or l.listing_id in (select la.listing_id from listing_agent la where la.user_id = ${userId})))
            or (t.lead_id is null
              and t.contact_id in (${narrowedContactIdsSql(userId, sql`${agencyId}`)}))
          )
          and t.last_inbound_at > coalesce(r.last_read_at, '-infinity'::timestamptz)) as unread_mail_mine,
      (select count(*) from team_thread_member me
        join team_thread tt on tt.id = me.thread_id and tt.agency_id = ${agencyId}
        where me.user_id = ${userId}
          and exists (
            select 1 from team_message x
            where x.thread_id = tt.id and x.sender_id is distinct from ${userId}
              and x.created_at > coalesce(me.last_read_at, '-infinity'::timestamptz)
          )) as unread_team`);

  // The same question the inbox asks. Asked here too so the chrome cannot
  // disclose by counting what the screen would refuse to show.
  const maySeeOffers = can(actor, 'lead:read_offer', { type: 'lead', agencyId });
  // The whole agency's count only for whoever may read every thread in it,
  // offers included; anybody else gets their own leads' count. Should those
  // two permissions ever part, the narrower count is the safe one to show.
  const seesAllMail = maySeeOffers && can(actor, 'lead:read_all', { type: 'lead', agencyId });
  return {
    members: Number(row?.members ?? 0),
    liveListings: Number(row?.live_listings ?? 0),
    pendingInvites: Number(row?.pending_invites ?? 0),
    newOffers: maySeeOffers ? Number(row?.new_offers ?? 0) : 0,
    unreadMail: Number((seesAllMail ? row?.unread_mail_all : row?.unread_mail_mine) ?? 0),
    unreadTeam: Number(row?.unread_team ?? 0),
  };
}

export const loadHeaderCounts = cache(queryHeaderCounts);
