import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import {
  agency,
  agentProfile,
  inspection,
  listing,
  listingAgent,
  user,
  type Db,
} from '@repo/db';
import type { ListingChannel, ListingStatus } from './listing-schema';

/**
 * The three reads behind the parts of a listing page that are not the listing.
 *
 * Each is its own query on purpose rather than a widening of
 * `getPublicListing`: they are one-to-many, and folding them into that select
 * would multiply the listing row by its inspections by its agents and leave
 * the caller to undo it. The page starts all of them together, so the cost is
 * one round trip's latency, not three — and `query-count.test.ts` holds each
 * to its number.
 *
 * Everything here is public and unauthenticated, which is the constraint that
 * shapes all three.
 */

/** A time the property can be walked through. */
export type PublicInspection = {
  id: string;
  startsAt: Date;
  endsAt: Date;
  kind: 'open' | 'private' | 'auction';
};

/**
 * Inspections a visitor can still attend.
 *
 * Past ones are dropped in SQL rather than filtered afterwards: a listing that
 * has been on the market for months has a long tail of them, and none of it is
 * of any use to someone deciding whether to visit on Saturday.
 */
export async function listingInspections(
  db: Db,
  listingId: string,
): Promise<PublicInspection[]> {
  const rows = await db
    .select({
      id: inspection.id,
      startsAt: inspection.startsAt,
      endsAt: inspection.endsAt,
      kind: inspection.kind,
    })
    .from(inspection)
    .where(and(eq(inspection.listingId, listingId), gte(inspection.endsAt, sql`now()`)))
    .orderBy(asc(inspection.startsAt));

  return rows.map((r) => ({ ...r, kind: r.kind as PublicInspection['kind'] }));
}

/** One line of a property's public history. */
export type PublicTimelineEntry = {
  listingId: string;
  channel: ListingChannel;
  status: ListingStatus;
  priceDisplay: string | null;
  soldPrice: number | null;
  soldDate: Date | null;
  publishedAt: Date | null;
  agencyName: string;
};

/**
 * Statuses a member of the public was ever allowed to see.
 *
 * This is the whole security of the timeline. A property outlives its listings
 * (#1), so every ad an agency ever wrote against this address shares its
 * property_id — including the drafts they are working on right now. Selecting
 * by property_id without this filter would publish an agency's unpublished
 * pipeline on the address it belongs to.
 *
 * `withdrawn` is left out as well. It was public once, so it is not a leak,
 * but "listed and pulled" is a claim about why a sale did not happen and this
 * page has no idea. Portals that show it have the context to; this does not.
 */
export const HISTORIC_STATUSES = ['live', 'under_offer', 'sold'] as const;

/**
 * What has happened at this address, newest first.
 *
 * Genuinely derivable rather than invented — which is the reason it exists.
 * The sale prices are `sold_price` as the agency entered it, the dates are
 * `sold_date`, and no figure here is computed, estimated or modelled (#4).
 */
export async function propertyTimeline(
  db: Db,
  propertyId: string,
): Promise<PublicTimelineEntry[]> {
  const rows = await db
    .select({
      listingId: listing.id,
      channel: listing.channel,
      status: listing.status,
      priceDisplay: listing.priceDisplay,
      soldPrice: listing.soldPrice,
      soldDate: listing.soldDate,
      publishedAt: listing.publishedAt,
      agencyName: agency.name,
    })
    .from(listing)
    .innerJoin(agency, eq(agency.id, listing.agencyId))
    .where(
      and(
        eq(listing.propertyId, propertyId),
        inArray(listing.status, [...HISTORIC_STATUSES]),
      ),
    )
    // sold_date first when there is one, else the day it went up. Nulls last so
    // a listing with neither does not sit above a completed sale.
    .orderBy(desc(sql`coalesce(${listing.soldDate}, ${listing.publishedAt})`), desc(listing.id));

  return rows.map((r) => ({
    listingId: r.listingId,
    channel: r.channel as ListingChannel,
    status: r.status as ListingStatus,
    priceDisplay: r.priceDisplay,
    soldPrice: r.soldPrice === null ? null : Number(r.soldPrice),
    soldDate: r.soldDate,
    publishedAt: r.publishedAt,
    agencyName: r.agencyName,
  }));
}

/** An agent as the public listing shows them. */
export type PublicAgentCard = {
  name: string;
  /** From listing_agent, so it is the number that was on this ad. Never null. */
  phone: string;
  role: string;
  /** Only when the agent's profile is marked public. */
  photoUrl: string | null;
  /**
   * An uploaded portrait's storage key, gated the same way.
   *
   * Preferred over photoUrl by the components that render it: an upload is a
   * deliberate act by the agency, while photo_url is a link somebody pasted
   * once and may now be dead.
   */
  photoKey: string | null;
  bio: string | null;
  licenceNumber: string | null;
};

/**
 * Who to call about this listing.
 *
 * Two sources, and which field comes from which is the point.
 *
 * Name and phone come from `listing_agent`'s snapshot columns, not from the
 * user record. That is deliberate in the schema and correct here: the number
 * on an ad should be the number that was on it when it was published. An agent
 * who has since moved agencies does not get their new number printed on an old
 * campaign, and one who changed numbers does not break a live ad.
 *
 * Photo, bio and licence come from `agent_profile` and are gated on its
 * `public` flag — that column exists precisely to answer "may this person's
 * details be shown to the public", and this is the page that has to ask. The
 * join is a LEFT one so an agent with no profile row still appears with their
 * name and number rather than vanishing from their own listing.
 *
 * `snapshotEmail` is deliberately NOT returned. A phone number on a property
 * ad is the convention and the reason the column exists; an email address
 * rendered into a public page is harvested within days. The enquiry form is
 * the route for written contact.
 */
export async function listingAgentCards(
  db: Db,
  listingId: string,
): Promise<PublicAgentCard[]> {
  const rows = await db
    .select({
      name: listingAgent.snapshotName,
      phone: listingAgent.snapshotPhone,
      role: listingAgent.role,
      isPublic: agentProfile.public,
      photoUrl: agentProfile.photoUrl,
      photoKey: agentProfile.photoKey,
      bio: agentProfile.bio,
      licenceNumber: agentProfile.licenceNumber,
    })
    .from(listingAgent)
    .innerJoin(user, eq(user.id, listingAgent.userId))
    .leftJoin(agentProfile, eq(agentProfile.userId, listingAgent.userId))
    .where(eq(listingAgent.listingId, listingId))
    .orderBy(asc(listingAgent.displayOrder));

  return rows.map((r) => {
    const shown = r.isPublic === true;
    return {
      name: r.name,
      phone: r.phone,
      role: r.role as string,
      photoUrl: shown ? r.photoUrl : null,
      photoKey: shown ? r.photoKey : null,
      bio: shown ? r.bio : null,
      licenceNumber: shown ? r.licenceNumber : null,
    };
  });
}
