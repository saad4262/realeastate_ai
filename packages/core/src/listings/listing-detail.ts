import { and, asc, desc, eq, exists, gte, inArray, notExists, sql } from 'drizzle-orm';
import {
  agency,
  agentProfile,
  inspection,
  listing,
  listingAgent,
  property,
  user,
  type Db,
} from '@repo/db';
import { formatAddress, type ListingChannel, type ListingStatus } from './listing-schema';

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
  /**
   * The cover photo's storage KEY for this campaign, or null when it had none.
   *
   * A key, not a URL — `mediaUrl()` is the only thing that turns one into the
   * other, which is what keeps the host out of every row. Sub-selected into the
   * same statement rather than fetched per entry: a history of six campaigns
   * would otherwise be six extra round trips, which is the N+1
   * `query-count.test.ts` exists to refuse.
   */
  mainPhotoKey: string | null;
  /** How many photos that campaign had, for the "13" beside the thumbnail. */
  photoCount: number;
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
 * Statuses that mean this property is being sold or rented right now.
 *
 * Deliberately WIDER than `PUBLIC_STATUS`, and that asymmetry is the point.
 * `PUBLIC_STATUS` answers "may a visitor open this ad", which only `live` does.
 * This answers "is this address on the market", which is a bigger question: an
 * `under_offer` listing has no public page at all, so keying off `live` alone
 * would make a property mid-transaction read as off-market — publishing what it
 * last sold for, and inviting a private offer aimed at the agency currently
 * selling it. See docs/adr/0012.
 *
 * `pending` is in neither list. Nothing writes it and no screen offers it, so a
 * pending-only property is simply not reachable.
 */
export const ON_MARKET_STATUSES = ['live', 'under_offer'] as const;

/**
 * How a property's history is ordered, in one place.
 *
 * The sale first when there was one, else the day the ad went up. Nulls last so
 * a listing with neither does not sit above a completed sale.
 *
 * Exported because more than one query has to agree on what "the last sale"
 * means: the timeline puts that row at the top of the page, and
 * `createPrivateOffer` routes an offer to the agency named on it. Two copies of
 * this expression means the email goes to a different agency than the page
 * credits, and nothing would catch it.
 */
export const HISTORY_RANK = sql`coalesce(${listing.soldDate}, ${listing.publishedAt})`;

export const HISTORY_ORDER = [desc(HISTORY_RANK), desc(listing.id)];

/**
 * The same ordering as a SQL fragment, for a statement the query builder cannot
 * express.
 *
 * `createPrivateOffer` is an INSERT ... SELECT, which drizzle's builder will not
 * take an ordered, limited select for — so it is written by hand, and this is
 * what stops the hand-written one from drifting. Both render the same text
 * because both come from `HISTORY_RANK`; only the `ORDER BY` keyword layout
 * differs, and `desc()` is what fixes that too.
 *
 * Note it is `desc` without `NULLS LAST`, which is Postgres's default of NULLS
 * FIRST — the same thing `desc()` above emits. That is a deliberate match rather
 * than an endorsement: `propertyTimeline`'s comment has always claimed nulls
 * last and never asked for it. It cannot bite today, because a live listing is
 * always stamped `published_at` and a sold one now always carries a `sold_date`,
 * so the coalesce has nothing to return null for. Changing it is a separate
 * decision about the timeline, not something to fix in passing here.
 */
export const HISTORY_ORDER_SQL = sql`${HISTORY_RANK} desc, ${listing.id} desc`;

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
      /**
       * `is_main desc` then `sort_order`, the same ordering the search uses: a
       * campaign whose cover was deleted has photos and no main one for as long
       * as the promotion takes to run, and an empty frame mid-delete is worse
       * than the next photo.
       */
      mainPhotoKey: sql<string | null>`(
        select m.storage_key from media m
        where m.listing_id = ${listing.id} and m.kind = 'photo'
        order by m.is_main desc, m.sort_order asc, m.created_at asc
        limit 1
      )`,
      photoCount: sql<number>`(
        select count(*)::int from media m
        where m.listing_id = ${listing.id} and m.kind = 'photo'
      )`,
    })
    .from(listing)
    .innerJoin(agency, eq(agency.id, listing.agencyId))
    .where(
      and(
        eq(listing.propertyId, propertyId),
        inArray(listing.status, [...HISTORIC_STATUSES]),
      ),
    )
    .orderBy(...HISTORY_ORDER);

  return rows.map((r) => ({
    listingId: r.listingId,
    channel: r.channel as ListingChannel,
    status: r.status as ListingStatus,
    priceDisplay: r.priceDisplay,
    soldPrice: r.soldPrice === null ? null : Number(r.soldPrice),
    soldDate: r.soldDate,
    publishedAt: r.publishedAt,
    agencyName: r.agencyName,
    mainPhotoKey: r.mainPhotoKey ?? null,
    // count(*) comes back as a string from the driver on some paths; 0 is a
    // real answer and must not become NaN.
    photoCount: Number(r.photoCount ?? 0) || 0,
  }));
}

/**
 * A property whose history the public may read, and nothing about any ad.
 *
 * The physical place only. There is no price, no headline and no agency here,
 * because there is no current campaign to describe — what a visitor gets is the
 * address, what the dwelling is, and the timeline beside it.
 */
export type OffMarketProperty = {
  id: string;
  address: string;
  suburb: string;
  state: string;
  postcode: string;
  propertyType: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  carSpaces: number | null;
  landAreaSqm: number | null;
  latitude: number | null;
  longitude: number | null;
};

