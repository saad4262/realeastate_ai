import { and, eq, inArray, sql } from 'drizzle-orm';
import { listing, type DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';
import { ListingError } from './listing-schema';

/** One call approves at most this many; "approve all" says so when there are more. */
export const APPROVE_BATCH_MAX = 500;

export type ApproveListingsResult = {
  /** Listings that went from pending to live. */
  approved: number;
  /** Ids asked for that were not pending any more (approved, sent back or withdrawn meanwhile). */
  skipped: number;
  /** Pending listings still waiting after this call (only when "all" hit the cap). */
  remaining: number;
};

/**
 * Approve waiting listings in one go (ADR 0014, in bulk).
 *
 * `ids` picks listings; leaving it out means every listing of the agency that is
 * waiting. Each one is still the single-listing approval: `listing:publish`
 * asked for each listing's own agency, and the UPDATE itself only moves a row
 * that is STILL pending, so a listing sent back or withdrawn in another tab is
 * skipped rather than put live. Two statements however many listings — never one
 * per row. Callers pass a transaction when they want it atomic with other writes.
 */
export async function approveListings(
  db: DbOrTx,
  actor: Actor,
  options: { ids?: string[] } = {},
): Promise<ApproveListingsResult> {
  if (!actor.agencyId) {
    throw new ListingError('forbidden', 'Only an agency owner or admin can publish a listing');
  }
  const ids = options.ids ? [...new Set(options.ids)] : undefined;
  if (ids && ids.length === 0) return { approved: 0, skipped: 0, remaining: 0 };
  if (ids && ids.length > APPROVE_BATCH_MAX) {
    throw new ListingError('invalid_draft', `Approve at most ${APPROVE_BATCH_MAX} listings at a time`);
  }

  const targets = await db
    .select({ id: listing.id, agencyId: listing.agencyId })
    .from(listing)
    .where(
      and(
        eq(listing.agencyId, actor.agencyId),
        eq(listing.status, 'pending'),
        ids ? inArray(listing.id, ids) : undefined,
      ),
    )
    .limit(APPROVE_BATCH_MAX + 1);

  // can() per listing, in memory: the rule is asked about the agency that owns
  // each one, never about the actor's own.
  const allowed = targets
    .slice(0, APPROVE_BATCH_MAX)
    .filter((t) => can(actor, 'listing:publish', { type: 'listing', id: t.id, agencyId: t.agencyId }));
  if (targets.length > 0 && allowed.length === 0) {
    throw new ListingError('forbidden', 'Only an agency owner or admin can publish a listing');
  }

  const rows = allowed.length
    ? await db
        .update(listing)
        .set({
          status: 'live',
          publishedAt: sql`coalesce(${listing.publishedAt}, now())`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            inArray(listing.id, allowed.map((t) => t.id)),
            eq(listing.agencyId, actor.agencyId),
            // The approval guard again, in the write: only what is still waiting.
            eq(listing.status, 'pending'),
          ),
        )
        .returning({ id: listing.id })
    : [];

  return {
    approved: rows.length,
    skipped: ids ? ids.length - rows.length : 0,
    remaining: ids ? 0 : Math.max(0, targets.length - APPROVE_BATCH_MAX),
  };
}
