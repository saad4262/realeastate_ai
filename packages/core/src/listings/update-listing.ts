import { and, eq, sql } from 'drizzle-orm';
import { listing, type Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import { attachListingAgents } from './listing-agents';
import {
  ListingError,
  toListingError,
  updateListingInputSchema,
  type UpdateListingInput,
} from './listing-schema';
import { money, resolvePin, upsertProperty } from './property-resolver';

export type UpdateListingResult = {
  listingId: string;
  propertyId: string;
  /** Unchanged by an edit. Returned so the caller does not have to re-read. */
  status: string;
  /** True when the edit moved the listing to a different property row. */
  addressChanged: boolean;
};

/**
 * Edit an existing listing.
 *
 * Status is not a parameter. Publishing stays in setListingStatus behind its
 * own permission (non-negotiable #7), so correcting a typo on a live ad can
 * never be the thing that takes it off the public site — and fixing a draft
 * can never be the thing that puts it up.
 *
 * An edit may move the listing to a different address. The old property row is
 * left alone rather than rewritten: other listings and the sale history hang
 * off it, and a corrected street number on this campaign is not evidence that
 * the previous one was about a different house.
 */
export async function updateListing(
  db: Db,
  actor: Actor,
  listingId: string,
  input: unknown,
): Promise<UpdateListingResult> {
  if (!actor.agencyId) {
    throw new ListingError('forbidden', 'You do not have permission to edit this listing');
  }

  // Read the listing first so can() is asked about the agency that actually
  // owns it. Passing actor.agencyId as the resource would make sameAgency()
  // compare the actor against itself, which always passes, and a refusal would
  // then surface as "not found".
  const [target] = await db
    .select({
      id: listing.id,
      agencyId: listing.agencyId,
      propertyId: listing.propertyId,
      status: listing.status,
    })
    .from(listing)
    .where(eq(listing.id, listingId))
    .limit(1);

  if (!target) throw new ListingError('not_found', 'That listing no longer exists');

  // listing:edit consults listing_agent for anyone who is not an agency admin,
  // so the actor must have been loaded with its links (loadListingActor).
  if (
    !can(actor, 'listing:edit', {
      type: 'listing',
      id: listingId,
      agencyId: target.agencyId,
    })
  ) {
    throw new ListingError('forbidden', 'You do not have permission to edit this listing');
  }

  const parsed = updateListingInputSchema.safeParse(input);
  if (!parsed.success) throw toListingError(parsed.error);
  const draft: UpdateListingInput = parsed.data;

  // Outside the transaction: this is a network call, and a transaction holding
  // a connection open while Google thinks is a transaction nobody wants.
  const pin = await resolvePin(db, draft.property);
  const l = draft.listing;

  /**
   * The address, the ad and the agents move together or not at all.
   *
   * An edit can move the listing to a different property row and replace who
   * is named on it. Done one statement at a time, a refused agent list left the
   * listing pointing at the new address with the old agents — or with none.
   */
  return db.transaction(async (tx) => {
    const propertyId = await upsertProperty(tx, draft.property, pin);

    const [row] = await tx
      .update(listing)
      .set({
        propertyId,
        channel: l.channel,
        headline: l.headline,
        description: l.description || null,
        // Both forms are stored; the display string is never parsed back.
        priceDisplay: l.priceDisplay || null,
        priceFrom: money(l.priceFrom),
        priceTo: money(l.priceTo),
        rentPw: money(l.rentPw),
        availableFrom: l.availableFrom ?? null,
        auctionDate: l.auctionDate ?? null,
        updatedAt: sql`now()`,
      })
      // Scoped by agency as well as id: a stale listing id from another agency
      // must not be editable even if the can() above were ever loosened.
      .where(and(eq(listing.id, listingId), eq(listing.agencyId, target.agencyId)))
      .returning({ id: listing.id, status: listing.status, propertyId: listing.propertyId });

    if (!row) throw new ListingError('not_found', 'That listing no longer exists');

    // Omitted means "leave the agents alone". An empty array is rejected by
    // attachListingAgents rather than silently unassigning the listing.
    if (draft.agentUserIds) {
      await attachListingAgents(tx, target.agencyId, listingId, draft.agentUserIds, {
        replace: true,
      });
    }

    return {
      listingId: row.id,
      propertyId: row.propertyId,
      status: row.status,
      addressChanged: target.propertyId !== row.propertyId,
    };
  });
}
