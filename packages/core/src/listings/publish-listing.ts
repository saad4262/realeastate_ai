import { and, eq, inArray, sql } from 'drizzle-orm';
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
  'draft' | 'pending' | 'live' | 'under_offer' | 'sold' | 'withdrawn'
>;

/**
 * Where a listing may be submitted for approval FROM.
 *
 * Not from live or under offer — that is already public, and "submitting" it
 * would take a live ad down to wait for an approval it already had. Not from
 * sold: a finished campaign is not re-advertised by resubmitting it.
 */
export const SUBMITTABLE_FROM = ['draft', 'withdrawn'] as const;

/**
 * Which permission a transition needs (ADR 0014).
 *
 * - `live` puts content in front of the public: `listing:publish`, admins only.
 * - `pending` asks for that: `listing:submit`, the agent named on it or an admin.
 * - `sold` writes a permanent public figure: `listing:sell`.
 * - everything else takes the ad down or keeps it private (draft, under offer,
 *   withdrawn — including sending a submission back): `listing:edit`.
 */
function actionFor(next: SettableStatus) {
  switch (next) {
    case 'live':
      return 'listing:publish' as const;
    case 'pending':
      return 'listing:submit' as const;
    case 'sold':
      return 'listing:sell' as const;
    default:
      return 'listing:edit' as const;
  }
}

const REFUSAL: Record<ReturnType<typeof actionFor>, string> = {
  'listing:publish': 'Only an agency owner or admin can publish a listing',
  'listing:submit': 'You do not have permission to submit this listing',
  'listing:sell': 'You do not have permission to record a sale on this listing',
  'listing:edit': 'You do not have permission to change this listing',
};

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
 * `'pending'` means submitted for approval (ADR 0014): an agent cannot publish,
 * so they submit, and an owner or admin publishes — or sends it back to draft.
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
    .select({ id: listing.id, agencyId: listing.agencyId, status: listing.status })
    .from(listing)
    .where(eq(listing.id, listingId))
    .limit(1);

  if (!target) throw new ListingError('not_found', 'That listing no longer exists');

  /**
   * One permission per kind of transition — see `actionFor`.
   *
   * `listing:sell` is separate from publish because a sale price becomes a
   * permanent line in the public history of an address and `UNDELETABLE` then
   * refuses to remove the listing carrying it; publish is separate from edit
   * because it is the approval step. Tightening one should not tighten another.
   *
   * All but publish check listing_agent for non-admins, so the actor must have
   * been loaded with its links (loadListingActor, not loadActor).
   */
  const action = actionFor(next);
  if (!can(actor, action, { type: 'listing', id: listingId, agencyId: target.agencyId })) {
    throw new ListingError('forbidden', REFUSAL[action]);
  }

  if (
    next === 'pending' &&
    !(SUBMITTABLE_FROM as readonly string[]).includes(target.status)
  ) {
    throw new ListingError(
      'conflict',
      target.status === 'pending'
        ? 'This listing is already waiting for approval'
        : 'Only a draft or withdrawn listing can be submitted for approval',
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
    .where(
      and(
        eq(listing.id, listingId),
        eq(listing.agencyId, target.agencyId),
        // The submit guard again, in the write: a listing published by an
        // admin a moment ago must not be pulled back to pending by a stale tab.
        next === 'pending' ? inArray(listing.status, [...SUBMITTABLE_FROM]) : undefined,
      ),
    )
    .returning({
      id: listing.id,
      status: listing.status,
      publishedAt: listing.publishedAt,
    });

  if (!row) {
    throw next === 'pending'
      ? new ListingError('conflict', 'This listing changed a moment ago — refresh and try again')
      : new ListingError('not_found', 'That listing no longer exists');
  }

  return {
    listingId: row.id,
    status: row.status as ListingStatus,
    publishedAt: row.publishedAt,
  };
}
