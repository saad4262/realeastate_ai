import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { listing, property, shortlist, type DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';
import { publicListing } from '../listings/search-listings';

/**
 * The shortlist (ADR 0080, C4 decision 1): homes a signed-in buyer saved, each with a private note. A basic
 * feature, not an AI skill — nothing acts by itself, so it has no switch. The buyer's own, as saved searches and
 * chats are (ADR 0011): `shortlist:read` / `shortlist:manage` are the owner's only, and no agency role reaches
 * them (decision 7). The platform admin console keeps only its count per user.
 */

export const MAX_SHORTLIST = 200;
export const MAX_NOTE = 500;

export class ShortlistError extends Error {
  constructor(
    public readonly code: 'forbidden' | 'not_found' | 'limit' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'ShortlistError';
  }
}

function require(actor: Actor, action: 'shortlist:read' | 'shortlist:manage') {
  if (!can(actor, action, { type: 'shortlist', ownerId: actor.userId })) throw new ShortlistError('forbidden', 'Sign in to save homes.');
}

/**
 * Save a home. Only one the public can see right now (the browser names an id; the server decides). Saving it
 * twice changes nothing; the note survives.
 */
export async function addToShortlist(db: DbOrTx, actor: Actor, listingId: string): Promise<void> {
  require(actor, 'shortlist:manage');
  const [live] = await db.select({ id: listing.id }).from(listing).where(and(eq(listing.id, listingId), publicListing())).limit(1);
  if (!live) throw new ShortlistError('not_found', 'That home is not available.');
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(shortlist).where(eq(shortlist.userId, actor.userId));
  if (Number(n) >= MAX_SHORTLIST) throw new ShortlistError('limit', `Your shortlist holds up to ${MAX_SHORTLIST} homes. Remove one first.`);
  await db.insert(shortlist).values({ userId: actor.userId, listingId }).onConflictDoNothing();
}

/** Remove a home — any home on the list, public or not any more (a buyer can always tidy their own list). */
export async function removeFromShortlist(db: DbOrTx, actor: Actor, listingId: string): Promise<void> {
  require(actor, 'shortlist:manage');
  await db.delete(shortlist).where(and(eq(shortlist.userId, actor.userId), eq(shortlist.listingId, listingId)));
}

export async function setShortlistNote(db: DbOrTx, actor: Actor, listingId: string, note: string): Promise<void> {
  require(actor, 'shortlist:manage');
  const clean = note.replace(/\s+/g, ' ').trim();
  if (clean.length > MAX_NOTE) throw new ShortlistError('invalid', `A note is up to ${MAX_NOTE} characters.`);
  const done = await db
    .update(shortlist)
    .set({ note: clean || null })
    .where(and(eq(shortlist.userId, actor.userId), eq(shortlist.listingId, listingId)))
    .returning({ id: shortlist.listingId });
  if (!done.length) throw new ShortlistError('not_found', 'That home is not on your shortlist.');
}

/** Which of these listings this buyer saved — for the hearts. One read, never more than it is asked about. */
export async function shortlistedAmong(db: DbOrTx, actor: Actor, listingIds: readonly string[]): Promise<Set<string>> {
  require(actor, 'shortlist:read');
  if (!listingIds.length) return new Set();
  const rows = await db
    .select({ id: shortlist.listingId })
    .from(shortlist)
    .where(and(eq(shortlist.userId, actor.userId), inArray(shortlist.listingId, [...new Set(listingIds)].slice(0, MAX_SHORTLIST))));
  return new Set(rows.map((r) => r.id));
}

/** What a saved home is now, in the buyer's terms (decision 3: never "withdrawn", never why). */
export type ShortlistState = 'for_sale' | 'for_rent' | 'under_offer' | 'sold' | 'leased' | 'not_advertised';

export type ShortlistItem = {
  listingId: string;
  note: string | null;
  savedAt: Date;
  address: string;
  suburb: string;
  state: string;
  /** What the home is now, in the buyer's terms. */
  standing: ShortlistState;
  channel: string;
  priceDisplay: string | null;
  priceFrom: number | null;
  priceTo: number | null;
  rentPw: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  carSpaces: number | null;
  /** The listing's latest recorded price change (since migration 0082), when there is one. */
  lastPriceChangeAt: Date | null;
  mainPhotoKey: string | null;
};

/** Pure: a listing's status and visibility in the buyer's terms. Exported for the tests. */
export function shortlistState(status: string, channel: string, isPublic: boolean): ShortlistState {
  if (status === 'sold') return channel === 'rent' ? 'leased' : 'sold';
  if (status === 'leased') return 'leased';
  if (status === 'under_offer') return 'under_offer';
  if (isPublic) return channel === 'rent' ? 'for_rent' : 'for_sale';
  return 'not_advertised';
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** The buyer's shortlist, newest first. One statement: the listing, its address, its cover photo, its last price change. */
export async function listShortlist(db: DbOrTx, actor: Actor): Promise<ShortlistItem[]> {
  require(actor, 'shortlist:read');
  const rows = await db
    .select({
      listingId: shortlist.listingId,
      note: shortlist.note,
      savedAt: shortlist.createdAt,
      address: property.formattedAddress,
      street: sql<string>`concat_ws(' ', ${property.streetNumber}, ${property.street})`,
      suburb: property.suburb,
      state: property.state,
      status: listing.status,
      channel: listing.channel,
      isPublic: sql<boolean>`${publicListing()}`,
      priceDisplay: listing.priceDisplay,
      priceFrom: listing.priceFrom,
      priceTo: listing.priceTo,
      rentPw: listing.rentPw,
      bedrooms: listing.bedrooms,
      bathrooms: listing.bathrooms,
      carSpaces: listing.carSpaces,
      lastPriceChangeAt: sql<Date | null>`(select max(c.changed_at) from listing_price_change c where c.listing_id = shortlist.listing_id)`,
      mainPhotoKey: sql<string | null>`(select m.storage_key from media m where m.listing_id = shortlist.listing_id and m.kind = 'photo' order by m.is_main desc, m.sort_order asc, m.created_at asc limit 1)`,
    })
    .from(shortlist)
    .innerJoin(listing, eq(listing.id, shortlist.listingId))
    .innerJoin(property, eq(property.id, listing.propertyId))
    .where(eq(shortlist.userId, actor.userId))
    .orderBy(desc(shortlist.createdAt), desc(shortlist.listingId));

  return rows.map((r) => ({
    listingId: r.listingId,
    note: r.note,
    savedAt: r.savedAt,
    address: r.street?.trim() ? r.street.trim() : (r.address ?? ''),
    suburb: r.suburb,
    state: r.state,
    standing: shortlistState(r.status, r.channel, Boolean(r.isPublic)),
    channel: r.channel,
    priceDisplay: r.priceDisplay,
    priceFrom: num(r.priceFrom),
    priceTo: num(r.priceTo),
    rentPw: num(r.rentPw),
    bedrooms: r.bedrooms,
    bathrooms: num(r.bathrooms),
    carSpaces: r.carSpaces,
    lastPriceChangeAt: r.lastPriceChangeAt ? new Date(r.lastPriceChangeAt) : null,
    mainPhotoKey: r.mainPhotoKey,
  }));
}
