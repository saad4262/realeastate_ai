import { and, eq } from 'drizzle-orm';
import { listing, membership, type Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import { MediaError } from './storage-client';

/**
 * Who may put an image on what.
 *
 * It lives in packages/core rather than beside the Server Actions because
 * non-negotiable #2 is that authorisation is `can(actor, action, resource)` and
 * nowhere else — and because the actions are two files in apps/console that
 * would otherwise each have their own copy of "look the listing up, compare the
 * agency, decide". One of the two copies is always the one that gets it wrong.
 *
 * The shape of every function here is the same and it is the important part:
 *
 *   the caller supplies an ID
 *   this looks up which agency that ID belongs to
 *   can() compares it against the actor rebuilt from the session
 *
 * The browser never supplies an agency. It cannot — the only thing it is
 * trusted with is naming a listing, and naming the wrong one is a refusal
 * rather than a write somewhere else.
 */

/**
 * Editing a listing's photos is editing the listing.
 *
 * Deliberately NOT a new action in `can()`. A photo is listing content: if you
 * may rewrite the price and the description you may change the pictures, and
 * if you may not, you may not. Adding `listing:media` would have created a
 * permission that every future call site has to remember to check, alongside a
 * permission that means the same thing.
 *
 * Note it is `listing:edit`, not `listing:delete` — a named agent may change
 * the photos on their own campaign. Removing the listing outright stays
 * admin-only for the reason permissions.ts gives: a deleted listing takes its
 * media and enquiries with it.
 */
export async function assertCanEditListingMedia(
  db: Db,
  actor: Actor,
  listingId: string,
): Promise<void> {
  const [row] = await db
    .select({ agencyId: listing.agencyId })
    .from(listing)
    .where(eq(listing.id, listingId))
    .limit(1);

  /**
   * A listing in another agency is "not found", not "not allowed".
   *
   * The same wording as updateListing, and for the same reason: distinguishing
   * the two tells an outsider which listing ids exist.
   */
  if (!row) throw new MediaError('That listing could not be found');

  const allowed = can(actor, 'listing:edit', {
    type: 'listing',
    id: listingId,
    agencyId: row.agencyId,
  });

  if (!allowed) throw new MediaError('That listing could not be found');
}

/**
 * Who may change an agent's portrait.
 *
 * Two answers, both narrow:
 *
 *   - anyone who may manage the team, which is owner|admin. This is the case
 *     the feature was asked for — the agency uploads its agents' headshots.
 *   - the agent themselves, for their own photo, inside their own agency.
 *
 * The second is not a courtesy. Without it an agent cannot replace their own
 * headshot, which means every change goes through an owner, which means the
 * photos go stale. It is still checked against membership rather than taken on
 * trust: a user id matching is not enough on its own, because the actor's
 * agency has to be the agency the target belongs to.
 */
export async function assertCanEditAgentPhoto(
  db: Db,
  actor: Actor,
  agentUserId: string,
): Promise<void> {
  if (!actor.agencyId) throw new MediaError('That agent could not be found');

  // The target's membership OF THE ACTOR'S OWN AGENCY. A user who belongs to
  // two agencies is only visible here through the one the actor is in.
  const [target] = await db
    .select({ userId: membership.userId })
    .from(membership)
    .where(and(eq(membership.userId, agentUserId), eq(membership.agencyId, actor.agencyId)))
    .limit(1);

  if (!target) throw new MediaError('That agent could not be found');

  const managesTeam = can(actor, 'team:manage', {
    type: 'team',
    agencyId: actor.agencyId,
  });
  const isSelf = actor.userId === agentUserId;

  if (!managesTeam && !isSelf) {
    throw new MediaError('You cannot change that agent’s photo');
  }
}
