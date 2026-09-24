import { and, eq, inArray } from 'drizzle-orm';
import { agentProfile, listingAgent, membership, user, type DbOrTx } from '@repo/db';
import { ListingError } from './listing-schema';

/**
 * Point a listing at the people who answer enquiries about it.
 *
 * listing_agent snapshots name, phone and email at the time it is written, on
 * purpose: the ad has to keep showing who to contact after that person changes
 * their number or leaves the agency. Only members of this agency are eligible,
 * which is also what stops an arbitrary user id being attached to a listing.
 *
 * `replace` is what an edit does — the old rows go and these take their place,
 * so removing a co-agent is possible at all.
 */
export async function attachListingAgents(
  tx: DbOrTx,
  agencyId: string,
  listingId: string,
  agentUserIds: string[],
  opts: { replace?: boolean } = {},
): Promise<void> {
  if (!agentUserIds.length) {
    throw new ListingError('invalid_draft', 'A listing needs at least one agent', 'agentUserIds');
  }

  const contacts = await tx
    .select({
      userId: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      displayName: agentProfile.displayName,
    })
    .from(user)
    .innerJoin(membership, eq(membership.userId, user.id))
    .leftJoin(agentProfile, eq(agentProfile.userId, user.id))
    .where(and(eq(membership.agencyId, agencyId), inArray(user.id, agentUserIds)));

  const byId = new Map(contacts.map((c) => [c.userId, c]));

  // Order is the caller's: the first id is the lead, and the display order on
  // the public ad follows it.
  const rows = agentUserIds
    .map((userId, index) => {
      const c = byId.get(userId);
      if (!c) return null;
      return {
        listingId,
        userId,
        role: index === 0 ? ('lead' as const) : ('co' as const),
        displayOrder: index,
        snapshotName: c.displayName || c.name || c.email,
        snapshotPhone: c.phone || '',
        snapshotEmail: c.email,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (!rows.length) {
    throw new ListingError(
      'invalid_draft',
      'None of the selected agents belong to this agency',
      'agentUserIds',
    );
  }

  // Delete first, then insert. Upserting would leave a removed agent in place,
  // which is the whole reason an edit needs this.
  if (opts.replace) {
    await tx.delete(listingAgent).where(eq(listingAgent.listingId, listingId));
  }

  await tx.insert(listingAgent).values(rows);
}
