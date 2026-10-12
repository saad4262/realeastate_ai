import { eq, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { listing, listingAgent } from '@repo/db';
import { can, type Actor } from '../permissions';

/** Live + under offer: what "Active listings" means everywhere (ADR 0027, ADR 0036 P5). */
export const ACTIVE_LISTING_STATUSES = ['live', 'under_offer'] as const;

/**
 * The listings an actor's FIGURES are made of (ADR 0036 P1): the agency's own,
 * and — for anyone without `listing:read_all` — only those they are named on
 * in listing_agent. Agency filter first; no agency is the zero UUID, so it
 * matches nothing. Opening one listing is still `listing:read`; this is for
 * counting and grouping rows, where an agent's numbers are their own.
 *
 * The predicates name the `listing` table, so the query must have it in its
 * FROM under that name (an alias would be a Postgres error, not a leak).
 */
export function listingScopeFilters(actor: Actor): SQL[] {
  const agencyId = actor.agencyId ?? '00000000-0000-0000-0000-000000000000';
  const filters: SQL[] = [eq(listing.agencyId, agencyId)];
  if (!can(actor, 'listing:read_all', { type: 'listing', agencyId })) {
    filters.push(sql`${listing.id} in (select ${listingAgent.listingId} from ${listingAgent} where ${listingAgent.userId} = ${actor.userId})`);
  }
  return filters;
}

/**
 * The listing's lead agent, as every figure counts it (ADR 0036 P4): the
 * listing_agent row with the LOWEST display_order, oldest first on a tie. Not
 * "the row at 0" — offboarding deletes a leaving lead agent's row and can
 * leave a co-agent at 1 with nobody at 0. One user id or null, so a listing
 * is never counted under two people.
 */
export function leadAgentIdSql(listingId: AnyColumn | SQL): SQL {
  return sql`(select la.user_id from listing_agent la where la.listing_id = ${listingId}
    order by la.display_order, la.created_at, la.user_id limit 1)`;
}
