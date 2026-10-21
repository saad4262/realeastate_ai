import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { siteActivity, type DbOrTx } from '@repo/db';
import { PUBLIC_STATUS } from '../listings/search-listings';
import { SUSPENDED_AGENCY_IDS } from '../platform/access';

/**
 * Recording what visitors to the public site search for and open (ADR 0051).
 *
 * The browser says WHAT (a search's filters, or a listing id); the server
 * decides WHO (the verified session, or nobody) and, for a listing, which
 * suburb and agency — from the listing itself, never from the request.
 *
 * Signed in: the row names them and keeps the search's filters. Anonymous: a
 * count — place and channel only, no id, no filters.
 */

const text = (max: number) => z.string().trim().min(1).max(max);

export const siteActivityInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('search'),
    query: z
      .object({
        text: text(200).optional(),
        suburb: text(80).optional(),
        state: text(8).optional(),
        postcode: text(8).optional(),
        channel: z.enum(['sale', 'rent', 'sold', 'leased']).optional(),
        priceFrom: z.number().nonnegative().max(1e9).optional(),
        priceTo: z.number().nonnegative().max(1e9).optional(),
        bedrooms: z.number().int().min(0).max(20).optional(),
        bathrooms: z.number().int().min(0).max(20).optional(),
        carSpaces: z.number().int().min(0).max(20).optional(),
        propertyType: text(40).optional(),
        radiusKm: z.number().positive().max(200).optional(),
        place: text(120).optional(),
      })
      .strip(),
  }),
  z.object({ kind: z.literal('listing_view'), listingId: z.string().uuid() }),
]);

export type SiteActivityInput = z.infer<typeof siteActivityInputSchema>;

/** Record one search or listing view. One statement; a listing that is not public records nothing. */
export async function recordSiteActivity(db: DbOrTx, who: { userId: string | null }, raw: unknown): Promise<boolean> {
  const parsed = siteActivityInputSchema.safeParse(raw);
  if (!parsed.success) return false;
  const input = parsed.data;
  const userId = who.userId;

  if (input.kind === 'search') {
    const q = input.query;
    // A search with no place is still a search; it just counts under "anywhere".
    const suburb = q.suburb ?? q.place ?? null;
    await db.insert(siteActivity).values({
      userId,
      kind: 'search',
      suburb,
      state: q.state ?? null,
      channel: q.channel ?? null,
      query: userId ? q : null,
    });
    return true;
  }

  // The suburb and the agency come from the listing — live and its agency not suspended, or nothing.
  const rows = await db.execute<{ id: string }>(sql`
    insert into site_activity (user_id, kind, suburb, state, channel, listing_id, agency_id)
    select ${userId}::uuid, 'listing_view', p.suburb, p.state, l.channel::text, l.id, l.agency_id
    from listing l join property p on p.id = l.property_id
    where l.id = ${input.listingId} and l.status = ${PUBLIC_STATUS} and l.agency_id not in ${SUSPENDED_AGENCY_IDS}
    returning id`);
  return rows.length > 0;
}
