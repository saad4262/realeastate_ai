import { and, eq } from 'drizzle-orm';
import { listing, type Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import { ListingError, type ListingStatus } from './listing-schema';

/**
 * Statuses a listing cannot be deleted from.
 *
 * Live and under-offer are refused because deleting them is almost always a
 * mistake for the wrong reason — someone wanting the ad off the site, which is
 * what withdraw is for. Sold and leased are refused because they are the
 * agency's record of a completed transaction; in NSW that record is wanted
 * years later, and no UI button should be able to erase it.
 */
const UNDELETABLE: Record<string, string> = {
  live: 'Withdraw this listing first — deleting a live ad is almost never what is meant.',
  under_offer: 'This listing is under offer. Withdraw it first if it really should go.',
  sold: 'Sold listings are the agency’s record of the sale and cannot be deleted.',
};

export type DeleteListingResult = {
  listingId: string;
  /** Kept, always. The place outlives every ad ever written about it. */
  propertyId: string;
};

/**
 * Delete a listing for good.
 *
 * The property row is never touched — non-negotiable #1: the physical place is
 * permanent and shared, and removing it would take the sale history of every
 * other campaign at that address with it.
 *
 * Everything that belongs to this listing alone goes with it, by foreign key
 * cascade: listing_agent, media, inspections and leads. That is deliberate and
 * it is why the permission is admin-only.
 */
export async function deleteListing(
  db: Db,
  actor: Actor,
  listingId: string,
): Promise<DeleteListingResult> {
  if (!actor.agencyId) {
    throw new ListingError('forbidden', 'You do not have permission to delete this listing');
  }

  const [target] = await db
    .select({ id: listing.id, agencyId: listing.agencyId, propertyId: listing.propertyId, status: listing.status })
    .from(listing)
    .where(eq(listing.id, listingId))
    .limit(1);

  if (!target) throw new ListingError('not_found', 'That listing no longer exists');

  if (
    !can(actor, 'listing:delete', {
      type: 'listing',
      id: listingId,
      agencyId: target.agencyId,
    })
  ) {
    throw new ListingError(
      'forbidden',
      'Only an agency owner or admin can delete a listing',
    );
  }

  const refusal = UNDELETABLE[target.status as ListingStatus];
  if (refusal) throw new ListingError('conflict', refusal);

  const [row] = await db
    .delete(listing)
    .where(and(eq(listing.id, listingId), eq(listing.agencyId, target.agencyId)))
    .returning({ id: listing.id, propertyId: listing.propertyId });

  if (!row) throw new ListingError('not_found', 'That listing no longer exists');

  return { listingId: row.id, propertyId: row.propertyId };
}