/** numeric and decimal arrive from the driver as strings; 0 is not the same as unknown. */
const num = (v: string | number | null): number | null => {
  if (v === null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * The property behind an off-market page, or null if there should not be one.
 *
 * Two conditions, and both are load-bearing.
 *
 * **Nothing on the market.** This is the requirement: while an address is being
 * sold or rented, what it last sold for is the vendor's business and the
 * selling agency's, not a browser's. `ON_MARKET_STATUSES` rather than
 * `PUBLIC_STATUS` — see the constant for why `under_offer` counts.
 *
 * **At least one listing the public was ever allowed to see.** This is the
 * security of the whole route, and it is easy to leave out because nothing
 * visibly breaks without it. A property row is created by the first agency that
 * drafts an ad against the address, and it outlives every ad (#1). So a
 * property id with nothing but drafts behind it is an agency's unpublished
 * pipeline — an address they are about to list, months before they say so. With
 * no second condition, `/property/<guessed-uuid>` would confirm each one exists
 * and print its address, bedrooms and map pin. `HISTORIC_STATUSES` is imported
 * rather than re-typed so this can never drift from the timeline's own filter.
 *
 * Given the first condition the second can only match a `sold` listing today.
 * The redundancy is deliberate: the day `HISTORIC_STATUSES` changes, this
 * changes with it.
 *
 * One statement. Two correlated EXISTS rather than counting every listing at
 * the address, because both questions are answered by the first matching row.
 */
export async function getOffMarketProperty(
  db: Db,
  propertyId: string,
): Promise<OffMarketProperty | null> {
  const atThisAddress = (statuses: readonly ListingStatus[]) =>
    db
      .select({ one: sql`1` })
      .from(listing)
      .where(
        and(eq(listing.propertyId, property.id), inArray(listing.status, [...statuses])),
      );

  const [row] = await db
    .select({
      id: property.id,
      unit: property.unit,
      streetNumber: property.streetNumber,
      street: property.street,
      suburb: property.suburb,
      state: property.state,
      postcode: property.postcode,
      propertyType: property.propertyType,
      bedrooms: property.bedrooms,
      bathrooms: property.bathrooms,
      carSpaces: property.carSpaces,
      landAreaSqm: property.landAreaSqm,
      latitude: property.latitude,
      longitude: property.longitude,
    })
    .from(property)
    .where(
      and(
        eq(property.id, propertyId),
        notExists(atThisAddress(ON_MARKET_STATUSES)),
        exists(atThisAddress(HISTORIC_STATUSES)),
      ),
    )
    .limit(1);

  if (!row) return null;

  return {
    id: row.id,
    address: formatAddress(row),
    suburb: row.suburb,
    state: row.state,
    postcode: row.postcode,
    propertyType: row.propertyType,
    bedrooms: row.bedrooms,
    bathrooms: num(row.bathrooms),
    carSpaces: row.carSpaces,
    landAreaSqm: num(row.landAreaSqm),
    latitude: num(row.latitude),
    longitude: num(row.longitude),
  };
}

/**
 * The live ad at this address, when there is one.
 *
 * For `/property/<id>` once the address is re-listed: the off-market page stops
 * existing, and a link to it (an old /sold card, a chat history, a shared URL)
 * lands on the listing instead, which carries the same history and whose
 * enquiry reaches the agency selling it now.
 *
 * `live` only, not `ON_MARKET_STATUSES`: an under-offer listing has no public
 * page, so there is nowhere to send anybody and the caller stays a 404. That
 * also means this confirms nothing a visitor could not already see — a live
 * listing is public by definition.
 */
export async function liveListingIdForProperty(
  db: Db,
  propertyId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: listing.id })
    .from(listing)
    .where(and(eq(listing.propertyId, propertyId), eq(listing.status, 'live')))
    .orderBy(desc(listing.publishedAt), desc(listing.id))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Where an old `/listing/<id>` link should go now, or null for a 404.
 *
 * A listing page exists only while the ad is live, but its URL outlives it in
 * bookmarks, shared messages and search results. Once the house has sold — or
 * the ad was pulled — the address still has somewhere to be:
 *
 * - listed again (by anyone) → that live listing, which carries the history;
 * - off the market with a sale on record → `/property/<id>`, the history page;
 * - otherwise → null, and the caller 404s.
 *
 * Only for an id that was once PUBLIC (`sold`, `under_offer`, `withdrawn`).
 * A draft is never followed anywhere: redirecting from it would confirm to
 * somebody guessing ids that an agency has an unpublished ad at that address —
 * the same leak `getOffMarketProperty` guards against.
 *
 * The off-market condition is `getOffMarketProperty`'s own, so this never sends
 * anyone to a page that would then refuse them. One statement.
 */
export async function formerListingDestination(
  db: Db,
  listingId: string,
): Promise<string | null> {
  const rows = await db.execute<{
    property_id: string;
    live_id: string | null;
    off_market: boolean;
  }>(sql`
    select
      l.property_id,
      (select live.id from listing live
        where live.property_id = l.property_id and live.status = 'live'
        order by live.published_at desc nulls last, live.id desc
        limit 1) as live_id,
      (not exists (select 1 from listing m
                   where m.property_id = l.property_id
                     and m.status in ${sql.raw(`(${ON_MARKET_STATUSES.map((x) => `'${x}'`).join(', ')})`)})
       and exists (select 1 from listing h
                   where h.property_id = l.property_id
                     and h.status in ${sql.raw(`(${HISTORIC_STATUSES.map((x) => `'${x}'`).join(', ')})`)})
      ) as off_market
    from listing l
    where l.id = ${listingId}
      and l.status in ('sold', 'under_offer', 'withdrawn')
    limit 1
  `);

  const row = rows[0];
  if (!row) return null;
  if (row.live_id) return `/listing/${row.live_id}`;
  return row.off_market ? `/property/${row.property_id}` : null;
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
