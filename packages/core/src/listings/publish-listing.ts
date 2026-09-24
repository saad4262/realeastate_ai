import { and, eq, sql } from 'drizzle-orm';
import { listing, type Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import { ListingError, type ListingStatus } from './listing-schema';

export type PublishListingResult = {
  listingId: string;
  status: ListingStatus;
  publishedAt: Date | null;
};

/**
 * Move a listing between draft and live.
 *
 * Kept apart from createListing on purpose (non-negotiable #7): nothing this
 * system writes reaches the public site without someone deciding to publish
 * it, and listing:publish is a narrower permission than listing:create.
 */
export async function setListingStatus(
  db: Db,
  actor: Actor,
  listingId: string,
  next: Extract<ListingStatus, 'draft' | 'live' | 'under_offer' | 'withdrawn'>,
): Promise<PublishListingResult> {
  if (!actor.agencyId) {
    throw new ListingError('forbidden', 'You do not have permission to publish this listing');
  }

  // Read the listing first so can() is asked about the agency that actually
  // owns it. Passing actor.agencyId as the resource made sameAgency() compare
  // the actor against itself, which always passed — the scoping was really
  // being done by the WHERE clause, and a refusal surfaced as "not found".
  const [target] = await db
    .select({ id: listing.id, agencyId: listing.agencyId })
    .from(listing)
    .where(eq(listing.id, listingId))
    .limit(1);

  if (!target) throw new ListingError('not_found', 'That listing no longer exists');

  // listing:publish checks listing_agent for non-admins, so the actor must
  // have been loaded with its links (loadListingActor, not loadActor).
  if (
    !can(actor, 'listing:publish', {
      type: 'listing',
      id: listingId,
      agencyId: target.agencyId,
    })
  ) {
    throw new ListingError('forbidden', 'You do not have permission to publish this listing');
  }

  const [row] = await db
    .update(listing)
    .set({
      status: next,
      // Stamped once, on the first time it goes live, so "new this week" stays
      // honest across later withdrawals and relistings.
      publishedAt:
        next === 'live' ? sql`coalesce(${listing.publishedAt}, now())` : listing.publishedAt,
      updatedAt: sql`now()`,
    })
    .where(and(eq(listing.id, listingId), eq(listing.agencyId, target.agencyId)))
    .returning({
      id: listing.id,
      status: listing.status,
      publishedAt: listing.publishedAt,
    });

  if (!row) throw new ListingError('not_found', 'That listing no longer exists');

  return {
    listingId: row.id,
    status: row.status as ListingStatus,
    publishedAt: row.publishedAt,
  };
}
