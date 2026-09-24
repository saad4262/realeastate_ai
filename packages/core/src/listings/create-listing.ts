import { listing, type Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import { attachListingAgents } from './listing-agents';
import {
  createListingInputSchema,
  ListingError,
  toListingError,
  type CreateListingInput,
} from './listing-schema';
import { money, resolvePin, upsertProperty } from './property-resolver';

const FORBIDDEN = new ListingError(
  'forbidden',
  'You do not have permission to create listings for this agency',
);

function requireAgency(actor: Actor): string {
  if (!actor.agencyId) throw FORBIDDEN;
  if (!can(actor, 'listing:create', { type: 'listing', agencyId: actor.agencyId })) {
    throw FORBIDDEN;
  }
  return actor.agencyId;
}

export type CreateListingResult = {
  listingId: string;
  propertyId: string;
  /** Always 'draft'. Non-negotiable #7: nothing is published on creation. */
  status: 'draft';
};

/**
 * Create a listing, reusing the property row when that address already exists.
 *
 * property and listing stay separate on purpose (non-negotiable #1): a house
 * sold in 2019 and re-listed today is one property with two listings, and the
 * history is the point. The agent link goes in listing_agent — listing has no
 * agent_id column and never will.
 */
export async function createListing(
  db: Db,
  actor: Actor,
  input: unknown,
): Promise<CreateListingResult> {
  const agencyId = requireAgency(actor);

  const parsed = createListingInputSchema.safeParse(input);
  if (!parsed.success) throw toListingError(parsed.error);
  const draft: CreateListingInput = parsed.data;

  // The geocoder call, before anything is opened. It is the one slow part of
  // this and it has no business holding a database connection.
  const pin = await resolvePin(db, draft.property);

  const l = draft.listing;

  /**
   * Property, listing and listing_agent, or none of them.
   *
   * These three rows are one fact — "this agency is advertising this house,
   * and these people answer the phone" — and the last of them can legitimately
   * fail: attachListingAgents refuses ids that are not members of the agency.
   * Written one at a time, that refusal left a listing with no agent behind it:
   * visible in the console, unreachable for an enquiry, and invisible as a
   * problem because nothing had reported an error.
   */
  return db.transaction(async (tx) => {
    // Find or create the address and keep its physical facts current. Shared
    // with updateListing so the two can never disagree about what counts as
    // the same dwelling.
    const propertyId = await upsertProperty(tx, draft.property, pin);

    const [created] = await tx
      .insert(listing)
      .values({
        propertyId,
        agencyId,
        channel: l.channel,
        status: 'draft',
        headline: l.headline,
        description: l.description || null,
        // Both forms are stored; the display string is never parsed back.
        priceDisplay: l.priceDisplay || null,
        priceFrom: money(l.priceFrom),
        priceTo: money(l.priceTo),
        rentPw: money(l.rentPw),
        availableFrom: l.availableFrom ?? null,
        auctionDate: l.auctionDate ?? null,
        source: 'portal',
      })
      .returning({ id: listing.id });

    if (!created) throw new ListingError('unknown', 'Could not save the listing');

    // The creator is the lead agent unless named agents were supplied, so no
    // listing is left with nobody to answer an enquiry.
    const agentIds = draft.agentUserIds.length ? draft.agentUserIds : [actor.userId];
    await attachListingAgents(tx, agencyId, created.id, agentIds);

    return { listingId: created.id, propertyId, status: 'draft' as const };
  });
}
