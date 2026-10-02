import { and, eq, sql } from 'drizzle-orm';
import { listing, type DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';
import {
  ListingError,
  soldDetailsSchema,
  type ListingStatus,
  type SoldDetails,
} from './listing-schema';

export type PublishListingResult = {
  listingId: string;
  status: ListingStatus;
  publishedAt: Date | null;
};

/** The statuses a person may move a listing to by hand. */
export type SettableStatus = Extract<
  ListingStatus,
  'draft' | 'live' | 'under_offer' | 'sold' | 'withdrawn'
>;

/**
 * Move a listing through its life.
 *
 * Kept apart from createListing on purpose (non-negotiable #7): nothing this
 * system writes reaches the public site without someone deciding to publish
 * it, and listing:publish is a narrower permission than listing:create.
 *
 * `'sold'` is the one transition that carries data with it, and the one that
 * needs a different permission — see the two branches below. It is also the
 * only way a sale is ever recorded: `updateListing` cannot touch these columns,
 * so a sale price is always something somebody typed into a sale, never a side
 * effect of an edit.
 *
 * `'pending'` is deliberately absent. Nothing reads it and no screen offers it.
 */
export async function setListingStatus(
  db: DbOrTx,
  actor: Actor,
  listingId: string,
  next: SettableStatus,
  /** Required when `next` is `'sold'`, refused otherwise. */
  sold?: unknown,
): Promise<PublishListingResult> {
  if (!actor.agencyId) {
    throw new ListingError('forbidden', 'You do not have permission to publish this listing');
  }

  /**
   * The sale figures, parsed before anything is read or written.
   *
   * Refusing sold details on a non-sale transition matters as much as requiring
   * them on a sale: a caller that passes them to `'withdrawn'` believes it is
   * recording something, and silently dropping them would leave the sale
   * nowhere while the call returned success.
   */
  let details: SoldDetails | undefined;
  if (next === 'sold') {
    const parsed = soldDetailsSchema.safeParse(sold);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ListingError(
        'invalid_draft',
        first?.message ?? 'A sale needs a price and a date',
        typeof first?.path[0] === 'string' ? first.path[0] : undefined,
      );
    }
    details = parsed.data;
  } else if (sold !== undefined) {
    throw new ListingError('invalid_draft', 'Sale details belong to a sale, not to this change');
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

  /**
   * Recording a sale is its own permission.
   *
   * `listing:sell` has the same rule as `listing:publish` today — an agency
   * admin, or the agent named on the listing. It is a separate action because
   * the two are separate decisions: publishing puts an ad on a website and can
   * be undone by withdrawing it, while a sale price becomes a permanent line in
   * the public history of an address and `UNDELETABLE` then refuses to remove
   * the listing carrying it. Tightening one should not mean tightening the
   * other.
   *
   * Both check listing_agent for non-admins, so the actor must have been loaded
   * with its links (loadListingActor, not loadActor).
   */
  const action = next === 'sold' ? 'listing:sell' : 'listing:publish';
  if (!can(actor, action, { type: 'listing', id: listingId, agencyId: target.agencyId })) {
    throw new ListingError(
      'forbidden',
      next === 'sold'
        ? 'You do not have permission to record a sale on this listing'
        : 'You do not have permission to publish this listing',
    );
  }

  const [row] = await db
    .update(listing)
    .set({
      status: next,
      // Stamped once, on the first time it goes live, so "new this week" stays
      // honest across later withdrawals and relistings.
      publishedAt:
        next === 'live' ? sql`coalesce(${listing.publishedAt}, now())` : listing.publishedAt,
      /**
       * One statement, so a sale is never half-recorded.
       *
       * numeric columns take strings — passing a JS number loses precision at
       * scale, the same reason `money()` exists in property-resolver.ts. The
       * non-sale branches leave both columns alone rather than nulling them: a
       * sold listing that is later withdrawn keeps what it sold for, which is
       * what the public timeline and the agency's own record both need.
       */
      ...(details
        ? { soldPrice: details.soldPrice.toFixed(2), soldDate: details.soldDate }
        : {}),
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
